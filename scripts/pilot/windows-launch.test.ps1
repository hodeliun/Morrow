[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $PackagePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$launcherName = 'windows-launch.ps1'
$launcherSource = Join-Path $PSScriptRoot $launcherName
if (-not (Test-Path -LiteralPath $launcherSource -PathType Leaf)) { throw 'windows-launch.ps1 is missing beside this test.' }
$tokens = $null
$parseErrors = $null
$launcherAst = [System.Management.Automation.Language.Parser]::ParseFile($launcherSource, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw 'The launcher has PowerShell parser errors.' }

$launcherText = Get-Content -LiteralPath $launcherSource -Raw
if ($launcherText -match '\$env\s*:\s*(MORROW_USER_DATA|WEBVIEW2_USER_DATA_FOLDER)\s*=') {
  throw 'The launcher must not change the parent PowerShell environment.'
}
if ($launcherText -notmatch "EnvironmentVariables\['MORROW_USER_DATA'\]" -or $launcherText -notmatch "EnvironmentVariables\['WEBVIEW2_USER_DATA_FOLDER'\]") {
  throw 'The launcher must set both isolation paths through ProcessStartInfo.EnvironmentVariables.'
}

if ($PSVersionTable.PSEdition -eq 'Core') { $enginePath = Join-Path $PSHOME 'pwsh.exe' }
else { $enginePath = Join-Path $PSHOME 'powershell.exe' }
if (-not (Test-Path -LiteralPath $enginePath -PathType Leaf)) { throw 'The current PowerShell host executable could not be located.' }

$script:PilotIdentifier = 'app.morrow.polaris-dados-pilot'
$script:MarkerName = 'MORROW-PILOT-STATE.json'
$script:MarkerOwner = 'Morrow E003 Polaris Dados Windows pilot'
$script:MutexName = 'Local\Morrow-Polaris-Dados-Windows-Pilot'
$functionNodes = $launcherAst.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
if ($functionNodes.Count -eq 0) { throw 'The launcher functions could not be isolated for the no-app state test.' }
foreach ($functionNode in $functionNodes) {
  $functionDefinition = [scriptblock]::Create($functionNode.Extent.Text)
  . $functionDefinition
}

function Copy-StagedPackage([string] $Source, [string] $Destination) {
  New-Item -ItemType Directory -Path $Destination -ErrorAction Stop | Out-Null
  foreach ($entryPath in [IO.Directory]::EnumerateFileSystemEntries($Source)) {
    if (([IO.File]::GetAttributes($entryPath) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'The source package unexpectedly contains a reparse point.' }
    $destinationPath = Join-Path $Destination ([IO.Path]::GetFileName($entryPath))
    Copy-Item -LiteralPath $entryPath -Destination $destinationPath -Recurse -Force
  }
}

function Invoke-CheckOnly([string] $Launcher, [string] $StagedRoot) {
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $enginePath
  $startInfo.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -PackagePath "{1}" -CheckOnly' -f $Launcher, $StagedRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::Start($startInfo)
  if ($null -eq $process) { throw 'Could not start the PowerShell CheckOnly process.' }
  try {
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    return [pscustomobject]@{ ExitCode = $process.ExitCode; StdOut = $stdout.Trim(); StdErr = $stderr.Trim() }
  } finally {
    $process.Dispose()
  }
}

function Assert-CheckOnlyPassed([string] $Label, [string] $Launcher, [string] $StagedRoot, [string] $ExpectedState = 'new') {
  $result = Invoke-CheckOnly $Launcher $StagedRoot
  if ($result.ExitCode -ne 0) { throw "$Label CheckOnly failed: $($result.StdErr)" }
  try { $summary = $result.StdOut | ConvertFrom-Json -ErrorAction Stop }
  catch { throw "$Label CheckOnly did not return its JSON summary." }
  if ($summary.status -ne 'passed' -or $summary.appLaunched -ne $false -or $summary.stateWritten -ne $false -or $summary.packageVerified -ne $true -or $summary.childEnvironmentConfigured -ne $true -or $summary.childEnvironmentPathsArePilotStateChildren -ne $true -or $summary.stateStatus -ne $ExpectedState) {
    throw "$Label CheckOnly returned an unexpected summary."
  }
  if ($ExpectedState -eq 'new' -and (Test-Path -LiteralPath (Join-Path $StagedRoot 'PilotState'))) { throw "$Label CheckOnly wrote PilotState." }
  if ($ExpectedState -eq 'owned' -and -not (Test-Path -LiteralPath (Join-Path $StagedRoot 'PilotState'))) { throw "$Label CheckOnly lost PilotState." }
}

function Assert-CheckOnlyRejected([string] $Label, [string] $Launcher, [string] $StagedRoot) {
  $result = Invoke-CheckOnly $Launcher $StagedRoot
  if ($result.ExitCode -eq 0) { throw "$Label was accepted when it should have been rejected." }
  if (Test-Path -LiteralPath (Join-Path $StagedRoot 'PilotState')) { throw "$Label CheckOnly wrote PilotState before refusing." }
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath().TrimEnd('\')) ('Morrow Pilot ' + [char]0xE9 + 'lan ' + [Guid]::NewGuid().ToString('N'))
$goodRoot = Join-Path $tempRoot 'valid package'
$badPayloadRoot = Join-Path $tempRoot 'changed payload'
$badTemplateRoot = Join-Path $tempRoot 'changed template'
$oldMorrowUserData = [Environment]::GetEnvironmentVariable('MORROW_USER_DATA', 'Process')
$oldWebViewUserData = [Environment]::GetEnvironmentVariable('WEBVIEW2_USER_DATA_FOLDER', 'Process')

try {
  Copy-StagedPackage $PackagePath $goodRoot
  [Environment]::SetEnvironmentVariable('MORROW_USER_DATA', 'WINDOWS-LAUNCH-PARENT-SENTINEL', 'Process')
  [Environment]::SetEnvironmentVariable('WEBVIEW2_USER_DATA_FOLDER', 'WINDOWS-LAUNCH-WEBVIEW-PARENT-SENTINEL', 'Process')
  Assert-CheckOnlyPassed 'Valid Unicode path' (Join-Path $goodRoot $launcherName) $goodRoot
  if ([Environment]::GetEnvironmentVariable('MORROW_USER_DATA', 'Process') -ne 'WINDOWS-LAUNCH-PARENT-SENTINEL' -or [Environment]::GetEnvironmentVariable('WEBVIEW2_USER_DATA_FOLDER', 'Process') -ne 'WINDOWS-LAUNCH-WEBVIEW-PARENT-SENTINEL') {
    throw 'CheckOnly changed the parent process environment.'
  }

  $packageIntegrity = Assert-PackageIntegrity $goodRoot
  $initialState = Initialize-PilotState $goodRoot $packageIntegrity.TemplateHash
  if ($initialState.Status -ne 'owned') { throw 'First-run state initialization did not create a marked state.' }
  if ((Get-TemplateTreeHash $initialState.Paths.DemoVault) -ne $packageIntegrity.TemplateHash) { throw 'The first mutable DemoVault copy differs from the immutable template.' }
  foreach ($stateDirectory in @($initialState.Paths.MorrowUserData, $initialState.Paths.WebView2UserData)) {
    if (-not (Test-Path -LiteralPath $stateDirectory -PathType Container)) { throw 'A first-run runtime directory was not created inside PilotState.' }
  }
  $markerPath = $initialState.Paths.Marker
  $markerHashBeforeEdit = Get-Sha256 $markerPath
  $templateInventoryPath = Join-Path (Join-Path $goodRoot 'DemoVault') 'Inventory.md'
  $mutableInventoryPath = Join-Path $initialState.Paths.DemoVault 'Inventory.md'
  $templateInventoryHash = Get-Sha256 $templateInventoryPath
  [IO.File]::AppendAllText($mutableInventoryPath, "`n<!-- user edit preserved -->`n", [Text.UTF8Encoding]::new($false))
  $mutableInventoryHash = Get-Sha256 $mutableInventoryPath
  if ($mutableInventoryHash -eq $templateInventoryHash) { throw 'The mutable DemoVault edit did not change its file hash.' }

  $reopenedState = Initialize-PilotState $goodRoot $packageIntegrity.TemplateHash
  if ($reopenedState.Status -ne 'owned' -or (Get-Sha256 $mutableInventoryPath) -ne $mutableInventoryHash -or (Get-Sha256 $markerPath) -ne $markerHashBeforeEdit) {
    throw 'A second initialization changed the owned DemoVault edit or marker.'
  }
  if ((Get-TemplateTreeHash (Join-Path $goodRoot 'DemoVault')) -ne $packageIntegrity.TemplateHash -or (Get-Sha256 $templateInventoryPath) -ne $templateInventoryHash) {
    throw 'The immutable DemoVault template changed during state initialization.'
  }
  Assert-CheckOnlyPassed 'Owned state after relaunch' (Join-Path $goodRoot $launcherName) $goodRoot 'owned'
  if ((Get-Sha256 $mutableInventoryPath) -ne $mutableInventoryHash -or (Get-Sha256 $markerPath) -ne $markerHashBeforeEdit) {
    throw 'CheckOnly changed owned state after relaunch.'
  }

  Copy-StagedPackage $PackagePath $badPayloadRoot
  [IO.File]::AppendAllText((Join-Path (Join-Path $badPayloadRoot 'mcp') 'index.js'), "`n// integrity guard probe`n", [Text.UTF8Encoding]::new($false))
  Assert-CheckOnlyRejected 'Changed MCP payload' (Join-Path $badPayloadRoot $launcherName) $badPayloadRoot

  Copy-StagedPackage $PackagePath $badTemplateRoot
  [IO.File]::AppendAllText((Join-Path (Join-Path $badTemplateRoot 'DemoVault') 'Inventory.md'), "`n<!-- integrity guard probe -->`n", [Text.UTF8Encoding]::new($false))
  Assert-CheckOnlyRejected 'Changed DemoVault template' (Join-Path $badTemplateRoot $launcherName) $badTemplateRoot

  Write-Output "Windows launcher parser and CheckOnly guards passed under PowerShell $($PSVersionTable.PSVersion)."
} finally {
  [Environment]::SetEnvironmentVariable('MORROW_USER_DATA', $oldMorrowUserData, 'Process')
  [Environment]::SetEnvironmentVariable('WEBVIEW2_USER_DATA_FOLDER', $oldWebViewUserData, 'Process')
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
