[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $PackagePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$launcherName = 'windows-launch.ps1'
$sourceRoot = [IO.Path]::GetFullPath($PackagePath)
$sourceLauncher = Join-Path $sourceRoot $launcherName
if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) { throw 'PackagePath must name an existing staged package directory.' }
if (-not (Test-Path -LiteralPath $sourceLauncher -PathType Leaf)) { throw 'windows-launch.ps1 is missing beside the staged package.' }
if (Test-Path -LiteralPath (Join-Path $sourceRoot 'PilotState')) { throw 'The immutable staging package must not contain PilotState.' }

$tokens = $null
$parseErrors = $null
$launcherAst = [System.Management.Automation.Language.Parser]::ParseFile($sourceLauncher, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw 'The launcher has PowerShell parser errors.' }

function Get-FunctionAst([object] $RootAst, [string] $Name) {
  $found = @($RootAst.FindAll({
    param($Node)
    $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name
  }, $true))
  if ($found.Count -ne 1) { throw "Expected exactly one launcher helper definition: $Name" }
  return $found[0]
}

function Assert-NoUnsafeProcessStartInHelper([object] $FunctionAst) {
  $helperText = $FunctionAst.Extent.Text
  if ($helperText -match '(?i)\bStart-Process\b|::\s*Start\s*\(') {
    throw 'The extracted environment helper contains a process-start operation.'
  }
  $commands = @($FunctionAst.FindAll({
    param($Node)
    $Node -is [System.Management.Automation.Language.CommandAst] -and $Node.GetCommandName() -eq 'Start-Process'
  }, $true))
  if ($commands.Count -gt 0) { throw 'The extracted environment helper invokes Start-Process.' }
}

function Assert-CheckOnlyLaunchGate([object] $RootAst) {
  $checkOnlyGuards = @($RootAst.FindAll({
    param($Node)
    $Node -is [System.Management.Automation.Language.IfStatementAst] -and
      $Node.Clauses.Count -gt 0 -and $Node.Clauses[0].Item1.Extent.Text -match '\$CheckOnly'
  }, $true))
  if ($checkOnlyGuards.Count -ne 1) { throw 'The launcher must have one explicit CheckOnly branch.' }
  $guard = $checkOnlyGuards[0]
  $exitStatements = @($guard.Clauses[0].Item2.FindAll({
    param($Node)
    $Node -is [System.Management.Automation.Language.ExitStatementAst]
  }, $true))
  if ($exitStatements.Count -eq 0) { throw 'The CheckOnly branch must exit before the normal launch path.' }

  $processStarts = @($RootAst.FindAll({
    param($Node)
    $Node -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and
      $Node.Member.Extent.Text -eq 'Start' -and $Node.Expression.Extent.Text -match 'Process'
  }, $true))
  if ($processStarts.Count -ne 1 -or $processStarts[0].Extent.StartOffset -le $guard.Extent.EndOffset) {
    throw 'The only Process.Start call must occur after the terminating CheckOnly branch.'
  }
}

function Assert-ChildEnvironmentAst([object] $FunctionAst) {
  $environmentAssignments = @($FunctionAst.FindAll({
    param($Node)
    $Node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
      $Node.Left.Extent.Text -match '\.EnvironmentVariables\['
  }, $true))
  $observed = New-Object System.Collections.ArrayList
  foreach ($assignment in $environmentAssignments) {
    $leftText = $assignment.Left.Extent.Text
    if ($leftText -notmatch "\['([^']+)'\]") { throw 'A child environment assignment has a nonliteral key.' }
    $key = $Matches[1]
    if (@($observed | Where-Object { [string]::Equals([string]$_.Key, $key, [StringComparison]::Ordinal) }).Count -gt 0) {
      throw "Duplicate child environment assignment: $key"
    }
    [void]$observed.Add([pscustomobject]@{ Key = $key; Value = $assignment.Right.Extent.Text.Trim() })
  }
  $expected = @{
    MORROW_USER_DATA = '$paths.MorrowUserData'
    WEBVIEW2_USER_DATA_FOLDER = '$paths.WebView2UserData'
  }
  if ($observed.Count -ne $expected.Count) { throw 'The process-start helper changes unexpected child environment variables.' }
  foreach ($key in $expected.Keys) {
    $matchedAssignments = @($observed | Where-Object { [string]::Equals([string]$_.Key, $key, [StringComparison]::Ordinal) })
    if ($matchedAssignments.Count -ne 1 -or -not [string]::Equals([string]$matchedAssignments[0].Value, [string]$expected[$key], [StringComparison]::Ordinal)) {
      throw "The process-start helper does not map $key to its PilotState child path."
    }
  }
  $useShellExecute = @($FunctionAst.FindAll({
    param($Node)
    $Node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
      $Node.Left.Extent.Text -eq '$startInfo.UseShellExecute'
  }, $true))
  if ($useShellExecute.Count -ne 1 -or $useShellExecute[0].Right.Extent.Text.Trim() -ne '$false') {
    throw 'The process-start helper must set UseShellExecute to false.'
  }
}

function Assert-NoReparseTree([string] $Root, [string] $Label) {
  $directories = New-Object System.Collections.Stack
  $directories.Push($Root)
  while ($directories.Count -gt 0) {
    $directory = [string]$directories.Pop()
    foreach ($entryPath in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
      $attributes = [IO.File]::GetAttributes($entryPath)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Label contains a reparse point." }
      if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { $directories.Push($entryPath) }
    }
  }
}

function Copy-TreeContents([string] $Source, [string] $Destination) {
  $sourceRoot = [IO.Path]::GetFullPath($Source).TrimEnd([char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar))
  $destinationRoot = [IO.Path]::GetFullPath($Destination).TrimEnd([char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar))
  [void][IO.Directory]::CreateDirectory($destinationRoot)
  $directories = New-Object System.Collections.Stack
  $directories.Push($sourceRoot)
  while ($directories.Count -gt 0) {
    $sourceDirectory = [string]$directories.Pop()
    $relativeDirectory = if ($sourceDirectory -eq $sourceRoot) { '' } else { $sourceDirectory.Substring($sourceRoot.Length + 1) }
    $destinationDirectory = if ($relativeDirectory.Length -eq 0) { $destinationRoot } else { Join-Path $destinationRoot $relativeDirectory }
    [void][IO.Directory]::CreateDirectory($destinationDirectory)
    foreach ($entryPath in [IO.Directory]::EnumerateFileSystemEntries($sourceDirectory)) {
      $attributes = [IO.File]::GetAttributes($entryPath)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'A test source unexpectedly contains a reparse point.' }
      $name = [IO.Path]::GetFileName($entryPath)
      $destinationPath = Join-Path $destinationDirectory $name
      if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
        [void][IO.Directory]::CreateDirectory($destinationPath)
        $directories.Push($entryPath)
      } else {
        [IO.File]::Copy($entryPath, $destinationPath, $false)
      }
    }
  }
}

function Get-Sha256([string] $Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-TreeSnapshot([string] $Root) {
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return '' }
  $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar))
  $items = New-Object System.Collections.ArrayList
  $directories = New-Object System.Collections.Stack
  $directories.Push($rootPath)
  while ($directories.Count -gt 0) {
    $directory = [string]$directories.Pop()
    foreach ($entryPath in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
      $attributes = [IO.File]::GetAttributes($entryPath)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing to snapshot a tree containing a reparse point.' }
      $relativePath = $entryPath.Substring($rootPath.Length + 1).Replace('\', '/')
      if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
        [void]$items.Add(('D  {0}' -f $relativePath))
        $directories.Push($entryPath)
      } else {
        [void]$items.Add(('F {0}  {1}' -f (Get-Sha256 $entryPath), $relativePath))
      }
    }
  }
  $sorted = @($items | Sort-Object -CaseSensitive)
  return ($sorted -join "`n")
}

function Copy-Package([string] $Source, [string] $Destination) {
  [void][IO.Directory]::CreateDirectory($Destination)
  Copy-TreeContents $Source $Destination
}

function Read-PackageBuildInfo([string] $Root) {
  $path = Join-Path $Root 'BUILD-INFO.json'
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'BUILD-INFO.json is missing from the synthetic test package.' }
  return (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -ErrorAction Stop)
}

function Seed-OwnedState([string] $Root) {
  $stateRoot = Join-Path $Root 'PilotState'
  $demoVault = Join-Path $stateRoot 'DemoVault'
  $markerPath = Join-Path $stateRoot 'MORROW-PILOT-STATE.json'
  $buildInfo = Read-PackageBuildInfo $Root
  $templateHash = [string]$buildInfo.template.sha256
  if ($templateHash -notmatch '^[0-9a-f]{64}$') { throw 'The staged package has no valid DemoVault template digest.' }
  if (Test-Path -LiteralPath $stateRoot) { throw 'A test staging root unexpectedly already has PilotState.' }

  [void][IO.Directory]::CreateDirectory($demoVault)
  Copy-TreeContents (Join-Path $Root 'DemoVault') $demoVault
  [void][IO.Directory]::CreateDirectory((Join-Path $stateRoot 'MorrowUserData'))
  [void][IO.Directory]::CreateDirectory((Join-Path $stateRoot 'WebView2UserData'))
  $marker = [ordered]@{
    schemaVersion = 1
    owner = 'Morrow E003 Polaris Dados Windows pilot'
    pilotIdentifier = 'app.morrow.polaris-dados-pilot'
    stateDirectory = 'PilotState'
    demoVaultRelativePath = 'PilotState/DemoVault'
    templateSha256AtInitialization = $templateHash
    createdAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
  }
  $json = $marker | ConvertTo-Json -Compress -Depth 4
  [IO.File]::WriteAllText($markerPath, $json, [Text.UTF8Encoding]::new($false))
  return [pscustomobject]@{ Root = $stateRoot; DemoVault = $demoVault; Marker = $markerPath }
}

function Get-CurrentPowerShellPath {
  if ($PSVersionTable.PSEdition -eq 'Core') { return (Join-Path $PSHOME 'pwsh.exe') }
  return (Join-Path $PSHOME 'powershell.exe')
}

function Invoke-LauncherCheckOnly([string] $StageRoot, [string] $EnginePath) {
  $launcherPath = Join-Path $StageRoot $launcherName
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $EnginePath
  $startInfo.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -PackagePath "{1}" -CheckOnly' -f $launcherPath, $StageRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  # This starts only a PowerShell host for -CheckOnly; it never starts morrow.exe.
  $process = [System.Diagnostics.Process]::Start($startInfo)
  if ($null -eq $process) { throw 'Could not start the PowerShell CheckOnly host.' }
  try {
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    return [pscustomobject]@{ ExitCode = $process.ExitCode; StdOut = $stdout.Trim(); StdErr = $stderr.Trim() }
  } finally {
    $process.Dispose()
  }
}

function Assert-NoSentinelEcho([object] $Result, [string[]] $Sentinels) {
  $output = [string]$Result.StdOut + "`n" + [string]$Result.StdErr
  foreach ($sentinel in $Sentinels) {
    if (-not [string]::IsNullOrEmpty($sentinel) -and $output.Contains($sentinel)) {
      throw 'CheckOnly exposed a parent environment sentinel in its output.'
    }
  }
}

function Get-CheckOnlySummary([string] $Label, [object] $Result, [string] $ExpectedState) {
  if ($Result.ExitCode -ne 0) { throw "$Label CheckOnly failed unexpectedly." }
  $lines = @($Result.StdOut -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($lines.Count -eq 0) { throw "$Label CheckOnly returned no JSON summary." }
  try { $summary = $lines[$lines.Count - 1] | ConvertFrom-Json -ErrorAction Stop }
  catch { throw "$Label CheckOnly did not end with a JSON summary." }
  if ($summary.status -ne 'passed' -or $summary.appLaunched -ne $false -or $summary.stateWritten -ne $false -or
      $summary.packageVerified -ne $true -or $summary.childEnvironmentConfigured -ne $true -or
      $summary.childEnvironmentPathsArePilotStateChildren -ne $true -or $summary.stateStatus -ne $ExpectedState) {
    throw "$Label CheckOnly returned unexpected status flags."
  }
  return $summary
}

function Assert-CheckOnlyRejected([string] $Label, [string] $StageRoot, [string] $EnginePath) {
  $result = Invoke-LauncherCheckOnly $StageRoot $EnginePath
  if ($result.ExitCode -eq 0) { throw "$Label was accepted when the launcher should refuse it." }
  return $result
}

function Get-MorrowProcessCount {
  return @((Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -ieq 'morrow' })).Count
}

function New-TestJunction([string] $LinkPath, [string] $TargetPath) {
  if ([string]::IsNullOrWhiteSpace($env:ComSpec) -or -not (Test-Path -LiteralPath $env:ComSpec -PathType Leaf)) {
    return [pscustomobject]@{ Created = $false; Reason = 'The command interpreter is unavailable on this runner.' }
  }
  $commandLine = 'mklink /J "{0}" "{1}"' -f $LinkPath, $TargetPath
  $output = & $env:ComSpec /d /c $commandLine 2>&1
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    if (Test-Path -LiteralPath $LinkPath) {
      $attributes = [IO.File]::GetAttributes($LinkPath)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        return [pscustomobject]@{ Created = $true; Reason = 'The runner created a junction despite a nonzero command exit.' }
      }
      throw 'Junction creation returned failure after creating an unexpected path.'
    }
    return [pscustomobject]@{ Created = $false; Reason = 'Runner did not allow creation of a test-owned junction.' }
  }
  $attributes = [IO.File]::GetAttributes($LinkPath)
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { throw 'mklink reported success but the test path is not a reparse point.' }
  return [pscustomobject]@{ Created = $true; Reason = $null }
}

function Remove-TestJunction([string] $LinkPath) {
  if (-not (Test-Path -LiteralPath $LinkPath)) { return }
  $commandLine = 'rmdir "{0}"' -f $LinkPath
  $null = & $env:ComSpec /d /c $commandLine 2>&1
  if ($LASTEXITCODE -ne 0 -or (Test-Path -LiteralPath $LinkPath)) { throw 'Could not remove the test-owned junction without following its target.' }
}

$tempBase = [IO.Path]::GetTempPath()
$tempRoot = Join-Path $tempBase ('Morrow ' + [char]0x00e9 + ' ' + [Guid]::NewGuid().ToString('N'))
$ownedRoot = Join-Path $tempRoot 'owned package'
$collisionRoot = Join-Path $tempRoot 'unmarked collision'
$reparseRoot = Join-Path $tempRoot 'reparse package'
$astRoot = Join-Path $tempRoot 'environment ast package'
$enginePath = Get-CurrentPowerShellPath
$oldMorrowEnvironment = [Environment]::GetEnvironmentVariable('MORROW_USER_DATA', 'Process')
$oldWebViewEnvironment = [Environment]::GetEnvironmentVariable('WEBVIEW2_USER_DATA_FOLDER', 'Process')
$parentSentinelMorrow = 'G12-VALIDATOR-MORROW-' + [Guid]::NewGuid().ToString('N')
$parentSentinelWebView = 'G12-VALIDATOR-WEBVIEW-' + [Guid]::NewGuid().ToString('N')
$globalEnvironmentNames = @('HOME', 'LOCALAPPDATA', 'USERPROFILE')
$globalEnvironmentBefore = @{}
foreach ($name in $globalEnvironmentNames) { $globalEnvironmentBefore[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$junctionsCreated = New-Object System.Collections.ArrayList
$junctionSkipReasons = New-Object System.Collections.ArrayList
$junctionStatus = 'skipped'
$junctionSkippedCount = 0
$junctionCreatedAny = $false
$successSummary = $null
$suiteResults = [ordered]@{
  ownedStateEditPreservedOnRepeatedCheckOnly = 'pending'
  unmarkedCollisionRejectedWithoutMutation = 'pending'
  demoVaultAndRuntimeJunctionsRejected = 'pending'
  childEnvironmentExactPathsAndNoSentinelEcho = 'pending'
  appLaunched = $false
  windowsRuntimeTested = $false
}

try {
  [void][IO.Directory]::CreateDirectory($tempRoot)
  if ($ownedRoot.Length -gt 120 -or $collisionRoot.Length -gt 120 -or $reparseRoot.Length -gt 120) {
    throw 'The runner temp path exceeds the Windows PowerShell 5.1 launcher path limit.'
  }
  $processCountBefore = Get-MorrowProcessCount
  if ($processCountBefore -ne 0) { throw 'A Morrow process is already running on the test runner.' }

  Copy-Package $sourceRoot $ownedRoot
  $ownedState = Seed-OwnedState $ownedRoot
  $mutableEditPath = Join-Path $ownedState.DemoVault 'Inventory.md'
  if (-not (Test-Path -LiteralPath $mutableEditPath -PathType Leaf)) { throw 'The synthetic mutable DemoVault fixture is incomplete.' }
  [IO.File]::AppendAllText($mutableEditPath, "`n<!-- independent ownership preservation probe -->`n", [Text.UTF8Encoding]::new($false))
  $ownedSnapshotBefore = Get-TreeSnapshot $ownedState.Root
  $templateSnapshotBefore = Get-TreeSnapshot (Join-Path $ownedRoot 'DemoVault')

  [Environment]::SetEnvironmentVariable('MORROW_USER_DATA', $parentSentinelMorrow, 'Process')
  [Environment]::SetEnvironmentVariable('WEBVIEW2_USER_DATA_FOLDER', $parentSentinelWebView, 'Process')
  foreach ($pass in 1..2) {
    $ownedResult = Invoke-LauncherCheckOnly $ownedRoot $enginePath
    Assert-NoSentinelEcho $ownedResult @($parentSentinelMorrow, $parentSentinelWebView)
    $null = Get-CheckOnlySummary "Owned state pass $pass" $ownedResult 'owned'
    if ((Get-TreeSnapshot $ownedState.Root) -ne $ownedSnapshotBefore) { throw 'CheckOnly changed the owned PilotState tree or the edited mutable DemoVault.' }
    if ((Get-TreeSnapshot (Join-Path $ownedRoot 'DemoVault')) -ne $templateSnapshotBefore) { throw 'CheckOnly changed the immutable package DemoVault template.' }
  }
  if ([Environment]::GetEnvironmentVariable('MORROW_USER_DATA', 'Process') -ne $parentSentinelMorrow -or
      [Environment]::GetEnvironmentVariable('WEBVIEW2_USER_DATA_FOLDER', 'Process') -ne $parentSentinelWebView) {
    throw 'CheckOnly changed a parent process environment variable.'
  }
  $suiteResults.ownedStateEditPreservedOnRepeatedCheckOnly = 'passed'
  $suiteResults.childEnvironmentExactPathsAndNoSentinelEcho = 'passed'

  Copy-Package $sourceRoot $collisionRoot
  $collisionState = Join-Path $collisionRoot 'PilotState'
  $collisionVault = Join-Path $collisionState 'DemoVault'
  [void][IO.Directory]::CreateDirectory($collisionVault)
  $collisionSentinelPath = Join-Path $collisionVault 'keep-this-state.txt'
  [IO.File]::WriteAllText($collisionSentinelPath, 'synthetic-unowned-state-must-remain', [Text.UTF8Encoding]::new($false))
  $collisionSnapshotBefore = Get-TreeSnapshot $collisionState
  $collisionResult = Assert-CheckOnlyRejected 'Unmarked PilotState collision' $collisionRoot $enginePath
  Assert-NoSentinelEcho $collisionResult @($parentSentinelMorrow, $parentSentinelWebView)
  if ((Test-Path -LiteralPath (Join-Path $collisionState 'MORROW-PILOT-STATE.json')) -or
      (Get-TreeSnapshot $collisionState) -ne $collisionSnapshotBefore) {
    throw 'The launcher modified or claimed an unmarked PilotState collision.'
  }
  $suiteResults.unmarkedCollisionRejectedWithoutMutation = 'passed'

  Copy-Package $sourceRoot $reparseRoot
  $reparseState = Seed-OwnedState $reparseRoot
  $outsideDemoTarget = Join-Path $tempRoot 'junction target demo'
  $outsideWebViewTarget = Join-Path $tempRoot 'junction target webview'
  [void][IO.Directory]::CreateDirectory($outsideDemoTarget)
  [void][IO.Directory]::CreateDirectory($outsideWebViewTarget)
  $outsideDemoSentinel = Join-Path $outsideDemoTarget 'must-remain.txt'
  $outsideWebViewSentinel = Join-Path $outsideWebViewTarget 'must-remain.txt'
  [IO.File]::WriteAllText($outsideDemoSentinel, 'external-demo-target-sentinel', [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($outsideWebViewSentinel, 'external-webview-target-sentinel', [Text.UTF8Encoding]::new($false))

  $junctionCases = @(
    [pscustomobject]@{ Name = 'mutable DemoVault'; Link = (Join-Path $reparseState.DemoVault 'validator-junction'); Target = $outsideDemoTarget; Sentinel = $outsideDemoSentinel },
    [pscustomobject]@{ Name = 'Morrow user data'; Link = (Join-Path (Join-Path $reparseState.Root 'MorrowUserData') 'validator-junction'); Target = $outsideDemoTarget; Sentinel = $outsideDemoSentinel },
    [pscustomobject]@{ Name = 'WebView2 runtime data'; Link = (Join-Path (Join-Path $reparseState.Root 'WebView2UserData') 'validator-junction'); Target = $outsideWebViewTarget; Sentinel = $outsideWebViewSentinel }
  )
  foreach ($junctionCase in $junctionCases) {
    $stateBefore = Get-TreeSnapshot $reparseState.Root
    $markerHashBefore = Get-Sha256 $reparseState.Marker
    $junction = New-TestJunction $junctionCase.Link $junctionCase.Target
    if (-not $junction.Created) {
      $junctionSkippedCount++
      [void]$junctionSkipReasons.Add($junction.Reason)
      continue
    }
    [void]$junctionsCreated.Add($junctionCase.Link)
    $junctionCreatedAny = $true
    $targetHashBefore = Get-Sha256 $junctionCase.Sentinel
    $junctionResult = Assert-CheckOnlyRejected ("Reparse under " + $junctionCase.Name) $reparseRoot $enginePath
    Assert-NoSentinelEcho $junctionResult @($parentSentinelMorrow, $parentSentinelWebView)
    if (-not (Test-Path -LiteralPath $junctionCase.Link) -or (Get-Sha256 $junctionCase.Sentinel) -ne $targetHashBefore -or
        (Get-Sha256 $reparseState.Marker) -ne $markerHashBefore) {
      throw 'The launcher changed an owned state marker, junction, or external test target while refusing a reparse path.'
    }
    Remove-TestJunction $junctionCase.Link
    if ((Get-TreeSnapshot $reparseState.Root) -ne $stateBefore) { throw 'The launcher changed owned state while refusing a reparse path.' }
  }
  if ($junctionCreatedAny) { $junctionStatus = 'passed' }
  if ($junctionSkippedCount -gt 0) { $junctionStatus = if ($junctionCreatedAny) { 'partially-skipped' } else { 'skipped' } }
  $suiteResults.demoVaultAndRuntimeJunctionsRejected = $junctionStatus

  $launcherText = Get-Content -LiteralPath $sourceLauncher -Raw
  if ($launcherText -match '(?i)\$env\s*:\s*(MORROW_USER_DATA|WEBVIEW2_USER_DATA_FOLDER|HOME|LOCALAPPDATA)\s*=') {
    throw 'The launcher assigns an application or profile variable in its own process environment.'
  }
  Assert-CheckOnlyLaunchGate $launcherAst
  $reparseHelperAst = Get-FunctionAst $launcherAst 'Assert-NoReparsePath'
  $processInfoAst = Get-FunctionAst $launcherAst 'New-PilotProcessStartInfo'
  Assert-NoUnsafeProcessStartInHelper $processInfoAst
  Assert-ChildEnvironmentAst $processInfoAst

  # Load only these two helper definitions from the parsed launcher AST; never dot-source its top-level Process.Start path.
  . ([ScriptBlock]::Create($reparseHelperAst.Extent.Text))
  . ([ScriptBlock]::Create($processInfoAst.Extent.Text))
  $astStateRoot = Join-Path $astRoot 'PilotState'
  $astState = [pscustomobject]@{
    Paths = [pscustomobject]@{
      Root = $astStateRoot
      MorrowUserData = Join-Path $astStateRoot 'MorrowUserData'
      WebView2UserData = Join-Path $astStateRoot 'WebView2UserData'
    }
  }
  [void][IO.Directory]::CreateDirectory($astRoot)
  $processStartInfo = New-PilotProcessStartInfo $astRoot $astState
  $expectedMorrowPath = [IO.Path]::GetFullPath((Join-Path $astStateRoot 'MorrowUserData'))
  $expectedWebViewPath = [IO.Path]::GetFullPath((Join-Path $astStateRoot 'WebView2UserData'))
  if ($processStartInfo.UseShellExecute -ne $false -or
      $processStartInfo.EnvironmentVariables['MORROW_USER_DATA'] -ne $expectedMorrowPath -or
      $processStartInfo.EnvironmentVariables['WEBVIEW2_USER_DATA_FOLDER'] -ne $expectedWebViewPath -or
      $processStartInfo.FileName -ne (Join-Path $astRoot 'morrow.exe') -or
      $processStartInfo.WorkingDirectory -ne $astRoot) {
    throw 'New-PilotProcessStartInfo did not construct the exact isolated child configuration.'
  }
  if ([Environment]::GetEnvironmentVariable('MORROW_USER_DATA', 'Process') -ne $parentSentinelMorrow -or
      [Environment]::GetEnvironmentVariable('WEBVIEW2_USER_DATA_FOLDER', 'Process') -ne $parentSentinelWebView) {
    throw 'New-PilotProcessStartInfo changed a parent process environment variable.'
  }
  foreach ($name in $globalEnvironmentNames) {
    if ([Environment]::GetEnvironmentVariable($name, 'Process') -ne $globalEnvironmentBefore[$name]) {
      throw 'A profile environment variable changed during CheckOnly validation.'
    }
  }
  $suiteResults.childEnvironmentExactPathsAndNoSentinelEcho = 'passed'

  if ((Get-MorrowProcessCount) -ne $processCountBefore) { throw 'The CheckOnly probes changed the runner Morrow process count.' }
  $suiteResults.noMorrowProcessStarted = 'passed'
  $suiteResults.junctionProbe = $junctionStatus
  $suiteResults.junctionProbeSkippedCount = $junctionSkippedCount
  $suiteResults.junctionProbeSkipReason = if ($junctionSkipReasons.Count -gt 0) { 'Runner did not permit every test-owned junction.' } else { $null }
  $suiteResults.status = 'passed'
  $suiteResults.suite = 'windows-launch-independent'
  $suiteResults.powerShellVersion = $PSVersionTable.PSVersion.ToString()
  $successSummary = $suiteResults | ConvertTo-Json -Compress -Depth 5
} catch {
  [Console]::Error.WriteLine("Independent Windows launcher checks failed: $($_.Exception.Message)")
  exit 1
} finally {
  $cleanupFailure = $null
  try {
    foreach ($linkPath in $junctionsCreated) {
      if (Test-Path -LiteralPath $linkPath) { Remove-TestJunction ([string]$linkPath) }
    }
    if (Test-Path -LiteralPath $tempRoot) {
      foreach ($linkPath in $junctionsCreated) {
        if (Test-Path -LiteralPath $linkPath) { throw 'A test-owned junction remains; refusing recursive cleanup.' }
      }
      Assert-NoReparseTree $tempRoot 'Test-owned temporary tree'
      Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
  } catch {
    $cleanupFailure = $_.Exception.Message
  } finally {
    foreach ($name in $globalEnvironmentNames) {
      if ([Environment]::GetEnvironmentVariable($name, 'Process') -ne $globalEnvironmentBefore[$name]) {
        [Environment]::SetEnvironmentVariable($name, $globalEnvironmentBefore[$name], 'Process')
      }
    }
    [Environment]::SetEnvironmentVariable('MORROW_USER_DATA', $oldMorrowEnvironment, 'Process')
    [Environment]::SetEnvironmentVariable('WEBVIEW2_USER_DATA_FOLDER', $oldWebViewEnvironment, 'Process')
  }
  if ($null -ne $cleanupFailure) {
    [Console]::Error.WriteLine('Independent Windows launcher fixture cleanup failed; no recursive cleanup was attempted through a remaining junction.')
    exit 1
  }
}

Write-Output $successSummary
