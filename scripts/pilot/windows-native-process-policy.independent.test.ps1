[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateNotNullOrEmpty()]
  [string] $EvidenceRoot,

  [Parameter(Mandatory)]
  [ValidateNotNullOrEmpty()]
  [string] $PolicyPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:Issue = 225
$script:RunStartedUtc = [DateTime]::UtcNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
$script:Checks = [ordered]@{}
$script:Failures = [Collections.Generic.List[string]]::new()
$script:TrackedProcesses = [Collections.Generic.List[object]]::new()
$script:Capsules = [Collections.Generic.List[object]]::new()
$script:CleanupNotes = [Collections.Generic.List[string]]::new()
$script:EvidenceRootFull = $null
$script:RunnerTempFull = $null
$script:RuntimeRoot = $null
$script:RuntimePath = $null
$script:PwshPath = $null
$script:FixturePath = $null
$script:PolicyFullPath = $null
$script:ProcessAdapterPath = $null
$script:JobAdapterPath = $null
$script:EvidencePath = $null
$script:ReceiptPath = $null
$script:PolicySha256 = $null
$script:ProcessAdapterSha256 = $null
$script:JobAdapterSha256 = $null
$script:IndependentSha256 = $null
$script:FixtureSha256 = $null
$script:SourcePwshSha256 = $null
$script:StagedPwshSha256 = $null
$script:RuntimeOwnerMarker = [Guid]::NewGuid().ToString('N')
$script:CaseCounter = 0
$script:EnvironmentCanaryName = 'MORROW_225_PARENT_ONLY_' + [Guid]::NewGuid().ToString('N').ToUpperInvariant()
$script:EnvironmentCanaryValue = [Guid]::NewGuid().ToString('N')
$script:OriginalCanaryValue = $null
$script:CanaryWasSet = $false
$script:Outsider = $null
$script:CaseOutcomes = [Collections.Generic.List[object]]::new()
$script:IdentityReceipts = [Collections.Generic.List[object]]::new()
$script:Utf8NoBom = [Text.UTF8Encoding]::new($false)
$script:FinalReceiptWritten = $false

function Assert-True {
  param(
    [Parameter(Mandatory)][bool] $Condition,
    [Parameter(Mandatory)][string] $Message
  )
  if (-not $Condition) { throw $Message }
}

function Assert-Equal {
  param(
    [Parameter(Mandatory)] $Actual,
    [Parameter(Mandatory)] $Expected,
    [Parameter(Mandatory)][string] $Message,
    [switch] $IgnoreCase
  )

  if ($Expected -is [string]) {
    $comparison = if ($IgnoreCase) {
      [string]::Compare([string]$Actual, [string]$Expected, [StringComparison]::OrdinalIgnoreCase)
    } else {
      [string]::CompareOrdinal([string]$Actual, [string]$Expected)
    }
    if ($comparison -ne 0) { throw $Message }
  } elseif ($Actual -ne $Expected) {
    throw $Message
  }
}

function Test-PathExists {
  param([Parameter(Mandatory)][string] $Path)
  return [IO.File]::Exists($Path) -or [IO.Directory]::Exists($Path)
}

function Get-CanonicalFullPath {
  param([Parameter(Mandatory)][string] $Path)
  if ([string]::IsNullOrWhiteSpace($Path) -or $Path.Contains([char]0) -or $Path.Contains('/')) {
    throw 'A test path is empty or not normalized for Windows.'
  }
  if ($Path.StartsWith('\\') -or $Path.StartsWith('\\?\') -or $Path.StartsWith('\\.\') -or $Path -notmatch '^[A-Za-z]:\\') {
    throw 'A test path must use a local Windows drive.'
  }
  $full = [IO.Path]::GetFullPath($Path)
  $trimFull = $full.TrimEnd([char[]]@('\', '/'))
  $trimPath = $Path.TrimEnd([char[]]@('\', '/'))
  if (-not [string]::Equals($trimFull, $trimPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'A test path is not canonical.'
  }
  foreach ($segment in $full.Substring([IO.Path]::GetPathRoot($full).Length).Split([char[]]@('\'), [StringSplitOptions]::RemoveEmptyEntries)) {
    if ($segment.Contains(':') -or $segment -eq '.' -or $segment -eq '..' -or $segment.EndsWith('.') -or $segment.EndsWith(' ')) {
      throw 'A test path contains an ambiguous Windows path component.'
    }
  }
  return $trimFull
}

function Assert-NoReparseSegments {
  param([Parameter(Mandatory)][string] $Path)

  $full = Get-CanonicalFullPath -Path $Path
  $root = [IO.Path]::GetPathRoot($full)
  if ([string]::IsNullOrWhiteSpace($root)) { throw 'A test path has no drive root.' }
  $current = $root
  $remaining = $full.Substring($root.Length)
  foreach ($segment in $remaining.Split([char[]]@('\'), [StringSplitOptions]::RemoveEmptyEntries)) {
    $current = [IO.Path]::Combine($current, $segment)
    if (Test-PathExists -Path $current) {
      $attributes = [IO.File]::GetAttributes($current)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'A test path crosses a reparse point.'
      }
    }
  }
  return $full
}

function Assert-StrictChildPath {
  param(
    [Parameter(Mandatory)][string] $Path,
    [Parameter(Mandatory)][string] $Root,
    [Parameter(Mandatory)][string] $Message
  )

  $full = Get-CanonicalFullPath -Path $Path
  $rootFull = Get-CanonicalFullPath -Path $Root
  $relative = [IO.Path]::GetRelativePath($rootFull, $full)
  if ([string]::IsNullOrWhiteSpace($relative) -or $relative -eq '.' -or [IO.Path]::IsPathRooted($relative) -or
      $relative -eq '..' -or $relative.StartsWith('..' + [IO.Path]::DirectorySeparatorChar, [StringComparison]::Ordinal) -or
      $relative.StartsWith('../', [StringComparison]::Ordinal)) {
    throw $Message
  }
  [void](Assert-NoReparseSegments -Path $full)
  return $full
}

function New-OrderedMap {
  return ,([Collections.Specialized.OrderedDictionary]::new([StringComparer]::Ordinal))
}

function Copy-OrderedMap {
  param([Parameter(Mandatory)][System.Collections.IDictionary] $Source)
  $copy = New-OrderedMap
  foreach ($key in $Source.Keys) { $copy.Add([string]$key, $Source[$key]) }
  return ,$copy
}

function Write-JsonAtomically {
  param(
    [Parameter(Mandatory)][string] $Path,
    [Parameter(Mandatory)] $Value
  )
  $temporaryPath = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  $json = ConvertTo-Json -InputObject $Value -Depth 20 -Compress
  [IO.File]::WriteAllText($temporaryPath, $json, $script:Utf8NoBom)
  [IO.File]::Move($temporaryPath, $Path)
}

function Read-JsonFile {
  param([Parameter(Mandatory)][string] $Path)
  return ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Path)) -AsHashtable -Depth 20
}

function Get-SafeMessage {
  param([Parameter(Mandatory)][Exception] $Exception)
  $message = [string]$Exception.Message
  foreach ($sensitivePath in @(
      $script:EvidenceRootFull,
      $script:RunnerTempFull,
      $script:RuntimeRoot,
      $script:RuntimePath,
      $script:PwshPath,
      $script:PolicyFullPath,
      $PSHOME,
      $env:USERPROFILE
    )) {
    if (-not [string]::IsNullOrWhiteSpace([string]$sensitivePath)) {
      $message = [regex]::Replace($message, [regex]::Escape([string]$sensitivePath), '<PRIVATE_PATH>', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    }
  }
  $message = [regex]::Replace(
    $message,
    '(?i)\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,})',
    '<REDACTED_SECRET>'
  )
  $message = [regex]::Replace($message, '[\r\n\t]+', ' ')
  $message = [regex]::Replace($message, '[^\x20-\x7E]', '?').Trim()
  if ($message.Length -gt 240) { $message = $message.Substring(0, 240) }
  return $message
}

function Add-Check {
  param(
    [Parameter(Mandatory)][string] $Name,
    [Parameter(Mandatory)][scriptblock] $Action
  )
  try {
    $detail = & $Action
    $script:Checks[$Name] = [ordered]@{ status = 'passed'; detail = $detail }
    [Console]::Out.WriteLine(('PASS {0}' -f $Name))
  } catch {
    $safeMessage = Get-SafeMessage -Exception $_.Exception
    $script:Checks[$Name] = [ordered]@{ status = 'failed'; message = $safeMessage }
    $script:Failures.Add($Name)
    [Console]::Error.WriteLine(('FAIL {0}: {1}' -f $Name, $safeMessage))
  }
}

function Get-PolicyErrorId {
  param([Parameter(Mandatory)][System.Management.Automation.ErrorRecord] $ErrorRecord)
  $raw = [string]$ErrorRecord.FullyQualifiedErrorId
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  return ($raw -split ',', 2)[0]
}

function Get-PolicyDiagnostics {
  param([Parameter(Mandatory)][System.Management.Automation.ErrorRecord] $ErrorRecord)
  $current = $ErrorRecord.Exception
  for ($depth = 0; $null -ne $current -and $depth -lt 8; $depth++) {
    if ($current.Data.Contains('Morrow.WindowsNativeProcess.Diagnostics')) {
      return ,$current.Data['Morrow.WindowsNativeProcess.Diagnostics']
    }
    $current = $current.InnerException
  }
  return $null
}

function Invoke-ExpectedPolicyFailure {
  param(
    [Parameter(Mandatory)][AllowNull()][object] $Descriptor,
    [Parameter(Mandatory)][string] $ExpectedErrorId,
    [string] $ExpectedStage,
    [switch] $ExpectCompleteCleanup,
    [string] $ExpectedField
  )

  $caught = $null
  $result = $null
  try {
    $result = Start-WindowsNativeProcess -Descriptor $Descriptor
  } catch {
    $caught = $_
  }
  if ($null -eq $caught) {
    if ($null -ne $result -and $result -is [Morrow.Pilot.WindowsNativeProcessCapsule]) {
      try { $null = $result.Dispose() } catch { throw 'An unexpectedly accepted descriptor also failed capsule cleanup.' }
    }
    throw 'The policy unexpectedly returned a capsule.'
  }

  $errorId = Get-PolicyErrorId -ErrorRecord $caught
  Assert-Equal -Actual $errorId -Expected $ExpectedErrorId -Message 'The policy returned an unexpected namespaced error ID.'
  $diagnostics = Get-PolicyDiagnostics -ErrorRecord $caught
  if ($null -eq $diagnostics) { throw 'The policy error did not include its sanitized diagnostics DTO.' }
  if ($ExpectedStage) {
    Assert-Equal -Actual ([string]$diagnostics.stage) -Expected $ExpectedStage -Message 'The policy error diagnostics reported an unexpected stage.'
  }
  $diagnosticFields = @()
  $cleanupDiagnostic = $null
  if ($diagnostics -is [System.Collections.IDictionary]) {
    if ($diagnostics.Contains('fields')) { $diagnosticFields = @($diagnostics['fields']) }
    if ($diagnostics.Contains('cleanup')) { $cleanupDiagnostic = $diagnostics['cleanup'] }
  } elseif ($diagnostics.PSObject.Properties['fields'] -or $diagnostics.PSObject.Properties['cleanup']) {
    if ($diagnostics.PSObject.Properties['fields']) { $diagnosticFields = @($diagnostics.fields) }
    if ($diagnostics.PSObject.Properties['cleanup']) { $cleanupDiagnostic = $diagnostics.cleanup }
  }
  if ($ExpectedField -and $diagnosticFields -notcontains $ExpectedField) { throw 'The policy error diagnostics omitted the expected invalid field.' }
  if ($ExpectCompleteCleanup) {
    if ($null -eq $cleanupDiagnostic) { throw 'A post-create failure omitted cleanup diagnostics.' }
    Assert-True -Condition ([bool]$cleanupDiagnostic.attempted) -Message 'A post-create failure did not report that cleanup was attempted.'
    Assert-True -Condition ([bool]$cleanupDiagnostic.jobEmpty) -Message 'A post-create failure did not prove the owned Job empty.'
    Assert-True -Condition ([bool]$cleanupDiagnostic.rootExited) -Message 'A post-create failure did not prove the root exited.'
  }
  return $diagnostics
}

function New-CaseRoot {
  param([Parameter(Mandatory)][string] $Name)
  $script:CaseCounter++
  $leaf = '{0}-{1}-{2}' -f $Name, $script:CaseCounter, [Guid]::NewGuid().ToString('N')
  $path = Join-Path $script:EvidenceRootFull (Join-Path 'cases' $leaf)
  [void](Assert-StrictChildPath -Path $path -Root $script:RunnerTempFull -Message 'A case directory escaped RUNNER_TEMP.')
  [void][IO.Directory]::CreateDirectory($path)
  [IO.File]::WriteAllText((Join-Path $path '.issue-225-independent-owner'), [Guid]::NewGuid().ToString('N'), $script:Utf8NoBom)
  return $path
}

function New-PrivateProfile {
  param([Parameter(Mandatory)][string] $CaseRoot)
  $profile = Join-Path $CaseRoot 'profile'
  $paths = [ordered]@{
    USERPROFILE = $profile
    HOME = $profile
    APPDATA = Join-Path $profile 'appdata'
    LOCALAPPDATA = Join-Path $profile 'local'
    TEMP = Join-Path $profile 'temp'
    TMP = Join-Path $profile 'tmp'
  }
  foreach ($path in $paths.Values) { [void][IO.Directory]::CreateDirectory([string]$path) }
  [void](Assert-StrictChildPath -Path $profile -Root $CaseRoot -Message 'The profile escaped its case directory.')
  foreach ($name in @('APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP')) {
    [void](Assert-StrictChildPath -Path ([string]$paths[$name]) -Root $profile -Message 'A profile environment directory escaped the private profile.')
  }
  return ,$paths
}

function New-ExplicitEnvironment {
  param(
    [Parameter(Mandatory)][string] $ProfilePath,
    [Parameter(Mandatory)][System.Collections.IDictionary] $ProfileEnvironment
  )
  $systemRoot = [Environment]::GetEnvironmentVariable('SystemRoot', [EnvironmentVariableTarget]::Process)
  if ([string]::IsNullOrWhiteSpace($systemRoot) -or -not [IO.Directory]::Exists($systemRoot)) {
    throw 'SystemRoot is required for a real Windows native process fixture.'
  }
  $system32 = Join-Path $systemRoot 'System32'
  $values = New-OrderedMap
  $values.Add('SYSTEMROOT', $systemRoot)
  $values.Add('WINDIR', $systemRoot)
  $values.Add('PATH', $system32 + ';' + $script:RuntimePath)
  $values.Add('USERPROFILE', [string]$ProfileEnvironment.USERPROFILE)
  $values.Add('APPDATA', [string]$ProfileEnvironment.APPDATA)
  $values.Add('LOCALAPPDATA', [string]$ProfileEnvironment.LOCALAPPDATA)
  $values.Add('TEMP', [string]$ProfileEnvironment.TEMP)
  $values.Add('TMP', [string]$ProfileEnvironment.TMP)
  $values.Add('HOME', [string]$ProfilePath)
  return ,$values
}

function New-ValidDescriptor {
  param(
    [Parameter(Mandatory)][string] $CaseRoot,
    [Parameter(Mandatory)][string[]] $ArgumentList,
    [Parameter(Mandatory)][int] $ExpectedParentProcessId,
    [Parameter(Mandatory)][string] $ExpectedOwnerSid
  )
  $profile = New-PrivateProfile -CaseRoot $CaseRoot
  $descriptor = New-OrderedMap
  $descriptor.Add('executablePath', $script:PwshPath)
  $descriptor.Add('executableSha256', $script:StagedPwshSha256)
  $list = [Collections.Generic.List[string]]::new()
  foreach ($argument in $ArgumentList) { [void]$list.Add([string]$argument) }
  $descriptor.Add('argumentList', $list)
  $descriptor.Add('workingDirectory', $CaseRoot)
  $descriptor.Add('profilePath', [string]$profile.USERPROFILE)
  $descriptor.Add('environment', (New-ExplicitEnvironment -ProfilePath ([string]$profile.USERPROFILE) -ProfileEnvironment $profile))
  $descriptor.Add('expectedParentProcessId', $ExpectedParentProcessId)
  $descriptor.Add('expectedOwnerSid', $ExpectedOwnerSid)
  return ,$descriptor
}

function Copy-DescriptorWithMutation {
  param(
    [Parameter(Mandatory)][System.Collections.IDictionary] $Descriptor,
    [Parameter(Mandatory)][scriptblock] $Mutation
  )
  $copy = Copy-OrderedMap -Source $Descriptor
  if ($Descriptor.Contains('environment') -and $Descriptor['environment'] -is [System.Collections.IDictionary]) {
    $copy['environment'] = Copy-OrderedMap -Source $Descriptor['environment']
  }
  if ($Descriptor.Contains('argumentList') -and $Descriptor['argumentList'] -is [System.Collections.IList] -and
      $Descriptor['argumentList'] -isnot [string]) {
    $argumentCopy = [Collections.ArrayList]::new()
    foreach ($item in $Descriptor['argumentList']) { [void]$argumentCopy.Add($item) }
    $copy['argumentList'] = $argumentCopy
  }
  $null = & $Mutation $copy
  return ,$copy
}

function Get-Sha256 {
  param([Parameter(Mandatory)][string] $Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
}

function Write-FixtureScript {
  param([Parameter(Mandatory)][string] $Path)

  $source = @'
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string] $ReceiptPath,
  [Parameter(Mandatory)][string] $MarkerPath,
  [Parameter(Mandatory)][string] $OwnershipMarker,
  [Parameter(Mandatory)][string] $SpaceValue,
  [Parameter(Mandatory)][string] $UnicodeValue,
  [Parameter(Mandatory)][string] $ExpectedSystemRoot,
  [Parameter(Mandatory)][string] $ExpectedPath,
  [Parameter(Mandatory)][string] $ExpectedUserProfile,
  [Parameter(Mandatory)][string] $ExpectedHome,
  [Parameter(Mandatory)][string] $ExpectedAppData,
  [Parameter(Mandatory)][string] $ExpectedLocalAppData,
  [Parameter(Mandatory)][string] $ExpectedTemp,
  [Parameter(Mandatory)][string] $ExpectedTmp,
  [Parameter(Mandatory)][string] $ParentOnlyVariable
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$names = @([Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::Process).Keys | ForEach-Object { [string]$_ })
$githubNames = @($names | Where-Object { $_ -match '^(?i:GITHUB_)' })
$actionsNames = @($names | Where-Object { $_ -match '^(?i:ACTIONS_)' })
$processRows = @(Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = {0}' -f $PID) -ErrorAction Stop)
$commandLine = if ($processRows.Count -eq 1) { [string]$processRows[0].CommandLine } else { '' }
$receipt = [ordered]@{
  schemaVersion = 1
  processId = [int]$PID
  argumentSpacePreserved = ($SpaceValue -ceq 'issue225 argument with spaces')
  argumentUnicodePreserved = ($UnicodeValue -ceq 'issue225-á漢')
  systemRootMatches = ([string]$env:SYSTEMROOT -ceq $ExpectedSystemRoot)
  windirMatches = ([string]$env:WINDIR -ceq $ExpectedSystemRoot)
  pathMatches = ([string]$env:PATH -ceq $ExpectedPath)
  userProfileMatches = ([string]$env:USERPROFILE -ceq $ExpectedUserProfile)
  homeMatches = ([string]$env:HOME -ceq $ExpectedHome)
  appDataMatches = ([string]$env:APPDATA -ceq $ExpectedAppData)
  localAppDataMatches = ([string]$env:LOCALAPPDATA -ceq $ExpectedLocalAppData)
  tempMatches = ([string]$env:TEMP -ceq $ExpectedTemp)
  tmpMatches = ([string]$env:TMP -ceq $ExpectedTmp)
  githubVariableNamesAbsent = ($githubNames.Count -eq 0)
  actionsVariableNamesAbsent = ($actionsNames.Count -eq 0)
  githubTokenAbsent = ($names -notcontains 'GITHUB_TOKEN')
  parentOnlyCanaryAbsent = ($names -notcontains $ParentOnlyVariable)
  ownerMarkerSeenInCommandLine = $commandLine.Contains($OwnershipMarker)
}
$json = ConvertTo-Json -InputObject $receipt -Depth 8 -Compress
$tempPath = $ReceiptPath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
[IO.File]::WriteAllText($tempPath, $json, [Text.UTF8Encoding]::new($false))
[IO.File]::Move($tempPath, $ReceiptPath)
[IO.File]::WriteAllText($MarkerPath, $OwnershipMarker, [Text.UTF8Encoding]::new($false))
$deadline = [DateTime]::UtcNow.AddMinutes(2)
while ([DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
'@
  [IO.File]::WriteAllText($Path, $source, $script:Utf8NoBom)
}

function New-ProcessStartInfo {
  param(
    [Parameter(Mandatory)][string] $ExecutablePath,
    [Parameter(Mandatory)][string[]] $ArgumentList,
    [Parameter(Mandatory)][string] $WorkingDirectory,
    [Parameter(Mandatory)][System.Collections.IDictionary] $Environment
  )
  $psi = [Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $ExecutablePath
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.Environment.Clear()
  foreach ($key in $Environment.Keys) { $psi.Environment[[string]$key] = [string]$Environment[$key] }
  foreach ($argument in $ArgumentList) { [void]$psi.ArgumentList.Add([string]$argument) }
  return $psi
}

function Start-ObservedTestProcess {
  param(
    [Parameter(Mandatory)][string] $Role,
    [Parameter(Mandatory)][string] $ExecutablePath,
    [Parameter(Mandatory)][string[]] $ArgumentList,
    [Parameter(Mandatory)][string] $WorkingDirectory,
    [Parameter(Mandatory)][System.Collections.IDictionary] $Environment
  )
  $psi = New-ProcessStartInfo -ExecutablePath $ExecutablePath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory -Environment $Environment
  $process = [Diagnostics.Process]::Start($psi)
  if ($null -eq $process) { throw 'The independent test process could not be started.' }
  $image = [IO.Path]::GetFullPath($process.MainModule.FileName)
  if (-not [string]::Equals($image, [IO.Path]::GetFullPath($ExecutablePath), [StringComparison]::OrdinalIgnoreCase)) {
    try { $process.Kill(); [void]$process.WaitForExit(5000) } catch { }
    $process.Dispose()
    throw 'A test process image did not match the staged executable.'
  }
  $record = [pscustomobject]@{
    role = $Role
    process = $process
    processId = [int]$process.Id
    imagePath = $image
    creationTimeUtc = $process.StartTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    exitCode = $null
    hasExited = $false
    emergencyCleanup = $false
  }
  [void]$script:TrackedProcesses.Add($record)
  return $record
}

function Wait-ForFile {
  param(
    [Parameter(Mandatory)][string] $Path,
    [Parameter(Mandatory)][int] $TimeoutMs,
    [Parameter(Mandatory)][string] $Description
  )
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while ($watch.ElapsedMilliseconds -lt $TimeoutMs) {
    if ([IO.File]::Exists($Path)) { return }
    Start-Sleep -Milliseconds 25
  }
  throw "Timed out waiting for $Description."
}

function Assert-ReceiptBooleanFields {
  param([Parameter(Mandatory)][System.Collections.IDictionary] $Receipt)
  foreach ($field in @(
      'argumentSpacePreserved', 'argumentUnicodePreserved',
      'systemRootMatches', 'windirMatches', 'pathMatches', 'userProfileMatches', 'homeMatches',
      'appDataMatches', 'localAppDataMatches', 'tempMatches', 'tmpMatches',
      'githubVariableNamesAbsent', 'actionsVariableNamesAbsent', 'githubTokenAbsent',
      'parentOnlyCanaryAbsent', 'ownerMarkerSeenInCommandLine'
    )) {
    Assert-True -Condition ([bool]$Receipt[$field]) -Message ("The fixture receipt failed field {0}." -f $field)
  }
}

function Get-ProcessIdentityRecord {
  param([Parameter(Mandatory)][int] $ProcessId)
  return Get-WindowsProcessOwnershipIdentity -ProcessId $ProcessId
}

function Assert-CimIdentityMatchesDescriptor {
  param(
    [Parameter(Mandatory)][psobject] $Identity,
    [Parameter(Mandatory)][System.Collections.IDictionary] $Descriptor,
    [Parameter(Mandatory)][int] $ReceiptProcessId
  )
  Assert-Equal -Actual ([int]$Identity.processId) -Expected $ReceiptProcessId -Message 'CIM processId differed from the fixture receipt.'
  Assert-Equal -Actual ([int]$Identity.parentProcessId) -Expected ([int]$Descriptor.expectedParentProcessId) -Message 'CIM parentProcessId differed from the expected parent.'
  Assert-Equal -Actual ([string]$Identity.executablePath) -Expected ([IO.Path]::GetFullPath([string]$Descriptor.executablePath)) -IgnoreCase -Message 'CIM executablePath differed from the staged executable.'
  Assert-Equal -Actual ([string]$Identity.executableSha256).ToLowerInvariant() -Expected ([string]$Descriptor.executableSha256).ToLowerInvariant() -Message 'CIM executableSha256 differed from the descriptor.'
  Assert-Equal -Actual ([string]$Identity.ownerSid) -Expected ([string]$Descriptor.expectedOwnerSid) -Message 'CIM ownerSid differed from the expected runner SID.'

  $cimTime = [DateTime]::Parse([string]$Identity.creationTimeUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
  $process = [Diagnostics.Process]::GetProcessById([int]$Identity.processId)
  try {
    $handle = $process.Handle
    $handleTime = $process.StartTime.ToUniversalTime()
    if ([Math]::Abs(($cimTime - $handleTime).Ticks) -gt 20) {
      throw 'The CIM creationTimeUtc differed from the retained process-handle timestamp by more than 20 ticks.'
    }
    $identityRecord = [ordered]@{
      role = 'start-positive-root'
      processId = [int]$Identity.processId
      parentProcessId = [int]$Identity.parentProcessId
      creationTimeUtc = $cimTime.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
      executableName = [IO.Path]::GetFileName([string]$Identity.executablePath)
      executableSha256 = [string]$Identity.executableSha256
      ownerSid = [string]$Identity.ownerSid
      handleTimeDeltaTicks = [Math]::Abs(($cimTime - $handleTime).Ticks)
    }
    [void]$script:IdentityReceipts.Add($identityRecord)
  } finally {
    $process.Dispose()
  }
}

function Wait-ForFixtureReceipt {
  param(
    [Parameter(Mandatory)][string] $ReceiptPath,
    [Parameter(Mandatory)][string] $MarkerPath,
    [Parameter(Mandatory)][int] $TimeoutMs
  )
  Wait-ForFile -Path $ReceiptPath -TimeoutMs $TimeoutMs -Description 'the synthetic fixture receipt'
  Wait-ForFile -Path $MarkerPath -TimeoutMs $TimeoutMs -Description 'the post-authorization marker'
  return Read-JsonFile -Path $ReceiptPath
}

function Get-NewFixtureArguments {
  param(
    [Parameter(Mandatory)][string] $CaseRoot,
    [Parameter(Mandatory)][string] $Role
  )
  $marker = [Guid]::NewGuid().ToString('N')
  $receipt = Join-Path $CaseRoot ($Role + '.receipt.json')
  $markerPath = Join-Path $CaseRoot ($Role + '.entry.marker')
  $argumentList = [Collections.Generic.List[string]]::new()
  foreach ($argument in @(
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', $script:FixturePath,
      '-ReceiptPath', $receipt,
      '-MarkerPath', $markerPath,
      '-OwnershipMarker', ('morrow-g13-synthetic-owner=' + $marker),
      '-SpaceValue', 'issue225 argument with spaces',
      '-UnicodeValue', 'issue225-á漢',
      '-ExpectedSystemRoot', [Environment]::GetEnvironmentVariable('SystemRoot', [EnvironmentVariableTarget]::Process),
      '-ExpectedPath', ((Join-Path ([Environment]::GetEnvironmentVariable('SystemRoot', [EnvironmentVariableTarget]::Process)) 'System32') + ';' + $script:RuntimePath),
      '-ExpectedUserProfile', (Join-Path $CaseRoot 'profile'),
      '-ExpectedHome', (Join-Path $CaseRoot 'profile'),
      '-ExpectedAppData', (Join-Path (Join-Path $CaseRoot 'profile') 'appdata'),
      '-ExpectedLocalAppData', (Join-Path (Join-Path $CaseRoot 'profile') 'local'),
      '-ExpectedTemp', (Join-Path (Join-Path $CaseRoot 'profile') 'temp'),
      '-ExpectedTmp', (Join-Path (Join-Path $CaseRoot 'profile') 'tmp'),
      '-ParentOnlyVariable', $script:EnvironmentCanaryName
    )) { [void]$argumentList.Add([string]$argument) }
  return [pscustomobject]@{ marker = $marker; markerPath = $markerPath; receiptPath = $receipt; arguments = $argumentList.ToArray() }
}

function New-StagedRuntime {
  $sourcePath = [IO.Path]::GetFullPath($PSHOME)
  $sourceExecutable = Join-Path $sourcePath 'pwsh.exe'
  if (-not [IO.Directory]::Exists($sourcePath) -or -not [IO.File]::Exists($sourceExecutable)) {
    throw 'The current PowerShell installation does not contain pwsh.exe in PSHOME.'
  }
  [void](Assert-NoReparseSegments -Path $sourcePath)
  $sourceItems = @(Get-ChildItem -LiteralPath $sourcePath -Force -Recurse -ErrorAction Stop)
  $sourceReparse = @($sourceItems | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 })
  if ($sourceReparse.Count -gt 0) { throw 'The PowerShell distribution contains reparse points and cannot be staged safely.' }

  $script:RuntimeRoot = Join-Path $script:RunnerTempFull ('issue-225-independent-runtime-' + $script:RuntimeOwnerMarker)
  [void](Assert-StrictChildPath -Path $script:RuntimeRoot -Root $script:RunnerTempFull -Message 'The private PowerShell runtime staging path escaped RUNNER_TEMP.')
  if (Test-PathExists -Path $script:RuntimeRoot) { throw 'The private PowerShell runtime staging path already exists.' }
  [void][IO.Directory]::CreateDirectory($script:RuntimeRoot)
  [IO.File]::WriteAllText((Join-Path $script:RuntimeRoot '.issue-225-independent-owner'), $script:RuntimeOwnerMarker, $script:Utf8NoBom)
  $script:RuntimePath = Join-Path $script:RuntimeRoot 'pwsh'
  [void][IO.Directory]::CreateDirectory($script:RuntimePath)
  Get-ChildItem -LiteralPath $sourcePath -Force | Copy-Item -Destination $script:RuntimePath -Recurse -Force -ErrorAction Stop
  [void](Assert-NoReparseSegments -Path $script:RuntimePath)
  $stagedItems = @(Get-ChildItem -LiteralPath $script:RuntimePath -Force -Recurse -ErrorAction Stop)
  if (@($stagedItems | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -gt 0) {
    throw 'The staged PowerShell runtime contains a reparse point.'
  }
  $script:PwshPath = Join-Path $script:RuntimePath 'pwsh.exe'
  if (-not [IO.File]::Exists($script:PwshPath)) { throw 'The staged PowerShell runtime did not contain pwsh.exe.' }
  $script:SourcePwshSha256 = Get-Sha256 -Path $sourceExecutable
  $script:StagedPwshSha256 = Get-Sha256 -Path $script:PwshPath
  Assert-Equal -Actual $script:StagedPwshSha256 -Expected $script:SourcePwshSha256 -Message 'The staged PowerShell executable hash differed from the source executable.'
}

function New-DotSourceProbeScript {
  param([Parameter(Mandatory)][string] $Path)
  $source = @'
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string] $PolicyPath,
  [Parameter(Mandatory)][string] $ProcessAdapterPath,
  [Parameter(Mandatory)][string] $JobAdapterPath,
  [Parameter(Mandatory)][string] $ReceiptPath,
  [Parameter(Mandatory)][string] $MarkerPath,
  [Parameter(Mandatory)][string] $ExpectedExecutablePath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Get-EnvironmentSnapshot {
  $map = [Collections.Generic.SortedDictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in [Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::Process).GetEnumerator()) {
    $map[[string]$entry.Key] = [string]$entry.Value
  }
  return $map
}
$before = Get-EnvironmentSnapshot
$cwdBefore = (Get-Location).Path
$beforeChildIds = @(
  Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
    Where-Object { [string]$_.ExecutablePath -ieq $ExpectedExecutablePath -and [int]$_.ProcessId -ne [int]$PID } |
    ForEach-Object { [int]$_.ProcessId }
)
. $ProcessAdapterPath
. $JobAdapterPath
. $PolicyPath
$after = Get-EnvironmentSnapshot
$cwdAfter = (Get-Location).Path
$afterChildIds = @(
  Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
    Where-Object { [string]$_.ExecutablePath -ieq $ExpectedExecutablePath -and [int]$_.ProcessId -ne [int]$PID } |
    ForEach-Object { [int]$_.ProcessId }
)
$environmentUnchanged = $before.Count -eq $after.Count
if ($environmentUnchanged) {
  foreach ($key in $before.Keys) {
    if (-not $after.ContainsKey($key) -or $before[$key] -cne $after[$key]) { $environmentUnchanged = $false; break }
  }
}
$markerAbsent = -not [IO.File]::Exists($MarkerPath)
$jobInteropNotInitialized = $null -eq ('Morrow.Pilot.WindowsNativeJobInterop' -as [type])
$policyInteropNotInitialized = $null -eq ('Morrow.Pilot.WindowsNativeProcessCapsule' -as [type])
$startCommandDefined = $null -ne (Get-Command Start-WindowsNativeProcess -ErrorAction SilentlyContinue)
$unexpectedChildren = @($afterChildIds | Where-Object { $beforeChildIds -notcontains $_ })
$receipt = [ordered]@{
  schemaVersion = 1
  environmentUnchanged = $environmentUnchanged
  workingDirectoryUnchanged = [string]::Equals($cwdBefore, $cwdAfter, [StringComparison]::OrdinalIgnoreCase)
  fixtureMarkerAbsent = $markerAbsent
  noNewStagedPowerShellChild = ($unexpectedChildren.Count -eq 0)
  jobInteropNotInitialized = $jobInteropNotInitialized
  policyInteropNotInitialized = $policyInteropNotInitialized
  startCommandDefined = $startCommandDefined
}
[IO.File]::WriteAllText($ReceiptPath, (ConvertTo-Json -InputObject $receipt -Depth 6 -Compress), [Text.UTF8Encoding]::new($false))
if (-not $environmentUnchanged -or -not $receipt.workingDirectoryUnchanged -or -not $markerAbsent -or
    $unexpectedChildren.Count -ne 0 -or -not $jobInteropNotInitialized -or -not $policyInteropNotInitialized -or -not $startCommandDefined) {
  exit 1
}
exit 0
'@
  [IO.File]::WriteAllText($Path, $source, $script:Utf8NoBom)
}

function Start-DotSourcePurityProbe {
  $caseRoot = New-CaseRoot -Name 'dot-source'
  $profile = New-PrivateProfile -CaseRoot $caseRoot
  $probePath = Join-Path $script:EvidenceRootFull 'dot-source-purity.probe.ps1'
  $probeReceiptPath = Join-Path $caseRoot 'dot-source.receipt.json'
  $markerPath = Join-Path $caseRoot 'dot-source-fixture.marker'
  New-DotSourceProbeScript -Path $probePath
  $script:FixtureSha256 = Get-Sha256 -Path $script:FixturePath
  $probeSha = Get-Sha256 -Path $probePath
  $environment = New-ExplicitEnvironment -ProfilePath ([string]$profile.USERPROFILE) -ProfileEnvironment $profile
  $environment.Add('RUNNER_TEMP', $script:RunnerTempFull)
  $environment.Add('MORROW_225_DOT_SOURCE_PROBE', [Guid]::NewGuid().ToString('N'))
  $arguments = @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', $probePath,
    '-PolicyPath', $script:PolicyFullPath,
    '-ProcessAdapterPath', $script:ProcessAdapterPath,
    '-JobAdapterPath', $script:JobAdapterPath,
    '-ReceiptPath', $probeReceiptPath,
    '-MarkerPath', $markerPath,
    '-ExpectedExecutablePath', $script:PwshPath
  )
  $record = Start-ObservedTestProcess -Role 'dot-source-probe' -ExecutablePath $script:PwshPath -ArgumentList $arguments -WorkingDirectory $caseRoot -Environment $environment
  if (-not $record.process.WaitForExit(15000)) {
    $record.emergencyCleanup = $true
    try { $record.process.Kill(); [void]$record.process.WaitForExit(5000) } catch { }
    throw 'The dot-source purity probe exceeded its 15-second bound.'
  }
  $record.exitCode = [int]$record.process.ExitCode
  if ($record.exitCode -ne 0) { throw 'The dot-source purity probe returned a failing exit code.' }
  if (-not [IO.File]::Exists($probeReceiptPath)) { throw 'The dot-source purity probe did not write its receipt.' }
  $receipt = Read-JsonFile -Path $probeReceiptPath
  foreach ($field in @(
      'environmentUnchanged', 'workingDirectoryUnchanged', 'fixtureMarkerAbsent',
      'noNewStagedPowerShellChild', 'jobInteropNotInitialized', 'policyInteropNotInitialized', 'startCommandDefined'
    )) {
    Assert-True -Condition ([bool]$receipt[$field]) -Message ("The dot-source purity probe failed field {0}." -f $field)
  }
  return [ordered]@{ receipt = $receipt; probeSha256 = $probeSha }
}

function New-Outsider {
  $caseRoot = New-CaseRoot -Name 'outsider'
  $descriptor = New-ValidDescriptor -CaseRoot $caseRoot -ArgumentList @('unused') -ExpectedParentProcessId ([int]$PID) -ExpectedOwnerSid ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
  $fixtureArgs = Get-NewFixtureArguments -CaseRoot $caseRoot -Role 'outsider'
  $environment = $descriptor.environment
  $record = Start-ObservedTestProcess -Role 'outsider' -ExecutablePath $script:PwshPath -ArgumentList $fixtureArgs.arguments -WorkingDirectory $caseRoot -Environment $environment
  $script:Outsider = [pscustomobject]@{
    process = $record.process
    processId = $record.processId
    imagePath = $record.imagePath
    creationTimeUtc = $record.creationTimeUtc
    markerPath = $fixtureArgs.markerPath
    receiptPath = $fixtureArgs.receiptPath
    marker = $fixtureArgs.marker
  }
  Wait-ForFile -Path $fixtureArgs.receiptPath -TimeoutMs 10000 -Description 'the uncontained outsider receipt'
  Wait-ForFile -Path $fixtureArgs.markerPath -TimeoutMs 10000 -Description 'the uncontained outsider marker'
  if ($script:Outsider.process.HasExited) { throw 'The outsider exited before containment checks began.' }
  return [ordered]@{
    processId = [int]$script:Outsider.processId
    image = [IO.Path]::GetFileName([string]$script:Outsider.imagePath)
    creationTimeUtc = [string]$script:Outsider.creationTimeUtc
  }
}

function Assert-OutsiderStillAlive {
  if ($null -eq $script:Outsider) { throw 'The outsider was not initialized.' }
  $script:Outsider.process.Refresh()
  Assert-True -Condition (-not $script:Outsider.process.HasExited) -Message 'A capsule operation terminated the outsider process.'
  $identity = Get-WindowsProcessOwnershipIdentity -ProcessId ([int]$script:Outsider.processId)
  Assert-Equal -Actual ([int]$identity.processId) -Expected ([int]$script:Outsider.processId) -Message 'CIM did not observe the same outsider process.'
  Assert-Equal -Actual ([string]$identity.executablePath) -Expected ([string]$script:Outsider.imagePath) -IgnoreCase -Message 'CIM observed a different outsider image.'
  Assert-Equal -Actual ([string]$identity.ownerSid) -Expected ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value) -Message 'CIM observed a different outsider owner SID.'
  Assert-Equal -Actual ([int]$identity.parentProcessId) -Expected ([int]$PID) -Message 'CIM observed a different outsider parent PID.'
  Assert-Equal -Actual ([string]$identity.ownershipMarker) -Expected ([string]$script:Outsider.marker) -Message 'CIM observed a different outsider marker.'
  $cimCreation = [DateTime]::Parse([string]$identity.creationTimeUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
  $retainedCreation = $script:Outsider.process.StartTime.ToUniversalTime()
  if ([Math]::Abs(($cimCreation - $retainedCreation).Ticks) -gt 20) { throw 'CIM no longer identified the retained outsider process creation time.' }
  [void]$script:IdentityReceipts.Add([ordered]@{
    role = 'outsider-preserved'
    processId = [int]$identity.processId
    parentProcessId = [int]$identity.parentProcessId
    creationTimeUtc = $cimCreation.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    executableName = [IO.Path]::GetFileName([string]$identity.executablePath)
    executableSha256 = [string]$identity.executableSha256
    ownerSid = [string]$identity.ownerSid
  })
  $image = [IO.Path]::GetFullPath($script:Outsider.process.MainModule.FileName)
  Assert-Equal -Actual $image -Expected ([IO.Path]::GetFullPath($script:Outsider.imagePath)) -IgnoreCase -Message 'The retained outsider handle changed its image path.'
  $now = $script:Outsider.process.StartTime.ToUniversalTime()
  $expected = [DateTime]::Parse([string]$script:Outsider.creationTimeUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
  if ([Math]::Abs(($now - $expected).Ticks) -gt 20) { throw 'The retained outsider handle no longer matched its creation time.' }
}

function Assert-NoLiveOwnedFixtureProcess {
  param([Parameter(Mandatory)][string] $OwnershipMarker)
  $needle = 'morrow-g13-synthetic-owner=' + $OwnershipMarker
  $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object {
    [string]$_.ExecutablePath -ieq $script:PwshPath -and [string]$_.CommandLine -like ('*' + $needle + '*')
  })
  if ($processes.Count -gt 0) { throw 'A process with the failed capsule ownership marker remained after cleanup.' }
}

function Assert-StartResultOpaque {
  param([Parameter(Mandatory)] $Capsule)
  Assert-True -Condition ($Capsule -is [Morrow.Pilot.WindowsNativeProcessCapsule]) -Message 'Start did not return the sealed capsule CLR type.'
  $type = $Capsule.GetType()
  Assert-True -Condition ([bool]$type.IsSealed) -Message 'The capsule CLR type was not sealed.'
  $properties = @($type.GetProperties([Reflection.BindingFlags]::Instance -bor [Reflection.BindingFlags]::Public))
  if ($properties.Count -ne 0) { throw 'The capsule exposed public properties.' }
  $constructors = @($type.GetConstructors([Reflection.BindingFlags]::Instance -bor [Reflection.BindingFlags]::Public))
  if ($constructors.Count -ne 0) { throw 'The capsule exposed a public constructor.' }
  $publicFactories = @($type.GetMethods([Reflection.BindingFlags]::Static -bor [Reflection.BindingFlags]::Public) | Where-Object { $_.DeclaringType -eq $type })
  if ($publicFactories.Count -ne 0) { throw 'The capsule exposed a public factory method.' }
  $allMethods = $type.GetMethods([Reflection.BindingFlags]::Instance -bor [Reflection.BindingFlags]::Public)
  $methods = @($allMethods | Where-Object { $_.DeclaringType -eq $type })
  $methodNames = @($methods | ForEach-Object { [string]$_.Name })
  if ($methodNames.Count -ne 1 -or $methodNames[0] -cne 'Dispose') {
    throw 'The capsule did not expose exactly one capsule-only Dispose instance operation.'
  }
}

function Test-PositiveStartAndDispose {
  $caseRoot = New-CaseRoot -Name 'positive-start'
  $fixtureArgs = Get-NewFixtureArguments -CaseRoot $caseRoot -Role 'positive'
  $ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $descriptor = New-ValidDescriptor -CaseRoot $caseRoot -ArgumentList $fixtureArgs.arguments -ExpectedParentProcessId ([int]$PID) -ExpectedOwnerSid $ownerSid
  $descriptor['expectedParentProcessId'] = [long]$PID
  $script:OriginalCanaryValue = [Environment]::GetEnvironmentVariable($script:EnvironmentCanaryName, [EnvironmentVariableTarget]::Process)
  [Environment]::SetEnvironmentVariable($script:EnvironmentCanaryName, $script:EnvironmentCanaryValue, [EnvironmentVariableTarget]::Process)
  $script:CanaryWasSet = $true
  $startOutput = @(Start-WindowsNativeProcess -Descriptor $descriptor -Verbose 4>&1)
  $returnedCapsules = @($startOutput | Where-Object { $_ -is [Morrow.Pilot.WindowsNativeProcessCapsule] })
  $verboseMessages = @($startOutput | Where-Object { $_ -is [System.Management.Automation.VerboseRecord] } | ForEach-Object { [string]$_.Message })
  if ($returnedCapsules.Count -ne 1) { throw 'Start did not return exactly one opaque capsule.' }
  $capsule = $returnedCapsules[0]
  [void]$script:Capsules.Add($capsule)
  $identityProofIndex = -1
  $resumeIndex = -1
  for ($index = 0; $index -lt $verboseMessages.Count; $index++) {
    if ($verboseMessages[$index] -like 'Morrow.WindowsNativeProcess.IdentityProof:*') { $identityProofIndex = $index }
    if ($verboseMessages[$index] -like 'Morrow.WindowsNativeProcess.Resume:*') { $resumeIndex = $index }
  }
  if ($identityProofIndex -lt 0 -or $resumeIndex -le $identityProofIndex) {
    throw 'Verbose receipts did not prove identity validation before internal Resume.'
  }
  Assert-StartResultOpaque -Capsule $capsule
  $fixtureReceipt = Wait-ForFixtureReceipt -ReceiptPath $fixtureArgs.receiptPath -MarkerPath $fixtureArgs.markerPath -TimeoutMs 10000
  Assert-ReceiptBooleanFields -Receipt $fixtureReceipt
  $identity = Get-ProcessIdentityRecord -ProcessId ([int]$fixtureReceipt.processId)
  Assert-CimIdentityMatchesDescriptor -Identity $identity -Descriptor $descriptor -ReceiptProcessId ([int]$fixtureReceipt.processId)
  $rootIdentityReceipt = $script:IdentityReceipts[$script:IdentityReceipts.Count - 1]
  [void]$script:CaseOutcomes.Add([ordered]@{
    name = 'positive-start'
    status = 'passed'
    processId = [int]$identity.processId
    parentProcessId = [int]$identity.parentProcessId
    executableName = [IO.Path]::GetFileName([string]$identity.executablePath)
    executableSha256 = [string]$identity.executableSha256
    ownerSid = [string]$identity.ownerSid
    creationTimeUtc = [string]$identity.creationTimeUtc
    markerObservedAfterStart = [IO.File]::Exists($fixtureArgs.markerPath)
    identityProofPrecededInternalResume = $true
  })

  $watch = [Diagnostics.Stopwatch]::StartNew()
  $cleanup = $capsule.Dispose()
  $watch.Stop()
  Assert-True -Condition ([bool]$cleanup.jobEmpty) -Message 'Capsule Dispose did not observe an empty private Job.'
  Assert-True -Condition ([bool]$cleanup.rootExited) -Message 'Capsule Dispose did not observe root exit.'
  Assert-True -Condition ($watch.ElapsedMilliseconds -le 12000) -Message 'Capsule Dispose exceeded its bounded cleanup window.'
  $secondWatch = [Diagnostics.Stopwatch]::StartNew()
  $repeatCleanup = $capsule.Dispose()
  $secondWatch.Stop()
  Assert-True -Condition ([bool]$repeatCleanup.jobEmpty -and [bool]$repeatCleanup.rootExited) -Message 'Repeated capsule Dispose did not return the verified terminal state.'
  Assert-True -Condition ($secondWatch.ElapsedMilliseconds -le 1000) -Message 'Repeated capsule Dispose was not idempotent and prompt.'
  Assert-OutsiderStillAlive
  $script:CleanupNotes.Add('positive capsule Dispose verified empty Job and exited root; outsider retained and alive')
  return [ordered]@{
    capsuleType = [string]$capsule.GetType().FullName
    fixtureReceipt = $fixtureReceipt
    identity = $rootIdentityReceipt
    verboseEvidence = [ordered]@{ identityProofPrecededResume = $true; messageCount = $verboseMessages.Count }
    cleanup = [ordered]@{ jobEmpty = [bool]$cleanup.jobEmpty; rootExited = [bool]$cleanup.rootExited; exitCode = $cleanup.exitCode }
    disposeElapsedMs = $watch.ElapsedMilliseconds
    repeatDisposeElapsedMs = $secondWatch.ElapsedMilliseconds
    outsiderAlive = $true
  }
}

function New-InvalidDescriptorCases {
  param([Parameter(Mandatory)][string] $CaseRoot)
  $fixtureArgs = Get-NewFixtureArguments -CaseRoot $CaseRoot -Role 'invalid'
  $valid = New-ValidDescriptor -CaseRoot $CaseRoot -ArgumentList $fixtureArgs.arguments -ExpectedParentProcessId ([int]$PID) -ExpectedOwnerSid ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
  $cases = [Collections.Generic.List[object]]::new()
  $cases.Add([pscustomobject]@{ name = 'descriptor-null'; expectedField = $null; descriptor = $null })
  $cases.Add([pscustomobject]@{ name = 'descriptor-not-idictionary'; expectedField = $null; descriptor = [pscustomobject]@{ executablePath = $script:PwshPath } })
  $cases.Add([pscustomobject]@{ name = 'descriptor-missing-field'; expectedField = 'profilePath'; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d.Remove('profilePath') }) })
  $cases.Add([pscustomobject]@{ name = 'descriptor-extra-field'; expectedField = $null; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d.Add('unexpectedField', 'value') }) })
  $cases.Add([pscustomobject]@{ name = 'descriptor-case-duplicate-field'; expectedField = $null; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d.Add('ExecutablePath', $script:PwshPath) }) })
  $cases.Add([pscustomobject]@{ name = 'argument-list-not-list'; expectedField = 'argumentList'; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['argumentList'] = 'not-a-list' }) })
  $cases.Add([pscustomobject]@{ name = 'argument-list-non-string'; expectedField = 'argumentList'; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['argumentList'] = [Collections.ArrayList]::new(); [void]$d['argumentList'].Add(17) }) })
  $cases.Add([pscustomobject]@{ name = 'argument-list-nul'; expectedField = 'argumentList'; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['argumentList'] = [Collections.ArrayList]::new(); $d['argumentList'].Add("bad`0arg") }) })
  $cases.Add([pscustomobject]@{ name = 'hash-format-invalid'; expectedField = 'executableSha256'; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['executableSha256'] = 'not-a-hash' }) })
  $cases.Add([pscustomobject]@{ name = 'hash-valid-shape-but-wrong'; expectedField = 'executableSha256'; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['executableSha256'] = ('0' * 64) }) })
  $cases.Add([pscustomobject]@{ name = 'ppid-string-coercion-refused'; expectedField = 'expectedParentProcessId'; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['expectedParentProcessId'] = [string]$PID }) })
  $cases.Add([pscustomobject]@{ name = 'ppid-boolean-refused'; expectedField = 'expectedParentProcessId'; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['expectedParentProcessId'] = $true }) })
  $cases.Add([pscustomobject]@{ name = 'ppid-out-of-range'; expectedField = 'expectedParentProcessId'; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['expectedParentProcessId'] = 0 }) })
  $cases.Add([pscustomobject]@{ name = 'sid-malformed'; expectedField = 'expectedOwnerSid'; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['expectedOwnerSid'] = 'S-1-5-not-a-number' }) })
  $cases.Add([pscustomobject]@{ name = 'sid-noncanonical-case'; expectedField = 'expectedOwnerSid'; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['expectedOwnerSid'] = 's-1-5-18' }) })
  $cases.Add([pscustomobject]@{ name = 'environment-not-idictionary'; expectedField = 'environment'; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['environment'] = 'not-a-map' }) })
  $cases.Add([pscustomobject]@{ name = 'environment-missing-required-key'; expectedField = 'environment'; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['environment'].Remove('TEMP') }) })
  $cases.Add([pscustomobject]@{ name = 'environment-github-token-key-rejected'; expectedField = 'environment'; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['environment'].Add('GITHUB_TOKEN', 'synthetic-never-secret') }) })
  $cases.Add([pscustomobject]@{ name = 'environment-actions-key-rejected'; expectedField = 'environment'; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['environment'].Add('ACTIONS_ID_TOKEN_REQUEST_URL', 'synthetic.invalid') }) })
  $cases.Add([pscustomobject]@{ name = 'environment-case-duplicate'; expectedField = 'environment'; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['environment'].Add('systemroot', [string]$d['environment']['SYSTEMROOT']) }) })
  $cases.Add([pscustomobject]@{ name = 'environment-non-string-value'; expectedField = 'environment'; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['environment']['TEMP'] = 7 }) })
  $cases.Add([pscustomobject]@{ name = 'environment-embedded-newline'; expectedField = 'environment'; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['environment']['PATH'] = [string]$d['environment']['PATH'] + "`nC:\\bad" }) })
  $cases.Add([pscustomobject]@{ name = 'environment-userprofile-mismatch'; expectedField = 'USERPROFILE'; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['environment']['USERPROFILE'] = Join-Path $script:RunnerTempFull 'outside-profile' }) })
  $cases.Add([pscustomobject]@{ name = 'environment-temp-outside-profile'; expectedField = 'TEMP'; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['environment']['TEMP'] = $script:RunnerTempFull }) })
  $semicolonDirectory = Join-Path $CaseRoot 'runtime;segment'
  [void][IO.Directory]::CreateDirectory($semicolonDirectory)
  $semicolonExecutable = Join-Path $semicolonDirectory 'placeholder.exe'
  [IO.File]::WriteAllBytes($semicolonExecutable, [byte[]]@(0x4D, 0x5A, 0x00, 0x00))
  $semicolonExecutableSha256 = Get-Sha256 -Path $semicolonExecutable
  $cases.Add([pscustomobject]@{ name = 'executable-directory-semicolon-rejected'; expectedField = 'executablePath'; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['executablePath'] = $semicolonExecutable; $d['executableSha256'] = $semicolonExecutableSha256; $system32 = Join-Path ([Environment]::GetEnvironmentVariable('SystemRoot')) 'System32'; $d['environment']['PATH'] = $system32 + ';' + $semicolonDirectory }) })
  $cases.Add([pscustomobject]@{ name = 'executable-outside-runner-temp'; expectedField = 'executablePath'; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['executablePath'] = (Join-Path $PSHOME 'pwsh.exe'); $d['executableSha256'] = Get-Sha256 -Path $d['executablePath']; $system32 = Join-Path ([Environment]::GetEnvironmentVariable('SystemRoot')) 'System32'; $d['environment']['PATH'] = $system32 + ';' + $PSHOME }) })
  $cases.Add([pscustomobject]@{ name = 'working-directory-outside-runner-temp'; expectedField = 'workingDirectory'; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['workingDirectory'] = [IO.Path]::GetFullPath($PSHOME) }) })
  $cases.Add([pscustomobject]@{ name = 'profile-outside-runner-temp'; expectedField = 'profilePath'; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['profilePath'] = [IO.Path]::GetFullPath($PSHOME) }) })
  $cases.Add([pscustomobject]@{ name = 'executable-path-absent'; expectedField = 'executablePath'; descriptor = (Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['executablePath'] = Join-Path $script:RuntimePath 'missing-pwsh.exe' }) })

  foreach ($testCase in $cases) {
    $diagnostics = Invoke-ExpectedPolicyFailure -Descriptor $testCase.descriptor -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -ExpectedField $testCase.expectedField
    if ([IO.File]::Exists($fixtureArgs.markerPath) -or [IO.File]::Exists($fixtureArgs.receiptPath)) { throw 'A rejected descriptor executed the synthetic fixture.' }
    Assert-NoLiveOwnedFixtureProcess -OwnershipMarker $fixtureArgs.marker
    $script:CaseOutcomes.Add([ordered]@{ name = [string]$testCase.name; status = 'passed'; stage = [string]$diagnostics.stage })
  }

  $junctionPaths = [Collections.Generic.List[string]]::new()
  try {
    $junctionPath = Join-Path $CaseRoot 'runtime-junction'
    New-Item -Path $junctionPath -ItemType Junction -Target $script:RuntimePath -ErrorAction Stop | Out-Null
    [void]$junctionPaths.Add($junctionPath)
    $junctionExecutable = Join-Path $junctionPath 'pwsh.exe'
    $junctionDescriptor = Copy-DescriptorWithMutation -Descriptor $valid -Mutation {
      param($d)
      $d['executablePath'] = $junctionExecutable
      $d['executableSha256'] = $script:StagedPwshSha256
      $system32 = Join-Path ([Environment]::GetEnvironmentVariable('SystemRoot')) 'System32'
      $d['environment']['PATH'] = $system32 + ';' + $junctionPath
    }
    $junctionDiagnostics = Invoke-ExpectedPolicyFailure -Descriptor $junctionDescriptor -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor'
    $script:CaseOutcomes.Add([ordered]@{ name = 'executable-reparse-junction-refused'; status = 'passed'; stage = [string]$junctionDiagnostics.stage })

    $workingTarget = Join-Path $CaseRoot 'working-target'
    [void][IO.Directory]::CreateDirectory($workingTarget)
    $workingJunction = Join-Path $CaseRoot 'working-junction'
    New-Item -Path $workingJunction -ItemType Junction -Target $workingTarget -ErrorAction Stop | Out-Null
    [void]$junctionPaths.Add($workingJunction)
    $workingDescriptor = Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['workingDirectory'] = $workingJunction }
    $workingDiagnostics = Invoke-ExpectedPolicyFailure -Descriptor $workingDescriptor -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor'
    $script:CaseOutcomes.Add([ordered]@{ name = 'working-directory-reparse-junction-refused'; status = 'passed'; stage = [string]$workingDiagnostics.stage })

    $profileTarget = Join-Path $CaseRoot 'profile-target'
    foreach ($segment in @('', 'appdata', 'local', 'temp', 'tmp')) {
      $targetPath = if ($segment) { Join-Path $profileTarget $segment } else { $profileTarget }
      [void][IO.Directory]::CreateDirectory($targetPath)
    }
    $profileJunction = Join-Path $CaseRoot 'profile-junction'
    New-Item -Path $profileJunction -ItemType Junction -Target $profileTarget -ErrorAction Stop | Out-Null
    [void]$junctionPaths.Add($profileJunction)
    $profileDescriptor = Copy-DescriptorWithMutation -Descriptor $valid -Mutation {
      param($d)
      $d['profilePath'] = $profileJunction
      $d['environment']['USERPROFILE'] = $profileJunction
      $d['environment']['HOME'] = $profileJunction
      $d['environment']['APPDATA'] = Join-Path $profileJunction 'appdata'
      $d['environment']['LOCALAPPDATA'] = Join-Path $profileJunction 'local'
      $d['environment']['TEMP'] = Join-Path $profileJunction 'temp'
      $d['environment']['TMP'] = Join-Path $profileJunction 'tmp'
    }
    $profileDiagnostics = Invoke-ExpectedPolicyFailure -Descriptor $profileDescriptor -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor'
    $script:CaseOutcomes.Add([ordered]@{ name = 'profile-reparse-junction-refused'; status = 'passed'; stage = [string]$profileDiagnostics.stage })

    $profilePath = [string]$valid.profilePath
    $tempTarget = Join-Path $profilePath 'temp-target'
    $tempJunction = Join-Path $profilePath 'temp-junction'
    [void][IO.Directory]::CreateDirectory($tempTarget)
    New-Item -Path $tempJunction -ItemType Junction -Target $tempTarget -ErrorAction Stop | Out-Null
    [void]$junctionPaths.Add($tempJunction)
    $tempDescriptor = Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['environment']['TEMP'] = $tempJunction }
    $tempDiagnostics = Invoke-ExpectedPolicyFailure -Descriptor $tempDescriptor -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor'
    $script:CaseOutcomes.Add([ordered]@{ name = 'environment-temp-reparse-junction-refused'; status = 'passed'; stage = [string]$tempDiagnostics.stage })
  } finally {
    for ($index = $junctionPaths.Count - 1; $index -ge 0; $index--) {
      try { [IO.Directory]::Delete($junctionPaths[$index], $false) } catch { throw 'The independent test could not safely remove one of its own junctions.' }
    }
  }
  return [ordered]@{ invalidCaseCount = $cases.Count + 5; noFixtureMarkers = $true }
}

function Test-PostCreateMismatch {
  param(
    [Parameter(Mandatory)][string] $MismatchName,
    [Parameter(Mandatory)][ValidateSet('ownerSid', 'parentProcessId')][string] $MismatchKind
  )
  $caseRoot = New-CaseRoot -Name $MismatchName
  $fixtureArgs = Get-NewFixtureArguments -CaseRoot $caseRoot -Role $MismatchName
  $ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $expectedPpid = [int]$PID
  $expectedSid = $ownerSid
  if ($MismatchKind -eq 'ownerSid') {
    $parts = $ownerSid.Split('-')
    [uint64]$last = [uint64]::Parse($parts[$parts.Length - 1], [Globalization.CultureInfo]::InvariantCulture)
    if ($last -lt [uint32]::MaxValue) { $last++ } else { $last-- }
    $parts[$parts.Length - 1] = $last.ToString([Globalization.CultureInfo]::InvariantCulture)
    $expectedSid = [Security.Principal.SecurityIdentifier]::new(($parts -join '-')).Value
    if ($expectedSid -ceq $ownerSid) { throw 'The independent test could not construct a distinct canonical SID.' }
  } else {
    $expectedPpid = if ([int]$PID -eq 1) { 2 } else { 1 }
    if ($expectedPpid -eq [int]$PID) { throw 'The independent test could not construct a distinct valid parent PID.' }
  }
  $descriptor = New-ValidDescriptor -CaseRoot $caseRoot -ArgumentList $fixtureArgs.arguments -ExpectedParentProcessId $expectedPpid -ExpectedOwnerSid $expectedSid
  if ($MismatchKind -eq 'ownerSid') { $descriptor.environment.Remove('HOME') }
  $diagnostics = Invoke-ExpectedPolicyFailure -Descriptor $descriptor -ExpectedErrorId 'Morrow.WindowsNativeProcess.IdentityMismatch' -ExpectedStage 'identity-comparison' -ExpectCompleteCleanup -ExpectedField $MismatchKind
  if ([IO.File]::Exists($fixtureArgs.markerPath) -or [IO.File]::Exists($fixtureArgs.receiptPath)) {
    throw 'A post-create identity mismatch allowed the synthetic fixture to execute.'
  }
  Assert-NoLiveOwnedFixtureProcess -OwnershipMarker $fixtureArgs.marker
  Assert-OutsiderStillAlive
  $script:CaseOutcomes.Add([ordered]@{
    name = $MismatchName
    status = 'passed'
    stage = [string]$diagnostics.stage
    mismatchKind = $MismatchKind
    cleanup = [ordered]@{ attempted = [bool]$diagnostics.cleanup.attempted; jobEmpty = [bool]$diagnostics.cleanup.jobEmpty; rootExited = [bool]$diagnostics.cleanup.rootExited }
    fixtureMarkerAbsent = $true
    outsiderAlive = $true
  })
  return [ordered]@{ mismatchKind = $MismatchKind; stage = [string]$diagnostics.stage; cleanup = $diagnostics.cleanup; markerAbsent = $true; outsiderAlive = $true }
}

function Stop-TrackedTestProcess {
  param([Parameter(Mandatory)] $Record)
  try {
    $Record.process.Refresh()
    if (-not $Record.process.HasExited) {
      $image = [IO.Path]::GetFullPath($Record.process.MainModule.FileName)
      if (-not [string]::Equals($image, [string]$Record.imagePath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'A retained test process handle no longer matched its owned executable.'
      }
      $Record.process.Kill()
      if (-not $Record.process.WaitForExit(5000)) { throw 'A retained test process handle did not exit within five seconds.' }
      $Record.emergencyCleanup = $true
    }
    if ($Record.process.HasExited) { $Record.exitCode = [int]$Record.process.ExitCode }
    $Record.hasExited = [bool]$Record.process.HasExited
  } finally {
    try { $Record.process.Dispose() } catch { }
  }
}

function Close-AllOwnedCapsules {
  for ($index = $script:Capsules.Count - 1; $index -ge 0; $index--) {
    try {
      $cleanup = $script:Capsules[$index].Dispose()
      if (-not [bool]$cleanup.jobEmpty -or -not [bool]$cleanup.rootExited) {
        $script:Failures.Add('capsule-final-cleanup-incomplete')
      }
    } catch {
      $script:Failures.Add('capsule-final-cleanup-threw')
    }
  }
}

function Restore-TestEnvironment {
  if ($script:CanaryWasSet) {
    try {
      [Environment]::SetEnvironmentVariable($script:EnvironmentCanaryName, $script:OriginalCanaryValue, [EnvironmentVariableTarget]::Process)
      $restoredValue = [Environment]::GetEnvironmentVariable($script:EnvironmentCanaryName, [EnvironmentVariableTarget]::Process)
      if ($restoredValue -cne $script:OriginalCanaryValue) { throw 'The parent-only environment canary value did not restore exactly.' }
      $script:CanaryWasSet = $false
      $script:CleanupNotes.Add('parent-only environment canary restored and verified')
    } catch {
      $script:Failures.Add('environment-canary-restore-failed')
      $script:CleanupNotes.Add('parent-only environment canary restoration failed')
    }
  }
}

function Close-AllTrackedProcesses {
  for ($index = $script:TrackedProcesses.Count - 1; $index -ge 0; $index--) {
    try { Stop-TrackedTestProcess -Record $script:TrackedProcesses[$index] } catch {
      $script:Failures.Add('tracked-test-process-cleanup-failed')
    }
  }
}

function Remove-OwnedRuntimeStage {
  if ([string]::IsNullOrWhiteSpace($script:RuntimeRoot) -or -not [IO.Directory]::Exists($script:RuntimeRoot)) { return }
  $markerPath = Join-Path $script:RuntimeRoot '.issue-225-independent-owner'
  if (-not [IO.File]::Exists($markerPath)) {
    $script:Failures.Add('runtime-stage-owner-marker-missing')
    $script:CleanupNotes.Add('private runtime stage retained because its ownership marker was missing')
    return
  }
  $marker = [IO.File]::ReadAllText($markerPath)
  if ($marker -cne $script:RuntimeOwnerMarker) {
    $script:Failures.Add('runtime-stage-owner-marker-mismatch')
    $script:CleanupNotes.Add('private runtime stage retained because its ownership marker did not match')
    return
  }
  try {
    $liveStaged = @(
      Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
        Where-Object { [string]$_.ExecutablePath -ieq $script:PwshPath }
    )
  } catch {
    $script:Failures.Add('runtime-stage-process-observation-failed')
    $script:CleanupNotes.Add('private runtime stage retained because process observation failed')
    return
  }
  if ($liveStaged.Count -gt 0) {
    $script:Failures.Add('runtime-stage-still-in-use')
    $script:CleanupNotes.Add('private runtime stage retained because a process still used its staged image')
    return
  }
  try {
    [void](Assert-StrictChildPath -Path $script:RuntimeRoot -Root $script:RunnerTempFull -Message 'The private runtime stage was not below RUNNER_TEMP.')
    Remove-Item -LiteralPath $script:RuntimeRoot -Recurse -Force -ErrorAction Stop
    $script:CleanupNotes.Add('private runtime stage removed after all test-created PowerShell processes exited')
  } catch {
    $script:Failures.Add('runtime-stage-removal-failed')
    $script:CleanupNotes.Add('private runtime stage could not be safely removed')
  }
}

function Get-ReceiptStatus {
  if ($script:Failures.Count -gt 0 -or @($script:Checks.Values | Where-Object { $_.status -eq 'failed' }).Count -gt 0) { return 'failed' }
  return 'passed'
}

function Write-FinalReceipt {
  if ([string]::IsNullOrWhiteSpace($script:EvidenceRootFull)) {
    [Console]::Out.WriteLine('{"schemaVersion":1,"issue":225,"status":"failed","evidenceAvailable":false}')
    return
  }
  $receipt = [ordered]@{
    schemaVersion = 1
    issue = $script:Issue
    status = Get-ReceiptStatus
    startedAtUtc = $script:RunStartedUtc
    completedAtUtc = [DateTime]::UtcNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    sourceRevision = $env:GITHUB_SHA
    workflowRunId = $env:GITHUB_RUN_ID
    workflowRunAttempt = $env:GITHUB_RUN_ATTEMPT
    operatingSystemVersion = [Environment]::OSVersion.Version.ToString()
    windowsBuild = [Environment]::GetEnvironmentVariable('WindowsBuildLabEx', [EnvironmentVariableTarget]::Process)
    powershellVersion = $PSVersionTable.PSVersion.ToString()
    powershellEdition = $PSVersionTable.PSEdition
    runnerTempRelativeEvidence = if ($script:EvidenceRootFull) { [IO.Path]::GetRelativePath($script:RunnerTempFull, $script:EvidenceRootFull) } else { $null }
    policySha256 = $script:PolicySha256
    processAdapterSha256 = $script:ProcessAdapterSha256
    jobAdapterSha256 = $script:JobAdapterSha256
    independentTestSha256 = $script:IndependentSha256
    fixtureSha256 = $script:FixtureSha256
    sourcePwshSha256 = $script:SourcePwshSha256
    stagedPwshSha256 = $script:StagedPwshSha256
    stagedRuntimeIncludedInEvidence = $false
    checks = $script:Checks
    cases = @($script:CaseOutcomes)
    identityObservations = @($script:IdentityReceipts)
    trackedProcesses = @($script:TrackedProcesses | ForEach-Object {
      [ordered]@{
        role = $_.role
        processId = $_.processId
        image = [IO.Path]::GetFileName([string]$_.imagePath)
        creationTimeUtc = $_.creationTimeUtc
        exitCode = $_.exitCode
        emergencyCleanup = $_.emergencyCleanup
      }
    })
    cleanup = [ordered]@{
      notes = @($script:CleanupNotes)
      outstandingProcessIds = @(@($script:TrackedProcesses | Where-Object { -not [bool]$_.hasExited } | ForEach-Object { [int]$_.processId }))
      runtimeStageRetained = if ($script:RuntimeRoot) { [IO.Directory]::Exists($script:RuntimeRoot) } else { $false }
    }
    failures = @($script:Failures)
  }
  try {
    if ($script:ReceiptPath -and $script:EvidenceRootFull -and [IO.Directory]::Exists($script:EvidenceRootFull)) {
      Write-JsonAtomically -Path $script:ReceiptPath -Value $receipt
      [Console]::Out.WriteLine((ConvertTo-Json -InputObject $receipt -Depth 20 -Compress))
      $script:FinalReceiptWritten = $true
    }
  } catch {
    [Console]::Error.WriteLine('FAIL receipt: unable to write the sanitized independent receipt.')
    [Console]::Out.WriteLine('{"schemaVersion":1,"issue":225,"status":"failed","receiptWriteFailed":true}')
    $script:Failures.Add('receipt-write-failed')
  }
}

$runFailed = $false
try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This independent native process policy probe must run on a real Windows runner.'
  }
  if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
    throw 'RUNNER_TEMP is required for the independent native process policy probe.'
  }
  $script:RunnerTempFull = Get-CanonicalFullPath -Path $env:RUNNER_TEMP
  [void](Assert-NoReparseSegments -Path $script:RunnerTempFull)
  $requestedEvidence = [IO.Path]::GetFullPath($EvidenceRoot)
  $script:EvidenceRootFull = Assert-StrictChildPath -Path $requestedEvidence -Root $script:RunnerTempFull -Message 'EvidenceRoot must be a strict new child beneath RUNNER_TEMP.'
  if (Test-PathExists -Path $script:EvidenceRootFull) { throw 'EvidenceRoot already exists; refusing to overwrite evidence.' }
  [void][IO.Directory]::CreateDirectory($script:EvidenceRootFull)
  $script:EvidencePath = $script:EvidenceRootFull
  $script:ReceiptPath = Join-Path $script:EvidenceRootFull 'windows-native-process-policy.independent.receipt.json'
  [IO.File]::WriteAllText((Join-Path $script:EvidenceRootFull '.issue-225-independent-owner'), [Guid]::NewGuid().ToString('N'), $script:Utf8NoBom)

  $script:PolicyFullPath = [IO.Path]::GetFullPath($PolicyPath)
  if (-not [IO.File]::Exists($script:PolicyFullPath)) { throw 'The explicit PolicyPath does not exist.' }
  $pilotDirectory = [IO.Path]::GetDirectoryName($script:PolicyFullPath)
  $script:ProcessAdapterPath = Join-Path $pilotDirectory 'windows-process.ps1'
  $script:JobAdapterPath = Join-Path $pilotDirectory 'windows-native-job.ps1'
  foreach ($path in @($script:ProcessAdapterPath, $script:JobAdapterPath)) {
    if (-not [IO.File]::Exists($path)) { throw 'The required immutable helper sibling is missing.' }
  }
  $script:PolicySha256 = Get-Sha256 -Path $script:PolicyFullPath
  $script:ProcessAdapterSha256 = Get-Sha256 -Path $script:ProcessAdapterPath
  $script:JobAdapterSha256 = Get-Sha256 -Path $script:JobAdapterPath
  $script:IndependentSha256 = Get-Sha256 -Path $PSCommandPath

  New-StagedRuntime
  $fixtureDirectory = Join-Path $script:EvidenceRootFull 'fixtures'
  [void][IO.Directory]::CreateDirectory($fixtureDirectory)
  $script:FixturePath = Join-Path $fixtureDirectory 'windows-native-process-policy.fixture.ps1'
  Write-FixtureScript -Path $script:FixturePath
  $script:FixtureSha256 = Get-Sha256 -Path $script:FixturePath
  $probePlan = Start-DotSourcePurityProbe
  $script:Checks['dot-source-has-no-side-effects'] = [ordered]@{
    status = 'passed'
    detail = $probePlan.receipt
    probeSha256 = $probePlan.probeSha256
  }
  [Console]::Out.WriteLine('PASS dot-source-has-no-side-effects')

  . $script:ProcessAdapterPath
  . $script:JobAdapterPath
  . $script:PolicyFullPath
  $outsiderDetails = New-Outsider
  $script:Checks['outsider-setup'] = [ordered]@{ status = 'passed'; detail = $outsiderDetails }
  [Console]::Out.WriteLine('PASS outsider-setup')

  Add-Check -Name 'positive-start-identity-environment-and-capsule-dispose' -Action { Test-PositiveStartAndDispose }
  Add-Check -Name 'closed-descriptor-and-precreate-refusals' -Action { New-InvalidDescriptorCases -CaseRoot (New-CaseRoot -Name 'invalid-descriptors') }
  Add-Check -Name 'post-create-owner-sid-mismatch-cleans-only-owned-job' -Action { Test-PostCreateMismatch -MismatchName 'mismatch-owner-sid' -MismatchKind ownerSid }
  Add-Check -Name 'post-create-parent-process-mismatch-cleans-only-owned-job' -Action { Test-PostCreateMismatch -MismatchName 'mismatch-parent-process' -MismatchKind parentProcessId }
} catch {
  $runFailed = $true
  $safeMessage = Get-SafeMessage -Exception $_.Exception
  $script:Failures.Add('setup-failed')
  [Console]::Error.WriteLine(('FAIL setup: {0}' -f $safeMessage))
} finally {
  try { Close-AllOwnedCapsules } catch { $script:Failures.Add('capsule-finalization-unhandled') }
  try { Restore-TestEnvironment } catch { $script:Failures.Add('environment-finalization-unhandled') }
  try { Close-AllTrackedProcesses } catch { $script:Failures.Add('tracked-process-finalization-unhandled') }
  try { Remove-OwnedRuntimeStage } catch { $script:Failures.Add('runtime-finalization-unhandled') }
  try { Write-FinalReceipt } catch {
    $script:Failures.Add('final-receipt-finalization-unhandled')
    [Console]::Error.WriteLine('FAIL receipt: finalization failed before the sanitized receipt could be completed.')
    [Console]::Out.WriteLine('{"schemaVersion":1,"issue":225,"status":"failed","receiptWriteFailed":true}')
  }
}

if ($runFailed -or (Get-ReceiptStatus) -ne 'passed') { exit 1 }
exit 0
