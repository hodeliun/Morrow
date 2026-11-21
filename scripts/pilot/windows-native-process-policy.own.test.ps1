[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateNotNullOrEmpty()]
  [string] $EvidenceRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$runId = [Guid]::NewGuid().ToString('N')
$checks = [ordered]@{
  dotSourceHasNoInteropSideEffects = $false
  descriptorIsClosedAndStrict = $false
  emptyArgvIsAccepted = $false
  invalidDescriptorsLaunchNothing = $false
  rejectsReparseAndOutsidePaths = $false
  stagedRuntimeOutsideEvidenceRoot = $false
  rejectsSemicolonInStagedExeDirectory = $false
  cimPathNullAndEmptyAccepted = $false
  cimPathPresentCorroborated = $false
  cimPathMalformedRejected = $false
  cimPathWhitespaceRejected = $false
  cimPathMismatchRejected = $false
  nativeImageMismatchRejected = $false
  cimRowMissingRejected = $false
  cimRowsAmbiguousRejected = $false
  cimPidMismatchRejected = $false
  cimParentMissingRejected = $false
  cimCreationDateMissingRejected = $false
  cimCreationDateInvalidRejected = $false
  cimCreationTimeMismatchRejected = $false
  cimOwnerMissingRejected = $false
  cimOwnerReturnValueMissingRejected = $false
  cimOwnerReturnValueNonIntegralRejected = $false
  cimOwnerReturnValueNonzeroRejected = $false
  cimOwnerSidMalformedRejected = $false
  postCreateHashMismatchRejected = $false
  mismatchedParentFailsBeforeResume = $false
  outsiderSurvivesParentMismatchCleanup = $false
  mismatchedOwnerFailsBeforeResume = $false
  outsiderSurvivesOwnerMismatchCleanup = $false
  unicodeArgvAndProfileReachOwnedChild = $false
  childEnvironmentDoesNotInheritCredentials = $false
  parentCanaryWasInjected = $false
  childDoesNotInheritPersonalCanary = $false
  parentCanaryRestored = $false
  opaqueCapsuleHasOnlySafeDispose = $false
  disposeConfirmsEmptyJobAndExitedRoot = $false
  disposeIsIdempotent = $false
  outsiderSurvivesOwnedCleanup = $false
  noProductOrGuiLaunched = $true
}
$observations = [Collections.Generic.List[object]]::new()
$cleanupErrors = [Collections.Generic.List[string]]::new()
$failure = $null
$failurePhase = 'platform-preflight'
$failureDiagnostic = $null
$runnerTemp = [Environment]::GetEnvironmentVariable('RUNNER_TEMP', [EnvironmentVariableTarget]::Process)
$evidenceFullPath = $null
$privateRoot = $null
$ownerMarker = $null
$privateRootCreated = $false
$evidenceRootCreated = $false
$junctionPath = $null
$capsule = $null
$outsider = $null
$outsiderAliveAtEnd = $false
$outsiderAliveAfterParentMismatch = $false
$outsiderAliveAfterOwnerMismatch = $false
$outsiderExited = $true
$allNativeJobsCleaned = $true
$cimDiagnosticCleanupUnconfirmed = $false
$privateRuntimeRetained = $false
$capsuleCleanup = $null
$pwshPath = $null
$pwshHash = $null
$profilePath = $null
$childScriptPath = $null
$receipt = $null
$childReport = $null
$verboseMismatch = @()
$verboseSuccess = @()
$identitySid = $null
$secretSentinel = 'issue-225-secret-must-not-appear-in-output-7f04f1'
$personalCanaryName = $null
$personalCanaryOriginalPresent = $false
$personalCanaryOriginalValue = $null
$personalCanarySetAttempted = $false
$personalCanaryRestored = $false
$policyPath = Join-Path $PSScriptRoot 'windows-native-process-policy.ps1'
$processHelperPath = Join-Path $PSScriptRoot 'windows-process.ps1'
$nativeJobHelperPath = Join-Path $PSScriptRoot 'windows-native-job.ps1'

function Assert-PolicyCheck {
  param(
    [Parameter(Mandatory)][bool] $Condition,
    [Parameter(Mandatory)][string] $Name
  )

  if (-not $Condition) { throw "Acceptance check failed: $Name" }
  $checks[$Name] = $true
}

function Get-PolicyDiagnostics {
  param([Parameter(Mandatory)][Exception] $Exception)

  $current = $Exception
  for ($depth = 0; $null -ne $current -and $depth -lt 8; $depth++) {
    if ($current.Data.Contains('Morrow.WindowsNativeProcess.Diagnostics')) {
      return $current.Data['Morrow.WindowsNativeProcess.Diagnostics']
    }
    $current = $current.InnerException
  }
  return $null
}

function Get-PolicyErrorId {
  param([Parameter(Mandatory)][Exception] $Exception)

  $current = $Exception
  for ($depth = 0; $null -ne $current -and $depth -lt 8; $depth++) {
    if ($current.Data.Contains('Morrow.WindowsNativeProcess.ErrorId')) {
      return [string]$current.Data['Morrow.WindowsNativeProcess.ErrorId']
    }
    $current = $current.InnerException
  }
  return $null
}

function Test-PolicyIdentityFailure {
  param(
    [Parameter(Mandatory)][scriptblock] $Action,
    [Parameter(Mandatory)][string] $ExpectedField
  )

  try {
    $null = & $Action
    return $false
  } catch {
    $diagnostics = Get-PolicyDiagnostics -Exception $_.Exception
    return (
      (Get-PolicyErrorId -Exception $_.Exception) -ceq 'Morrow.WindowsNativeProcess.StartFailed' -and
      $diagnostics -is [System.Collections.IDictionary] -and
      @($diagnostics['fields']) -ccontains $ExpectedField
    )
  }
}

function New-SanitizedPolicyFailureObservation {
  param(
    [AllowNull()][System.Management.Automation.ErrorRecord] $ErrorRecord,
    [Parameter(Mandatory)][string] $ExpectedErrorId,
    [AllowNull()][System.Collections.IDictionary] $Diagnostics
  )

  $knownErrorIds = @(
    'Morrow.WindowsNativeProcess.InvalidDescriptor',
    'Morrow.WindowsNativeProcess.IdentityMismatch',
    'Morrow.WindowsNativeProcess.StartFailed',
    'Morrow.WindowsNativeProcess.CleanupIncomplete'
  )
  $knownStages = @(
    'descriptor-validation', 'path-validation', 'path-containment', 'platform-preflight',
    'dependency-preflight', 'system-path-resolution', 'environment-validation',
    'environment-path-validation', 'environment-path-containment', 'executable-hash-validation',
    'identity-dependency', 'suspended-create', 'native-observation', 'cim-observation', 'job-membership',
    'identity-comparison', 'capsule-create', 'resume', 'cleanup'
  )
  $knownFields = @(
    'executablePath', 'executableSha256', 'argumentList', 'workingDirectory', 'profilePath',
    'environment', 'expectedParentProcessId', 'expectedOwnerSid', 'SYSTEMROOT', 'WINDIR',
    'PATH', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'processId',
    'parentProcessId', 'creationTimeUtc', 'ownerSid', 'state', 'membership', 'jobPolicy',
    'resumeResult', 'RUNNER_TEMP'
  )
  $exceptionType = $null
  $exceptionHResult = $null
  $errorCategoryCode = $null
  $observedFqIdPrefix = 'no-error'
  $observedErrorId = $null
  $fullyQualifiedErrorId = ''
  if ($null -ne $ErrorRecord) {
    $exceptionType = $ErrorRecord.Exception.GetType().FullName
    $exceptionHResult = [int64]$ErrorRecord.Exception.HResult
    $errorCategoryCode = [int]$ErrorRecord.CategoryInfo.Category
    $fullyQualifiedErrorId = [string]$ErrorRecord.FullyQualifiedErrorId
    $fqIdSeparator = $fullyQualifiedErrorId.IndexOf(',')
    $fqIdToken = if ($fqIdSeparator -ge 0) { $fullyQualifiedErrorId.Substring(0, $fqIdSeparator) } else { $fullyQualifiedErrorId }
    if ($fqIdToken -in $knownErrorIds) {
      $observedFqIdPrefix = $fqIdToken
    } elseif ($fqIdToken -in @('RuntimeException', 'MethodInvocationException', 'InvalidOperation', 'ActionPreferenceStopException')) {
      $observedFqIdPrefix = $fqIdToken
    } else {
      $observedFqIdPrefix = 'unclassified'
    }
    $dataErrorId = Get-PolicyErrorId -Exception $ErrorRecord.Exception
    if ($dataErrorId -in $knownErrorIds) { $observedErrorId = $dataErrorId }
  }

  $diagnosticStage = $null
  $diagnosticCause = $null
  $diagnosticOriginalErrorId = $null
  $diagnosticFields = [Collections.Generic.List[string]]::new()
  $unrecognizedFieldCount = 0
  $cleanup = $null
  if ($Diagnostics -is [System.Collections.IDictionary]) {
    if ($Diagnostics.Contains('stage') -and ([string]$Diagnostics['stage']) -in $knownStages) {
      $diagnosticStage = [string]$Diagnostics['stage']
    }
    if ($Diagnostics.Contains('cause') -and ([string]$Diagnostics['cause']) -in $knownErrorIds) {
      $diagnosticCause = [string]$Diagnostics['cause']
    }
    if ($Diagnostics.Contains('originalErrorId') -and ([string]$Diagnostics['originalErrorId']) -in $knownErrorIds) {
      $diagnosticOriginalErrorId = [string]$Diagnostics['originalErrorId']
    }
    if ($Diagnostics.Contains('fields')) {
      foreach ($field in @($Diagnostics['fields'])) {
        if ($field -is [string] -and $field -in $knownFields) {
          [void]$diagnosticFields.Add([string]$field)
        } else {
          $unrecognizedFieldCount++
        }
      }
    }
    if ($Diagnostics.Contains('cleanup') -and $Diagnostics['cleanup'] -is [System.Collections.IDictionary]) {
      $rawCleanup = $Diagnostics['cleanup']
      $cleanup = [ordered]@{}
      foreach ($name in @('attempted', 'jobEmpty', 'rootExited', 'disposeFailed')) {
        $cleanup[$name] = if ($rawCleanup.Contains($name) -and $rawCleanup[$name] -is [bool]) {
          [bool]$rawCleanup[$name]
        } else {
          $null
        }
      }
    }
  }

  return [pscustomobject][ordered]@{
    scenario = 'expected-policy-failure-observed'
    expectedErrorId = $ExpectedErrorId
    observedFqIdPrefix = $observedFqIdPrefix
    observedErrorId = $observedErrorId
    exceptionType = $exceptionType
    exceptionHResult = $exceptionHResult
    errorCategoryCode = $errorCategoryCode
    diagnosticStage = $diagnosticStage
    diagnosticCause = $diagnosticCause
    diagnosticOriginalErrorId = $diagnosticOriginalErrorId
    diagnosticFields = @($diagnosticFields)
    unrecognizedFieldCount = $unrecognizedFieldCount
    cleanup = $cleanup
  }
}

function Invoke-ExpectedPolicyFailure {
  param(
    [Parameter(Mandatory)][scriptblock] $Action,
    [Parameter(Mandatory)][string] $ExpectedErrorId,
    [string[]] $ExpectedFields = @(),
    [switch] $RequireCompletedCleanup
  )

  $errorRecord = $null
  $verboseRecords = [Collections.Generic.List[string]]::new()
  try {
    $output = @(& $Action 4>&1)
    foreach ($item in $output) {
      if ($item -is [System.Management.Automation.VerboseRecord]) {
        [void]$verboseRecords.Add([string]$item.Message)
      } elseif ($null -ne ('Morrow.Pilot.WindowsNativeProcessCapsule' -as [type]) -and
          ('Morrow.Pilot.WindowsNativeProcessCapsule' -as [type]).IsInstanceOfType($item)) {
        try {
          $unexpectedCleanup = $item.Dispose()
          $script:allNativeJobsCleaned = [bool]$unexpectedCleanup.jobEmpty -and [bool]$unexpectedCleanup.rootExited
        } catch {
          $script:allNativeJobsCleaned = $false
        }
      }
    }
  } catch {
    $errorRecord = $_
  }
  $diagnostics = if ($null -ne $errorRecord) { Get-PolicyDiagnostics -Exception $errorRecord.Exception } else { $null }
  [void]$script:observations.Add((New-SanitizedPolicyFailureObservation `
    -ErrorRecord $errorRecord -ExpectedErrorId $ExpectedErrorId -Diagnostics $diagnostics))
  if ($null -eq $errorRecord) { throw "Expected error was not raised: $ExpectedErrorId" }
  $fullyQualifiedErrorId = [string]$errorRecord.FullyQualifiedErrorId
  if ($fullyQualifiedErrorId -cne $ExpectedErrorId -and
      $fullyQualifiedErrorId -cne ($ExpectedErrorId + ',Start-WindowsNativeProcess')) {
    throw "Unexpected policy error category for expected $ExpectedErrorId."
  }

  if ($null -eq $diagnostics) { throw 'Policy error did not include its sanitized diagnostics DTO.' }
  foreach ($field in $ExpectedFields) {
    if (@($diagnostics['fields']) -cnotcontains $field) { throw "Policy diagnostics omitted expected field: $field" }
  }
  $cleanup = if ($diagnostics -is [System.Collections.IDictionary]) { $diagnostics['cleanup'] } else { $null }
  if ($RequireCompletedCleanup) {
    if ($null -eq $cleanup -or -not [bool]$cleanup['attempted'] -or
        -not [bool]$cleanup['jobEmpty'] -or -not [bool]$cleanup['rootExited']) {
      throw 'Policy mismatch did not prove Job-empty/root-exited cleanup.'
    }
  }

  return [pscustomobject]@{
    errorId = [string]$ExpectedErrorId
    stage = [string]$diagnostics['stage']
    fields = @($diagnostics['fields'])
    cleanup = $cleanup
    verboseMessages = @($verboseRecords)
  }
}

function Copy-PolicyDescriptor {
  param([Parameter(Mandatory)][System.Collections.IDictionary] $Descriptor)

  $copy = [ordered]@{}
  foreach ($key in $Descriptor.Keys) { $copy.Add([string]$key, $Descriptor[$key]) }
  return $copy
}

function Copy-PolicyEnvironment {
  param([Parameter(Mandatory)][System.Collections.IDictionary] $Environment)

  $copy = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($key in $Environment.Keys) { $copy.Add([string]$key, [string]$Environment[$key]) }
  return $copy
}

function Test-PolicyPathUnder {
  param(
    [Parameter(Mandatory)][string] $Path,
    [Parameter(Mandatory)][string] $Root
  )

  $relative = [IO.Path]::GetRelativePath($Root, $Path)
  return -not ([string]::IsNullOrWhiteSpace($relative) -or $relative -eq '.' -or
    [IO.Path]::IsPathRooted($relative) -or $relative -eq '..' -or
    $relative.StartsWith('..\', [StringComparison]::Ordinal) -or
    $relative.StartsWith('../', [StringComparison]::Ordinal))
}

function Wait-PolicyFile {
  param(
    [Parameter(Mandatory)][string] $Path,
    [Parameter(Mandatory)][int] $TimeoutSeconds
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ([IO.File]::Exists($Path)) { return $true }
    Start-Sleep -Milliseconds 100
  }
  return [IO.File]::Exists($Path)
}

function New-PolicyDescriptor {
  param(
    [Parameter(Mandatory)][int] $ParentProcessId,
    [Parameter(Mandatory)][string] $OwnerSid,
    [Parameter(Mandatory)][string] $ReceiptPath,
    [Parameter(Mandatory)][string] $MarkerPath,
    [Parameter(Mandatory)][string] $UnicodeArgument,
    [Parameter(Mandatory)][string] $PersonalCanaryName
  )

  $pathValue = $environment['SYSTEMROOT'] + '\System32;' + [IO.Path]::GetDirectoryName($pwshPath)
  return [ordered]@{
    executablePath = $pwshPath
    executableSha256 = $pwshHash.ToUpperInvariant()
    argumentList = [object[]]@(
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      $childScriptPath, $ReceiptPath, $MarkerPath, $profilePath,
      [string]$environment['APPDATA'], [string]$environment['LOCALAPPDATA'],
      [string]$environment['TEMP'], $pathValue, $runtimeRoot, $UnicodeArgument, $PersonalCanaryName
    )
    workingDirectory = $runtimeRoot
    profilePath = $profilePath
    environment = $environment
    expectedParentProcessId = $ParentProcessId
    expectedOwnerSid = $OwnerSid
  }
}

function Get-PolicyCimFailureCategory {
  param([Parameter(Mandatory)][Exception] $Exception)

  $current = $Exception
  for ($depth = 0; $null -ne $current -and $depth -lt 8; $depth++) {
    switch ($current.GetType().FullName) {
      'Microsoft.Management.Infrastructure.CimException' { return 'cim' }
      'System.UnauthorizedAccessException' { return 'access-denied' }
      'System.InvalidOperationException' { return 'invalid-operation' }
      'System.FormatException' { return 'format' }
      'System.IO.IOException' { return 'io' }
      'System.Management.Automation.ActionPreferenceStopException' { return 'action-preference-stop' }
      'System.Management.Automation.RuntimeException' { return 'runtime' }
    }
    $current = $current.InnerException
  }
  return 'other'
}

function Set-PolicyCimProbeFailure {
  param(
    [Parameter(Mandatory)][System.Collections.IDictionary] $Observation,
    [Parameter(Mandatory)][string] $Stage,
    [Parameter(Mandatory)][string] $Category
  )

  if ($Observation['failureStage'] -ceq 'none') {
    $Observation['failureStage'] = $Stage
    $Observation['failureCategory'] = $Category
  }
}

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'The own process-policy suite requires Windows.' }
  if ([string]::IsNullOrWhiteSpace($runnerTemp) -or -not [IO.Directory]::Exists($runnerTemp)) { throw 'RUNNER_TEMP is unavailable.' }

  $capsuleTypeWasLoaded = $null -ne ('Morrow.Pilot.WindowsNativeProcessCapsule' -as [type])
  $nativeTypeWasLoaded = $null -ne ('Morrow.Pilot.WindowsNativeJobInterop' -as [type])
  . $policyPath
  $checks.dotSourceHasNoInteropSideEffects = (
    -not $capsuleTypeWasLoaded -and -not $nativeTypeWasLoaded -and
    $null -eq ('Morrow.Pilot.WindowsNativeProcessCapsule' -as [type]) -and
    $null -eq ('Morrow.Pilot.WindowsNativeJobInterop' -as [type])
  )
  Assert-PolicyCheck -Condition $checks.dotSourceHasNoInteropSideEffects -Name 'dotSourceHasNoInteropSideEffects'

  . $processHelperPath
  . $nativeJobHelperPath

  $runnerTemp = ConvertTo-PilotCanonicalPath -Path $runnerTemp
  $personalCanaryName = 'MORROW_ISSUE225_PARENT_CANARY_' + $runId.ToUpperInvariant()
  $parentEnvironment = [Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::Process)
  foreach ($entry in $parentEnvironment.GetEnumerator()) {
    if ([string]::Equals([string]$entry.Key, $personalCanaryName, [StringComparison]::OrdinalIgnoreCase)) {
      $personalCanaryOriginalPresent = $true
      $personalCanaryOriginalValue = [string]$entry.Value
      break
    }
  }
  $personalCanarySetAttempted = $true
  [Environment]::SetEnvironmentVariable($personalCanaryName, $secretSentinel, [EnvironmentVariableTarget]::Process)
  $checks.parentCanaryWasInjected = [string]::Equals(
    [Environment]::GetEnvironmentVariable($personalCanaryName, [EnvironmentVariableTarget]::Process),
    $secretSentinel,
    [StringComparison]::Ordinal
  )
  Assert-PolicyCheck -Condition $checks.parentCanaryWasInjected -Name 'parentCanaryWasInjected'

  $evidenceCandidate = ConvertTo-PilotCanonicalPath -Path $EvidenceRoot -AllowMissing
  $privateRoot = Join-Path $runnerTemp ('morrow-issue-225-' + $runId)
  $evidenceParent = [IO.Path]::GetDirectoryName($evidenceCandidate)
  if ([string]::IsNullOrWhiteSpace($evidenceParent) -or -not [IO.Directory]::Exists($evidenceParent)) {
    throw 'EvidenceRoot parent must already exist.'
  }
  $evidenceParent = ConvertTo-PilotCanonicalPath -Path $evidenceParent
  if (-not [string]::Equals($evidenceParent, $runnerTemp, [StringComparison]::OrdinalIgnoreCase)) {
    [void](Get-PilotTemporaryPathProof -Path $evidenceParent -RunnerTemp $runnerTemp)
  }
  if (-not (Test-PolicyPathUnder -Path $evidenceCandidate -Root $runnerTemp)) {
    throw 'EvidenceRoot must be a child of RUNNER_TEMP.'
  }
  if ([string]::Equals($evidenceCandidate, $privateRoot, [StringComparison]::OrdinalIgnoreCase) -or
      (Test-PolicyPathUnder -Path $evidenceCandidate -Root $privateRoot) -or
      (Test-PolicyPathUnder -Path $privateRoot -Root $evidenceCandidate)) {
    throw 'EvidenceRoot and private runtime staging must be distinct paths.'
  }
  if ([IO.Directory]::Exists($evidenceCandidate) -or [IO.File]::Exists($evidenceCandidate)) {
    throw 'EvidenceRoot must be a new dedicated directory.'
  }
  [void][IO.Directory]::CreateDirectory($evidenceCandidate)
  $evidenceRootCreated = $true
  $evidenceFullPath = ConvertTo-PilotCanonicalPath -Path $evidenceCandidate
  [void](Get-PilotTemporaryPathProof -Path $evidenceFullPath -RunnerTemp $runnerTemp)

  [void][IO.Directory]::CreateDirectory($privateRoot)
  $privateRootCreated = $true
  $privateRoot = ConvertTo-PilotCanonicalPath -Path $privateRoot
  [void](Get-PilotTemporaryPathProof -Path $privateRoot -RunnerTemp $runnerTemp)
  if ((Test-PolicyPathUnder -Path $privateRoot -Root $evidenceFullPath) -or
      (Test-PolicyPathUnder -Path $evidenceFullPath -Root $privateRoot)) {
    throw 'EvidenceRoot and private runtime staging overlap.'
  }
  $ownerMarker = Join-Path $privateRoot '.issue-225-owner'
  [IO.File]::WriteAllText($ownerMarker, $runId, [Text.UTF8Encoding]::new($false))

  $runtimeRoot = Join-Path $privateRoot 'runtime-ação-雪'
  $profilePath = Join-Path $privateRoot 'profile-ação-雪'
  $appDataPath = Join-Path $profilePath 'AppData\Roaming'
  $localAppDataPath = Join-Path $profilePath 'AppData\Local'
  $tempPath = Join-Path $localAppDataPath 'Temp'
  foreach ($directory in @($runtimeRoot, $appDataPath, $tempPath)) {
    [void][IO.Directory]::CreateDirectory($directory)
  }

  $failurePhase = 'runtime-staging'
  foreach ($item in (Get-ChildItem -LiteralPath $PSHOME -Force -ErrorAction Stop)) {
    Copy-Item -LiteralPath $item.FullName -Destination $runtimeRoot -Recurse -Force -ErrorAction Stop
  }
  $pwshPath = Join-Path $runtimeRoot 'pwsh.exe'
  if (-not [IO.File]::Exists($pwshPath)) { throw 'The staged PowerShell runtime has no pwsh.exe.' }
  $pwshPath = ConvertTo-PilotCanonicalPath -Path $pwshPath
  [void](Get-PilotTemporaryPathProof -Path $pwshPath -RunnerTemp $runnerTemp)
  $pwshHash = (Get-FileHash -LiteralPath $pwshPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
  $checks.stagedRuntimeOutsideEvidenceRoot = (
    (Test-PolicyPathUnder -Path $pwshPath -Root $runnerTemp) -and
    -not (Test-PolicyPathUnder -Path $pwshPath -Root $evidenceFullPath) -and
    -not (Test-PolicyPathUnder -Path $evidenceFullPath -Root $privateRoot)
  )
  Assert-PolicyCheck -Condition $checks.stagedRuntimeOutsideEvidenceRoot -Name 'stagedRuntimeOutsideEvidenceRoot'

  $windowsDirectory = ConvertTo-PilotCanonicalPath -Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Windows))
  $system32 = ConvertTo-PilotCanonicalPath -Path (Join-Path $windowsDirectory 'System32')
  $environment = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
  $environment.Add('SYSTEMROOT', $windowsDirectory)
  $environment.Add('WINDIR', $windowsDirectory)
  $environment.Add('PATH', ($system32 + ';' + $runtimeRoot))
  $environment.Add('USERPROFILE', $profilePath)
  $environment.Add('APPDATA', $appDataPath)
  $environment.Add('LOCALAPPDATA', $localAppDataPath)
  $environment.Add('TEMP', $tempPath)
  $environment.Add('TMP', $tempPath)
  $environment.Add('HOME', $profilePath)
  $identitySid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value

  $childScriptPath = Join-Path $privateRoot 'child-fixture.ps1'
  $childSource = @'
param(
  [string] $ReceiptPath,
  [string] $MarkerPath,
  [string] $ExpectedProfile,
  [string] $ExpectedAppData,
  [string] $ExpectedLocalAppData,
  [string] $ExpectedTemp,
  [string] $ExpectedPath,
  [string] $ExpectedProcessDirectory,
  [string] $ExpectedUnicodeArgument,
  [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string] $PersonalCanaryName
)

$variables = [Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::Process)
$credentialLikeNames = [Collections.Generic.List[string]]::new()
foreach ($key in $variables.Keys) {
  if ([string]$key -match '(?i)^(GITHUB_|ACTIONS_)' -or [string]$key -match '(?i)(TOKEN|SECRET|CREDENTIAL|AUTH)') {
    [void]$credentialLikeNames.Add([string]$key)
  }
}
$personalCanary = [Environment]::GetEnvironmentVariable($PersonalCanaryName, [EnvironmentVariableTarget]::Process)
$processPath = [Environment]::ProcessPath
$processDirectory = if ([string]::IsNullOrWhiteSpace($processPath)) { '' } else { [IO.Path]::GetDirectoryName($processPath) }
$effectiveExpectedPath = $processDirectory + [IO.Path]::PathSeparator + $ExpectedPath
$stagedProcessDirectoryMatches = [string]::Equals($processDirectory, $ExpectedProcessDirectory, [StringComparison]::OrdinalIgnoreCase)
$reportLines = @(
  ('unicodeArgumentMatches=' + ([bool]($ExpectedUnicodeArgument -ceq 'ação com espaço 雪')).ToString().ToLowerInvariant()),
  ('userProfileMatches=' + ([bool]($env:USERPROFILE -ceq $ExpectedProfile)).ToString().ToLowerInvariant()),
  ('homeMatches=' + ([bool]($env:HOME -ceq $ExpectedProfile)).ToString().ToLowerInvariant()),
  ('appDataMatches=' + ([bool]($env:APPDATA -ceq $ExpectedAppData)).ToString().ToLowerInvariant()),
  ('localAppDataMatches=' + ([bool]($env:LOCALAPPDATA -ceq $ExpectedLocalAppData)).ToString().ToLowerInvariant()),
  ('tempMatches=' + ([bool]($env:TEMP -ceq $ExpectedTemp)).ToString().ToLowerInvariant()),
  ('tmpMatches=' + ([bool]($env:TMP -ceq $ExpectedTemp)).ToString().ToLowerInvariant()),
  ('pathMatches=' + ([bool]($env:PATH -ceq $effectiveExpectedPath)).ToString().ToLowerInvariant()),
  ('stagedProcessDirectoryMatches=' + ([bool]$stagedProcessDirectoryMatches).ToString().ToLowerInvariant()),
  ('personalCanaryAbsent=' + ([bool]($null -eq $personalCanary)).ToString().ToLowerInvariant()),
  ('credentialLikeEnvironmentAbsent=' + ([bool]($credentialLikeNames.Count -eq 0)).ToString().ToLowerInvariant())
)
[IO.File]::WriteAllLines($ReceiptPath, [string[]]$reportLines, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($MarkerPath, 'started', [Text.UTF8Encoding]::new($false))
[Threading.Thread]::Sleep(120000)
'@
  [IO.File]::WriteAllText($childScriptPath, $childSource, [Text.UTF8Encoding]::new($false))

  $baseDescriptor = New-PolicyDescriptor `
    -ParentProcessId ([int]$PID) `
    -OwnerSid $identitySid `
    -ReceiptPath (Join-Path $privateRoot 'happy.receipt') `
    -MarkerPath (Join-Path $privateRoot 'happy.marker') `
    -UnicodeArgument 'ação com espaço 雪' `
    -PersonalCanaryName $personalCanaryName

  $syntheticIdentityTime = [DateTime]::UtcNow
  $syntheticIdentityNative = [pscustomobject]@{
    processId = [int]$PID
    executablePath = $pwshPath
    creationTimeUtc = $syntheticIdentityTime.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
  }
  $syntheticIdentityOwner = [pscustomobject]@{ ReturnValue = [uint32]0; Sid = $identitySid }
  $syntheticImageProof = Get-PilotWindowsNativeProcessImageProof `
    -NativeObservation $syntheticIdentityNative -ExpectedExecutablePath $pwshPath -ExpectedHash $pwshHash
  $syntheticIdentityRow = [pscustomobject]@{
    ProcessId = [int]$PID
    ParentProcessId = [int]$PID
    CreationDate = $syntheticIdentityTime
    ExecutablePath = $null
  }
  $identityTestArguments = @{
    ProcessRow = $syntheticIdentityRow
    OwnerResult = $syntheticIdentityOwner
    NativeObservation = $syntheticIdentityNative
    ImageProof = $syntheticImageProof
  }
  $identityFields = @('processId', 'parentProcessId', 'creationTimeUtc', 'executablePath', 'executableSha256', 'ownerSid')
  $syntheticNullPathIdentity = New-PilotWindowsNativeProcessIdentityFromCim @identityTestArguments
  $identityTestArguments.ProcessRow = [pscustomobject]@{
    ProcessId = [int]$PID
    ParentProcessId = [int]$PID
    CreationDate = $syntheticIdentityTime
    ExecutablePath = ''
  }
  $syntheticEmptyPathIdentity = New-PilotWindowsNativeProcessIdentityFromCim @identityTestArguments
  $syntheticNullPathFields = @($syntheticNullPathIdentity.PSObject.Properties.Name | Sort-Object)
  $syntheticEmptyPathFields = @($syntheticEmptyPathIdentity.PSObject.Properties.Name | Sort-Object)
  $expectedIdentityFields = @($identityFields | Sort-Object)
  $checks.cimPathNullAndEmptyAccepted = (
    [string]::Equals([string]$syntheticNullPathIdentity.executablePath, $pwshPath, [StringComparison]::OrdinalIgnoreCase) -and
    [string]::Equals([string]$syntheticEmptyPathIdentity.executablePath, $pwshPath, [StringComparison]::OrdinalIgnoreCase) -and
    [string]::Join('|', $syntheticNullPathFields) -ceq [string]::Join('|', $expectedIdentityFields) -and
    [string]::Join('|', $syntheticEmptyPathFields) -ceq [string]::Join('|', $expectedIdentityFields)
  )
  Assert-PolicyCheck -Condition $checks.cimPathNullAndEmptyAccepted -Name 'cimPathNullAndEmptyAccepted'

  $identityTestArguments.ProcessRow = [pscustomobject]@{
    ProcessId = [int]$PID
    ParentProcessId = [int]$PID
    CreationDate = $syntheticIdentityTime.AddTicks(20)
    ExecutablePath = $pwshPath
  }
  $syntheticPresentPathIdentity = New-PilotWindowsNativeProcessIdentityFromCim @identityTestArguments
  $checks.cimPathPresentCorroborated = [string]::Equals([string]$syntheticPresentPathIdentity.executablePath, $pwshPath, [StringComparison]::OrdinalIgnoreCase)
  Assert-PolicyCheck -Condition $checks.cimPathPresentCorroborated -Name 'cimPathPresentCorroborated'

  $identityTestArguments.ProcessRow = [pscustomobject]@{
    ProcessId = [int]$PID
    ParentProcessId = [int]$PID
    CreationDate = $syntheticIdentityTime
    ExecutablePath = '\\invalid-host\not-read.exe'
  }
  $checks.cimPathMalformedRejected = Test-PolicyIdentityFailure -ExpectedField 'executablePath' -Action { New-PilotWindowsNativeProcessIdentityFromCim @identityTestArguments }
  Assert-PolicyCheck -Condition $checks.cimPathMalformedRejected -Name 'cimPathMalformedRejected'

  $identityTestArguments.ProcessRow.ExecutablePath = ' '
  $checks.cimPathWhitespaceRejected = Test-PolicyIdentityFailure -ExpectedField 'executablePath' -Action { New-PilotWindowsNativeProcessIdentityFromCim @identityTestArguments }
  Assert-PolicyCheck -Condition $checks.cimPathWhitespaceRejected -Name 'cimPathWhitespaceRejected'

  $identityTestArguments.ProcessRow.ExecutablePath = $childScriptPath
  $checks.cimPathMismatchRejected = Test-PolicyIdentityFailure -ExpectedField 'executablePath' -Action { New-PilotWindowsNativeProcessIdentityFromCim @identityTestArguments }
  Assert-PolicyCheck -Condition $checks.cimPathMismatchRejected -Name 'cimPathMismatchRejected'

  $mismatchedNativeImage = [pscustomobject]@{
    processId = [int]$PID
    executablePath = $childScriptPath
    creationTimeUtc = $syntheticIdentityNative.creationTimeUtc
  }
  $checks.nativeImageMismatchRejected = Test-PolicyIdentityFailure -ExpectedField 'executablePath' -Action {
    Get-PilotWindowsNativeProcessImageProof -NativeObservation $mismatchedNativeImage -ExpectedExecutablePath $pwshPath -ExpectedHash $pwshHash
  }
  Assert-PolicyCheck -Condition $checks.nativeImageMismatchRejected -Name 'nativeImageMismatchRejected'

  $checks.cimRowMissingRejected = Test-PolicyIdentityFailure -ExpectedField 'processId' -Action {
    Get-PilotWindowsNativeProcessCimRow -ProcessRows ([object[]]@()) -ProcessId ([int]$PID)
  }
  Assert-PolicyCheck -Condition $checks.cimRowMissingRejected -Name 'cimRowMissingRejected'
  $checks.cimRowsAmbiguousRejected = Test-PolicyIdentityFailure -ExpectedField 'processId' -Action {
    Get-PilotWindowsNativeProcessCimRow -ProcessRows ([object[]]@($syntheticIdentityRow, $syntheticIdentityRow)) -ProcessId ([int]$PID)
  }
  Assert-PolicyCheck -Condition $checks.cimRowsAmbiguousRejected -Name 'cimRowsAmbiguousRejected'

  $identityTestArguments.ProcessRow = [pscustomobject]@{
    ProcessId = [int]$PID
    ParentProcessId = [int]$PID
    CreationDate = $syntheticIdentityTime
    ExecutablePath = $null
  }
  $checks.cimPidMismatchRejected = Test-PolicyIdentityFailure -ExpectedField 'processId' -Action {
    Get-PilotWindowsNativeProcessCimRow -ProcessRows ([object[]]@([pscustomobject]@{ ProcessId = [int]$PID + 1 })) -ProcessId ([int]$PID)
  }
  Assert-PolicyCheck -Condition $checks.cimPidMismatchRejected -Name 'cimPidMismatchRejected'

  $identityTestArguments.ProcessRow = [pscustomobject]@{
    ProcessId = [int]$PID
    CreationDate = $syntheticIdentityTime
    ExecutablePath = $null
  }
  $checks.cimParentMissingRejected = Test-PolicyIdentityFailure -ExpectedField 'parentProcessId' -Action { New-PilotWindowsNativeProcessIdentityFromCim @identityTestArguments }
  Assert-PolicyCheck -Condition $checks.cimParentMissingRejected -Name 'cimParentMissingRejected'

  $identityTestArguments.ProcessRow = [pscustomobject]@{
    ProcessId = [int]$PID
    ParentProcessId = [int]$PID
    ExecutablePath = $null
  }
  $checks.cimCreationDateMissingRejected = Test-PolicyIdentityFailure -ExpectedField 'creationTimeUtc' -Action { New-PilotWindowsNativeProcessIdentityFromCim @identityTestArguments }
  Assert-PolicyCheck -Condition $checks.cimCreationDateMissingRejected -Name 'cimCreationDateMissingRejected'

  $identityTestArguments.ProcessRow = [pscustomobject]@{
    ProcessId = [int]$PID
    ParentProcessId = [int]$PID
    CreationDate = 'not-a-dmtf-date'
    ExecutablePath = $null
  }
  $checks.cimCreationDateInvalidRejected = Test-PolicyIdentityFailure -ExpectedField 'creationTimeUtc' -Action { New-PilotWindowsNativeProcessIdentityFromCim @identityTestArguments }
  Assert-PolicyCheck -Condition $checks.cimCreationDateInvalidRejected -Name 'cimCreationDateInvalidRejected'

  $identityTestArguments.ProcessRow.CreationDate = $syntheticIdentityTime.AddTicks(21)
  $checks.cimCreationTimeMismatchRejected = Test-PolicyIdentityFailure -ExpectedField 'creationTimeUtc' -Action { New-PilotWindowsNativeProcessIdentityFromCim @identityTestArguments }
  Assert-PolicyCheck -Condition $checks.cimCreationTimeMismatchRejected -Name 'cimCreationTimeMismatchRejected'

  $identityTestArguments.ProcessRow = $syntheticIdentityRow
  $identityTestArguments.OwnerResult = $null
  $checks.cimOwnerMissingRejected = Test-PolicyIdentityFailure -ExpectedField 'ownerSid' -Action { New-PilotWindowsNativeProcessIdentityFromCim @identityTestArguments }
  Assert-PolicyCheck -Condition $checks.cimOwnerMissingRejected -Name 'cimOwnerMissingRejected'

  $identityTestArguments.OwnerResult = [pscustomobject]@{ ReturnValue = $null; Sid = $identitySid }
  $checks.cimOwnerReturnValueMissingRejected = Test-PolicyIdentityFailure -ExpectedField 'ownerSid' -Action { New-PilotWindowsNativeProcessIdentityFromCim @identityTestArguments }
  Assert-PolicyCheck -Condition $checks.cimOwnerReturnValueMissingRejected -Name 'cimOwnerReturnValueMissingRejected'

  $identityTestArguments.OwnerResult = [pscustomobject]@{ ReturnValue = '0'; Sid = $identitySid }
  $checks.cimOwnerReturnValueNonIntegralRejected = Test-PolicyIdentityFailure -ExpectedField 'ownerSid' -Action { New-PilotWindowsNativeProcessIdentityFromCim @identityTestArguments }
  Assert-PolicyCheck -Condition $checks.cimOwnerReturnValueNonIntegralRejected -Name 'cimOwnerReturnValueNonIntegralRejected'

  $identityTestArguments.OwnerResult = [pscustomobject]@{ ReturnValue = [uint32]5; Sid = $identitySid }
  $checks.cimOwnerReturnValueNonzeroRejected = Test-PolicyIdentityFailure -ExpectedField 'ownerSid' -Action { New-PilotWindowsNativeProcessIdentityFromCim @identityTestArguments }
  Assert-PolicyCheck -Condition $checks.cimOwnerReturnValueNonzeroRejected -Name 'cimOwnerReturnValueNonzeroRejected'

  $identityTestArguments.OwnerResult = [pscustomobject]@{ ReturnValue = [uint32]0; Sid = 'not-a-sid' }
  $checks.cimOwnerSidMalformedRejected = Test-PolicyIdentityFailure -ExpectedField 'ownerSid' -Action { New-PilotWindowsNativeProcessIdentityFromCim @identityTestArguments }
  Assert-PolicyCheck -Condition $checks.cimOwnerSidMalformedRejected -Name 'cimOwnerSidMalformedRejected'

  $identityTestArguments.OwnerResult = $syntheticIdentityOwner
  $mismatchedImageHash = '0' * 64
  if ($mismatchedImageHash -ceq $pwshHash) { $mismatchedImageHash = '1' * 64 }
  $checks.postCreateHashMismatchRejected = Test-PolicyIdentityFailure -ExpectedField 'executableSha256' -Action {
    Confirm-PilotWindowsNativeProcessHash -ExpectedHash $pwshHash -ObservedHash $mismatchedImageHash
  }
  Assert-PolicyCheck -Condition $checks.postCreateHashMismatchRejected -Name 'postCreateHashMismatchRejected'

  $failurePhase = 'descriptor-calibration'
  $normalizedEmptyArgv = Get-PilotWindowsNativeProcessDescriptor -Descriptor ([ordered]@{
    executablePath = $baseDescriptor.executablePath
    executableSha256 = $baseDescriptor.executableSha256
    argumentList = [object[]]@()
    workingDirectory = $baseDescriptor.workingDirectory
    profilePath = $baseDescriptor.profilePath
    environment = $baseDescriptor.environment
    expectedParentProcessId = [long]$baseDescriptor.expectedParentProcessId
    expectedOwnerSid = $baseDescriptor.expectedOwnerSid
  })
  Assert-PolicyCheck -Condition ($normalizedEmptyArgv.argumentList.Count -eq 0) -Name 'emptyArgvIsAccepted'

  $null = Invoke-ExpectedPolicyFailure -Action { Start-WindowsNativeProcess -Verbose } -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor'
  $null = Invoke-ExpectedPolicyFailure -Action { Start-WindowsNativeProcess -Descriptor 'scalar' -Verbose } -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor'

  $bad = Copy-PolicyDescriptor -Descriptor $baseDescriptor
  $bad.Add('unexpectedField', $secretSentinel)
  $null = Invoke-ExpectedPolicyFailure -Action { Start-WindowsNativeProcess -Descriptor $bad -Verbose } -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor'

  $duplicateDescriptor = [Collections.Specialized.OrderedDictionary]::new([StringComparer]::Ordinal)
  foreach ($key in $baseDescriptor.Keys) { $duplicateDescriptor.Add([string]$key, $baseDescriptor[$key]) }
  $duplicateDescriptor.Add('EXECUTABLEPATH', $baseDescriptor.executablePath)
  $null = Invoke-ExpectedPolicyFailure -Action { Start-WindowsNativeProcess -Descriptor $duplicateDescriptor -Verbose } -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor'

  $bad = Copy-PolicyDescriptor -Descriptor $baseDescriptor
  $bad.Remove('expectedOwnerSid')
  $null = Invoke-ExpectedPolicyFailure -Action { Start-WindowsNativeProcess -Descriptor $bad -Verbose } -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -ExpectedFields @('expectedOwnerSid')

  $bad = Copy-PolicyDescriptor -Descriptor $baseDescriptor
  $bad.argumentList = [object[]]@('-NoProfile', [int]3)
  $null = Invoke-ExpectedPolicyFailure -Action { Start-WindowsNativeProcess -Descriptor $bad -Verbose } -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -ExpectedFields @('argumentList')

  $bad = Copy-PolicyDescriptor -Descriptor $baseDescriptor
  $bad.argumentList = [string[]]@("bad`0argument")
  $null = Invoke-ExpectedPolicyFailure -Action { Start-WindowsNativeProcess -Descriptor $bad -Verbose } -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -ExpectedFields @('argumentList')

  $bad = Copy-PolicyDescriptor -Descriptor $baseDescriptor
  $bad.executableSha256 = ('0' * 64)
  if ($bad.executableSha256 -ceq $pwshHash) { $bad.executableSha256 = ('1' * 64) }
  $null = Invoke-ExpectedPolicyFailure -Action { Start-WindowsNativeProcess -Descriptor $bad -Verbose } -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -ExpectedFields @('executableSha256')

  $bad = Copy-PolicyDescriptor -Descriptor $baseDescriptor
  $bad.expectedParentProcessId = '1'
  $null = Invoke-ExpectedPolicyFailure -Action { Start-WindowsNativeProcess -Descriptor $bad -Verbose } -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -ExpectedFields @('expectedParentProcessId')

  $bad = Copy-PolicyDescriptor -Descriptor $baseDescriptor
  $bad.expectedParentProcessId = [double]$PID
  $null = Invoke-ExpectedPolicyFailure -Action { Start-WindowsNativeProcess -Descriptor $bad -Verbose } -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -ExpectedFields @('expectedParentProcessId')

  $bad = Copy-PolicyDescriptor -Descriptor $baseDescriptor
  $bad.expectedOwnerSid = 'S-1-5-invalid'
  $null = Invoke-ExpectedPolicyFailure -Action { Start-WindowsNativeProcess -Descriptor $bad -Verbose } -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -ExpectedFields @('expectedOwnerSid')

  $bad = Copy-PolicyDescriptor -Descriptor $baseDescriptor
  $bad.profilePath = $windowsDirectory
  $null = Invoke-ExpectedPolicyFailure -Action { Start-WindowsNativeProcess -Descriptor $bad -Verbose } -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -ExpectedFields @('profilePath')

  $bad = Copy-PolicyDescriptor -Descriptor $baseDescriptor
  $badEnvironment = Copy-PolicyEnvironment -Environment $baseDescriptor.environment
  $badEnvironment.Add('GITHUB_TOKEN', $secretSentinel)
  $bad.environment = $badEnvironment
  $null = Invoke-ExpectedPolicyFailure -Action { Start-WindowsNativeProcess -Descriptor $bad -Verbose } -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -ExpectedFields @('environment')

  $bad = Copy-PolicyDescriptor -Descriptor $baseDescriptor
  $duplicateEnvironment = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal)
  foreach ($key in $baseDescriptor.environment.Keys) { $duplicateEnvironment.Add([string]$key, [string]$baseDescriptor.environment[$key]) }
  $duplicateEnvironment.Add('path', [string]$baseDescriptor.environment['PATH'])
  $bad.environment = $duplicateEnvironment
  $null = Invoke-ExpectedPolicyFailure -Action { Start-WindowsNativeProcess -Descriptor $bad -Verbose } -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -ExpectedFields @('environment')

  $semicolonExeDirectory = Join-Path $privateRoot 'runtime;path-injection'
  [void][IO.Directory]::CreateDirectory($semicolonExeDirectory)
  $semicolonExePath = Join-Path $semicolonExeDirectory 'placeholder.exe'
  [IO.File]::WriteAllBytes($semicolonExePath, [byte[]]@(0x4d, 0x5a, 0x01))
  $bad = Copy-PolicyDescriptor -Descriptor $baseDescriptor
  $bad.executablePath = $semicolonExePath
  $bad.executableSha256 = (Get-FileHash -LiteralPath $semicolonExePath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
  $bad.environment = Copy-PolicyEnvironment -Environment $baseDescriptor.environment
  $bad.environment['PATH'] = $system32 + ';' + $semicolonExeDirectory
  $null = Invoke-ExpectedPolicyFailure -Action { Start-WindowsNativeProcess -Descriptor $bad -Verbose } `
    -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -ExpectedFields @('executablePath')
  $checks.rejectsSemicolonInStagedExeDirectory = $true

  $junctionPath = Join-Path $privateRoot 'reparse-to-runtime'
  New-Item -ItemType Junction -Path $junctionPath -Target $runtimeRoot -ErrorAction Stop | Out-Null
  $bad = Copy-PolicyDescriptor -Descriptor $baseDescriptor
  $bad.workingDirectory = $junctionPath
  $null = Invoke-ExpectedPolicyFailure -Action { Start-WindowsNativeProcess -Descriptor $bad -Verbose } -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -ExpectedFields @('workingDirectory')
  [IO.Directory]::Delete($junctionPath, $false)
  $junctionPath = $null

  $checks.descriptorIsClosedAndStrict = $true
  $checks.rejectsReparseAndOutsidePaths = $true
  $checks.invalidDescriptorsLaunchNothing = (
    -not [IO.File]::Exists((Join-Path $privateRoot 'happy.marker')) -and
    -not [IO.File]::Exists((Join-Path $privateRoot 'happy.receipt'))
  )
  Assert-PolicyCheck -Condition $checks.descriptorIsClosedAndStrict -Name 'descriptorIsClosedAndStrict'
  Assert-PolicyCheck -Condition $checks.rejectsReparseAndOutsidePaths -Name 'rejectsReparseAndOutsidePaths'
  Assert-PolicyCheck -Condition $checks.rejectsSemicolonInStagedExeDirectory -Name 'rejectsSemicolonInStagedExeDirectory'
  Assert-PolicyCheck -Condition $checks.invalidDescriptorsLaunchNothing -Name 'invalidDescriptorsLaunchNothing'

  $failurePhase = 'outsider-start'
  $outsiderReceipt = Join-Path $privateRoot 'outsider.receipt'
  $outsiderMarker = Join-Path $privateRoot 'outsider.marker'
  $outsiderInfo = [Diagnostics.ProcessStartInfo]::new()
  $outsiderInfo.FileName = $pwshPath
  $outsiderInfo.WorkingDirectory = $runtimeRoot
  $outsiderInfo.UseShellExecute = $false
  $outsiderInfo.CreateNoWindow = $true
  $outsiderInfo.Environment.Clear()
  foreach ($key in $environment.Keys) { $outsiderInfo.Environment[[string]$key] = [string]$environment[$key] }
  foreach ($argument in @(
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      $childScriptPath, $outsiderReceipt, $outsiderMarker, $profilePath,
      [string]$environment['APPDATA'], [string]$environment['LOCALAPPDATA'],
      [string]$environment['TEMP'], ($environment['SYSTEMROOT'] + '\System32;' + $runtimeRoot), $runtimeRoot, 'outsider Unicode 雪', $personalCanaryName
    )) { $outsiderInfo.ArgumentList.Add([string]$argument) }
  $outsider = [Diagnostics.Process]::Start($outsiderInfo)
  if ($null -eq $outsider) {
    throw 'The synthetic outsider did not start.'
  }
  $outsiderExited = $false
  if (-not (Wait-PolicyFile -Path $outsiderMarker -TimeoutSeconds 15)) {
    throw 'The synthetic outsider did not start.'
  }

  $failurePhase = 'suspended-cim-diagnostic'
  $cimDiagnosticMarkerPath = Join-Path $privateRoot 'cim-diagnostic.marker'
  $cimDiagnosticObservation = [ordered]@{
    scenario = 'suspended-cim-step-diagnostic'
    probeState = 'probe-failed'
    failureStage = 'none'
    failureCategory = 'none'
    cimRowState = 'not-observed'
    cimProcessIdMatches = $null
    cimParentMatchesTestProcess = $null
    cimExecutablePathPresent = $null
    cimExecutablePathDisposition = 'not-observed'
    cimExecutablePathMatchesNative = $null
    cimExecutablePathMatchesStaged = $null
    cimCreationDateKind = 'not-observed'
    cimCreationTimeMatchesNativeWithin20Ticks = $null
    cimHashMatchesExpected = $null
    ownerMethodStatus = 'not-observed'
    ownerReturnValue = $null
    ownerMatchesCurrentUser = $null
    rootCreationAttempted = $false
    rootSessionRetained = $false
    rootSuspendedBefore = $false
    rootMemberBefore = $false
    rootSuspendedAfter = $false
    rootMemberAfter = $false
    cleanupJobEmpty = $null
    cleanupRootExited = $null
    cleanupDisposeStatus = 'not-attempted'
    cleanupConfirmed = $false
    markerAbsent = $false
    outsiderAliveAfterProbe = $false
  }
  $cimDiagnosticSession = $null
  $cimDiagnosticCleanupConfirmed = $false
  try {
    $probeDescriptor = Copy-PolicyDescriptor -Descriptor $baseDescriptor
    $probeArguments = [Collections.Generic.List[string]]::new()
    foreach ($argument in [string[]]$baseDescriptor.argumentList) { $probeArguments.Add([string]$argument) }
    $probeArguments[7] = Join-Path $privateRoot 'cim-diagnostic-child.receipt'
    $probeArguments[8] = $cimDiagnosticMarkerPath
    $probeDescriptor.argumentList = $probeArguments.ToArray()

    $cimDiagnosticObservation.rootCreationAttempted = $true
    $cimDiagnosticSession = CreateAtomicSuspendedRoot `
      -ExecutablePath $pwshPath `
      -ArgumentList ([string[]]$probeDescriptor.argumentList) `
      -Environment $environment `
      -WorkingDirectory $runtimeRoot
    $cimDiagnosticObservation.rootSessionRetained = $null -ne $cimDiagnosticSession
    $allNativeJobsCleaned = $false
    $nativeBeforeProbe = $cimDiagnosticSession.ObserveRoot()
    $membersBeforeProbe = @($cimDiagnosticSession.ListMemberIds())
    $cimDiagnosticObservation.rootSuspendedBefore = [string]$nativeBeforeProbe.state -ceq 'suspended'
    foreach ($memberId in $membersBeforeProbe) {
      if ([uint32]$memberId -eq [uint32]$nativeBeforeProbe.processId) { $cimDiagnosticObservation.rootMemberBefore = $true; break }
    }
    if (-not $cimDiagnosticObservation.rootSuspendedBefore -or -not $cimDiagnosticObservation.rootMemberBefore) {
      throw 'The diagnostic root did not remain suspended in its private Job.'
    }

    try {
      $filter = 'ProcessId = ' + [string][int]$nativeBeforeProbe.processId
      $processes = @(Get-CimInstance -ClassName Win32_Process -Filter $filter -OperationTimeoutSec 5 -ErrorAction Stop)
      if ($processes.Count -eq 0) {
        $cimDiagnosticObservation.cimRowState = 'zero'
        Set-PolicyCimProbeFailure -Observation $cimDiagnosticObservation -Stage 'cim-cardinality' -Category 'zero-rows'
      } elseif ($processes.Count -eq 1) {
        $cimDiagnosticObservation.cimRowState = 'one'
      } else {
        $cimDiagnosticObservation.cimRowState = 'multiple'
        Set-PolicyCimProbeFailure -Observation $cimDiagnosticObservation -Stage 'cim-cardinality' -Category 'multiple-rows'
      }
    } catch {
      $processes = @()
      $cimDiagnosticObservation.cimRowState = 'query-failed'
      Set-PolicyCimProbeFailure -Observation $cimDiagnosticObservation -Stage 'cim-query' -Category (Get-PolicyCimFailureCategory -Exception $_.Exception)
    }

    if ($processes.Count -eq 1) {
      $process = $processes[0]
      $cimProcessIdMatchesRetainedRoot = $false
      try {
        $cimDiagnosticObservation.cimProcessIdMatches = [int]$process.ProcessId -eq [int]$nativeBeforeProbe.processId
        $cimProcessIdMatchesRetainedRoot = [bool]$cimDiagnosticObservation.cimProcessIdMatches
        if (-not $cimDiagnosticObservation.cimProcessIdMatches) {
          Set-PolicyCimProbeFailure -Observation $cimDiagnosticObservation -Stage 'cim-process-id' -Category 'mismatch'
        }
      } catch {
        Set-PolicyCimProbeFailure -Observation $cimDiagnosticObservation -Stage 'cim-process-id' -Category (Get-PolicyCimFailureCategory -Exception $_.Exception)
      }

      if ($cimProcessIdMatchesRetainedRoot) {
        try {
          $cimDiagnosticObservation.cimParentMatchesTestProcess = [int]$process.ParentProcessId -eq [int]$PID
          $cimDiagnosticObservation.cimExecutablePathPresent = -not [string]::IsNullOrEmpty([string]$process.ExecutablePath)
          if (-not $cimDiagnosticObservation.cimExecutablePathPresent) {
            $cimDiagnosticObservation.cimExecutablePathDisposition = 'absent-or-empty'
          }
        } catch {
          Set-PolicyCimProbeFailure -Observation $cimDiagnosticObservation -Stage 'cim-process-fields' -Category (Get-PolicyCimFailureCategory -Exception $_.Exception)
        }

        # Probe owner independently even if the process image path is absent.
        try {
          $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -OperationTimeoutSec 5 -ErrorAction Stop
          if ($null -eq $owner) {
            $cimDiagnosticObservation.ownerMethodStatus = 'null-result'
            Set-PolicyCimProbeFailure -Observation $cimDiagnosticObservation -Stage 'cim-owner' -Category 'null-result'
          } else {
            $returnValue = [uint32]$owner.ReturnValue
            $cimDiagnosticObservation.ownerReturnValue = $returnValue
            if ($returnValue -ne 0) {
              $cimDiagnosticObservation.ownerMethodStatus = 'nonzero-return'
              Set-PolicyCimProbeFailure -Observation $cimDiagnosticObservation -Stage 'cim-owner' -Category 'nonzero-return'
            } elseif ([string]::IsNullOrWhiteSpace([string]$owner.Sid)) {
              $cimDiagnosticObservation.ownerMethodStatus = 'empty-sid'
              Set-PolicyCimProbeFailure -Observation $cimDiagnosticObservation -Stage 'cim-owner' -Category 'empty-sid'
            } else {
              $cimDiagnosticObservation.ownerMethodStatus = 'success'
              $cimDiagnosticObservation.ownerMatchesCurrentUser = [string]::Equals([string]$owner.Sid, [string]$identitySid, [StringComparison]::Ordinal)
            }
          }
          $owner = $null
        } catch {
          $cimDiagnosticObservation.ownerMethodStatus = 'exception'
          Set-PolicyCimProbeFailure -Observation $cimDiagnosticObservation -Stage 'cim-owner' -Category (Get-PolicyCimFailureCategory -Exception $_.Exception)
        }
      } else {
        $cimDiagnosticObservation.ownerMethodStatus = if ($null -eq $cimDiagnosticObservation.cimProcessIdMatches) {
          'skipped-pid-unavailable'
        } else {
          'skipped-pid-mismatch'
        }
      }

      if ($cimProcessIdMatchesRetainedRoot) {
        try {
          $creationValue = $process.CreationDate
          if ($creationValue -is [datetime]) {
            $cimDiagnosticObservation.cimCreationDateKind = 'datetime'
            $creationTime = $creationValue.ToUniversalTime()
          } elseif ($creationValue -is [string]) {
            $cimDiagnosticObservation.cimCreationDateKind = 'dmtf-string'
            $creationTime = [System.Management.ManagementDateTimeConverter]::ToDateTime($creationValue).ToUniversalTime()
          } else {
            $cimDiagnosticObservation.cimCreationDateKind = 'other'
            throw [InvalidOperationException]::new('Unsupported creation-date representation.')
          }
          $nativeTime = [DateTime]::Parse([string]$nativeBeforeProbe.creationTimeUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
          $cimDiagnosticObservation.cimCreationTimeMatchesNativeWithin20Ticks = [Math]::Abs(($nativeTime - $creationTime).Ticks) -le 20
        } catch {
          if ($cimDiagnosticObservation.cimCreationDateKind -eq 'not-observed') { $cimDiagnosticObservation.cimCreationDateKind = 'parse-failed' }
          Set-PolicyCimProbeFailure -Observation $cimDiagnosticObservation -Stage 'cim-creation-time' -Category (Get-PolicyCimFailureCategory -Exception $_.Exception)
        }

        if ($cimDiagnosticObservation.cimExecutablePathPresent) {
          try {
            $cimPath = ConvertTo-PilotCanonicalPath -Path ([string]$process.ExecutablePath)
            $nativePath = ConvertTo-PilotCanonicalPath -Path ([string]$nativeBeforeProbe.executablePath)
            $cimDiagnosticObservation.cimExecutablePathMatchesNative = [string]::Equals($cimPath, $nativePath, [StringComparison]::OrdinalIgnoreCase)
            $cimDiagnosticObservation.cimExecutablePathMatchesStaged = [string]::Equals($cimPath, $pwshPath, [StringComparison]::OrdinalIgnoreCase)
            if (-not $cimDiagnosticObservation.cimExecutablePathMatchesNative -or
                -not $cimDiagnosticObservation.cimExecutablePathMatchesStaged) {
              $cimDiagnosticObservation.cimExecutablePathDisposition = 'mismatch'
              Set-PolicyCimProbeFailure -Observation $cimDiagnosticObservation -Stage 'cim-path' -Category 'mismatch'
            } else {
              $cimDiagnosticObservation.cimExecutablePathDisposition = 'corroborated'
              try {
                $hash = (Get-FileHash -LiteralPath $pwshPath -Algorithm SHA256 -ErrorAction Stop).Hash
                $cimDiagnosticObservation.cimHashMatchesExpected = [string]::Equals([string]$hash, [string]$pwshHash, [StringComparison]::OrdinalIgnoreCase)
                if (-not $cimDiagnosticObservation.cimHashMatchesExpected) {
                  Set-PolicyCimProbeFailure -Observation $cimDiagnosticObservation -Stage 'cim-hash' -Category 'mismatch'
                }
              } catch {
                Set-PolicyCimProbeFailure -Observation $cimDiagnosticObservation -Stage 'cim-hash' -Category (Get-PolicyCimFailureCategory -Exception $_.Exception)
              }
            }
            $cimPath = $null
            $nativePath = $null
            $hash = $null
          } catch {
            $cimDiagnosticObservation.cimExecutablePathDisposition = 'invalid'
            $cimDiagnosticObservation.cimExecutablePathMatchesNative = $false
            Set-PolicyCimProbeFailure -Observation $cimDiagnosticObservation -Stage 'cim-path' -Category (Get-PolicyCimFailureCategory -Exception $_.Exception)
          }
        }
      }
      $process = $null
      $processes = @()
    }
    $cimDiagnosticObservation.probeState = 'completed'
  } catch {
    $cimDiagnosticObservation.probeState = 'probe-failed'
    Set-PolicyCimProbeFailure -Observation $cimDiagnosticObservation -Stage 'root-creation-or-observation' -Category (Get-PolicyCimFailureCategory -Exception $_.Exception)
  } finally {
    if ($null -ne $cimDiagnosticSession) {
      try {
        $nativeAfterProbe = $cimDiagnosticSession.ObserveRoot()
        $membersAfterProbe = @($cimDiagnosticSession.ListMemberIds())
        $cimDiagnosticObservation.rootSuspendedAfter = [string]$nativeAfterProbe.state -ceq 'suspended'
        foreach ($memberId in $membersAfterProbe) {
          if ([uint32]$memberId -eq [uint32]$nativeAfterProbe.processId) { $cimDiagnosticObservation.rootMemberAfter = $true; break }
        }
      } catch {
        Set-PolicyCimProbeFailure -Observation $cimDiagnosticObservation -Stage 'cleanup-observe' -Category (Get-PolicyCimFailureCategory -Exception $_.Exception)
      }
      try {
        $diagnosticStop = $cimDiagnosticSession.StopAndWait(10000)
        $cimDiagnosticObservation.cleanupJobEmpty = [bool]$diagnosticStop.jobEmpty
        $cimDiagnosticObservation.cleanupRootExited = [bool]$diagnosticStop.rootExited
      } catch {
        Set-PolicyCimProbeFailure -Observation $cimDiagnosticObservation -Stage 'cleanup-stop-and-wait' -Category (Get-PolicyCimFailureCategory -Exception $_.Exception)
      }
      try {
        $null = $cimDiagnosticSession.Dispose()
        $cimDiagnosticObservation.cleanupDisposeStatus = 'succeeded'
      } catch {
        $cimDiagnosticObservation.cleanupDisposeStatus = 'failed'
        Set-PolicyCimProbeFailure -Observation $cimDiagnosticObservation -Stage 'cleanup-dispose' -Category (Get-PolicyCimFailureCategory -Exception $_.Exception)
      }
      $cimDiagnosticSession = $null
    }
    $cimDiagnosticObservation.markerAbsent = -not [IO.File]::Exists($cimDiagnosticMarkerPath)
    $cimDiagnosticCleanupConfirmed = (
      [bool]$cimDiagnosticObservation.cleanupJobEmpty -and [bool]$cimDiagnosticObservation.cleanupRootExited -and
      [bool]$cimDiagnosticObservation.markerAbsent -and
      $cimDiagnosticObservation.cleanupDisposeStatus -ceq 'succeeded'
    )
    $cimDiagnosticCleanupUnconfirmed = ([bool]$cimDiagnosticObservation.rootCreationAttempted) -and (-not [bool]$cimDiagnosticCleanupConfirmed)
    $cimDiagnosticObservation.cleanupConfirmed = $cimDiagnosticCleanupConfirmed
    if ($null -ne $outsider) {
      try {
        $outsider.Refresh()
        $cimDiagnosticObservation.outsiderAliveAfterProbe = -not $outsider.HasExited
      } catch { $cimDiagnosticObservation.outsiderAliveAfterProbe = $false }
    }
    $allNativeJobsCleaned = $cimDiagnosticCleanupConfirmed
    if ($cimDiagnosticCleanupUnconfirmed) { $allNativeJobsCleaned = $false }
    if (-not $cimDiagnosticCleanupConfirmed) {
      [void]$cleanupErrors.Add('The synthetic suspended CIM diagnostic cleanup was not fully confirmed.')
    }
  }

  [void]$observations.Add([pscustomobject]$cimDiagnosticObservation)
  if (-not $cimDiagnosticCleanupConfirmed) { throw 'The synthetic suspended CIM diagnostic cleanup was not fully confirmed.' }

  $failurePhase = 'parent-mismatch'
  $parentMismatch = [int]$PID + 1
  if ($parentMismatch -gt [int]::MaxValue) { $parentMismatch = [int]$PID - 1 }
  $bad = Copy-PolicyDescriptor -Descriptor $baseDescriptor
  $bad.expectedParentProcessId = $parentMismatch
  $bad.argumentList = [object[]]@(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    $childScriptPath, (Join-Path $privateRoot 'parent-mismatch.receipt'),
    (Join-Path $privateRoot 'parent-mismatch.marker'), $profilePath,
    [string]$environment['APPDATA'], [string]$environment['LOCALAPPDATA'],
    [string]$environment['TEMP'], ($environment['SYSTEMROOT'] + '\System32;' + $runtimeRoot), $runtimeRoot, 'parent mismatch', $personalCanaryName
  )
  $allNativeJobsCleaned = $false
  $mismatchResult = Invoke-ExpectedPolicyFailure -Action { Start-WindowsNativeProcess -Descriptor $bad -Verbose } `
    -ExpectedErrorId 'Morrow.WindowsNativeProcess.IdentityMismatch' -ExpectedFields @('parentProcessId') -RequireCompletedCleanup
  $allNativeJobsCleaned = $true
  $verboseMismatch = @($mismatchResult.verboseMessages)
  $parentMarkerAbsent = -not [IO.File]::Exists((Join-Path $privateRoot 'parent-mismatch.marker'))
  $checks.mismatchedParentFailsBeforeResume = (
    [string]$mismatchResult.cleanup['jobEmpty'] -eq 'True' -and
    [string]$mismatchResult.cleanup['rootExited'] -eq 'True' -and
    $parentMarkerAbsent -and
    @($verboseMismatch | Where-Object { $_ -match 'Morrow\.WindowsNativeProcess\.Resume:' }).Count -eq 0
  )
  Assert-PolicyCheck -Condition $checks.mismatchedParentFailsBeforeResume -Name 'mismatchedParentFailsBeforeResume'
  $outsider.Refresh()
  $outsiderAliveAfterParentMismatch = -not $outsider.HasExited
  $checks.outsiderSurvivesParentMismatchCleanup = $outsiderAliveAfterParentMismatch
  Assert-PolicyCheck -Condition $checks.outsiderSurvivesParentMismatchCleanup -Name 'outsiderSurvivesParentMismatchCleanup'
  [void]$observations.Add([pscustomobject]@{ scenario = 'well-formed-parent-mismatch'; cleanupVerified = $true; markerAbsent = $parentMarkerAbsent; outsiderAlive = $outsiderAliveAfterParentMismatch; resumeLogged = $false })

  $failurePhase = 'owner-mismatch'
  $wrongSid = if ($identitySid -ceq 'S-1-1-0') { 'S-1-5-18' } else { 'S-1-1-0' }
  $bad = Copy-PolicyDescriptor -Descriptor $baseDescriptor
  $bad.expectedOwnerSid = $wrongSid
  $bad.argumentList = [object[]]@(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    $childScriptPath, (Join-Path $privateRoot 'owner-mismatch.receipt'),
    (Join-Path $privateRoot 'owner-mismatch.marker'), $profilePath,
    [string]$environment['APPDATA'], [string]$environment['LOCALAPPDATA'],
    [string]$environment['TEMP'], ($environment['SYSTEMROOT'] + '\System32;' + $runtimeRoot), $runtimeRoot, 'owner mismatch', $personalCanaryName
  )
  $allNativeJobsCleaned = $false
  $ownerMismatchResult = Invoke-ExpectedPolicyFailure -Action { Start-WindowsNativeProcess -Descriptor $bad -Verbose } `
    -ExpectedErrorId 'Morrow.WindowsNativeProcess.IdentityMismatch' -ExpectedFields @('ownerSid') -RequireCompletedCleanup
  $allNativeJobsCleaned = $true
  $ownerMarkerAbsent = -not [IO.File]::Exists((Join-Path $privateRoot 'owner-mismatch.marker'))
  $ownerResumeLogged = @($ownerMismatchResult.verboseMessages | Where-Object { $_ -match 'Morrow\.WindowsNativeProcess\.Resume:' }).Count -gt 0
  $checks.mismatchedOwnerFailsBeforeResume = (
    [bool]$ownerMismatchResult.cleanup['jobEmpty'] -and [bool]$ownerMismatchResult.cleanup['rootExited'] -and
    $ownerMarkerAbsent -and -not $ownerResumeLogged
  )
  Assert-PolicyCheck -Condition $checks.mismatchedOwnerFailsBeforeResume -Name 'mismatchedOwnerFailsBeforeResume'
  $outsider.Refresh()
  $outsiderAliveAfterOwnerMismatch = -not $outsider.HasExited
  $checks.outsiderSurvivesOwnerMismatchCleanup = $outsiderAliveAfterOwnerMismatch
  Assert-PolicyCheck -Condition $checks.outsiderSurvivesOwnerMismatchCleanup -Name 'outsiderSurvivesOwnerMismatchCleanup'
  [void]$observations.Add([pscustomobject]@{ scenario = 'well-formed-owner-mismatch'; cleanupVerified = $true; markerAbsent = $ownerMarkerAbsent; outsiderAlive = $outsiderAliveAfterOwnerMismatch; resumeLogged = $ownerResumeLogged })

  $failurePhase = 'happy-start'
  $happyDescriptor = Copy-PolicyDescriptor -Descriptor $baseDescriptor
  $allNativeJobsCleaned = $false
  $startOutput = @(& { Start-WindowsNativeProcess -Descriptor $happyDescriptor -Verbose 4>&1 })
  $capsuleType = 'Morrow.Pilot.WindowsNativeProcessCapsule' -as [type]
  $capsuleCandidates = @($startOutput | Where-Object { $null -ne $capsuleType -and $capsuleType.IsInstanceOfType($_) })
  $verboseSuccess = @($startOutput | Where-Object { $_ -is [System.Management.Automation.VerboseRecord] } | ForEach-Object { [string]$_.Message })
  if ($capsuleCandidates.Count -ne 1) { throw 'Start did not return exactly one opaque capsule.' }
  $capsule = $capsuleCandidates[0]

  $capsuleType = $capsule.GetType()
  $declaredPublicMembers = @($capsuleType.GetMembers([Reflection.BindingFlags]::Public -bor [Reflection.BindingFlags]::Instance -bor [Reflection.BindingFlags]::DeclaredOnly))
  $declaredProperties = @($capsuleType.GetProperties([Reflection.BindingFlags]::Public -bor [Reflection.BindingFlags]::Instance -bor [Reflection.BindingFlags]::DeclaredOnly))
  $declaredMethods = @($capsuleType.GetMethods([Reflection.BindingFlags]::Public -bor [Reflection.BindingFlags]::Instance -bor [Reflection.BindingFlags]::DeclaredOnly))
  $publicConstructors = @($capsuleType.GetConstructors([Reflection.BindingFlags]::Public -bor [Reflection.BindingFlags]::Instance))
  $fakeCapsule = [pscustomobject]@{ Job = 'fake'; Dispose = 'caller-supplied' }
  $proofIndex = -1
  $resumeIndex = -1
  for ($index = 0; $index -lt $verboseSuccess.Count; $index++) {
    if ($verboseSuccess[$index] -match 'Morrow\.WindowsNativeProcess\.IdentityProof:') { $proofIndex = $index }
    if ($verboseSuccess[$index] -match 'Morrow\.WindowsNativeProcess\.Resume:') { $resumeIndex = $index }
  }
  $checks.opaqueCapsuleHasOnlySafeDispose = (
    $capsuleType.IsSealed -and
    $declaredProperties.Count -eq 0 -and
    $declaredPublicMembers.Count -eq 1 -and
    $declaredMethods.Count -eq 1 -and $declaredMethods[0].Name -ceq 'Dispose' -and
    $publicConstructors.Count -eq 0 -and
    -not $capsuleType.IsInstanceOfType($fakeCapsule)
  )
  Assert-PolicyCheck -Condition $checks.opaqueCapsuleHasOnlySafeDispose -Name 'opaqueCapsuleHasOnlySafeDispose'
  if ($proofIndex -lt 0 -or $resumeIndex -le $proofIndex -or
      $verboseSuccess[$resumeIndex] -notmatch 'previous suspend count one') {
    throw 'The verbose receipt did not show identity proof before the internal Resume result.'
  }
  [void]$observations.Add([pscustomobject]@{
    scenario = 'success-proof-order'
    identityProofBeforeResume = $true
    previousSuspendCountOne = $true
    noPidOrHandleLogged = $true
    cimExecutablePathDisposition = [string]$cimDiagnosticObservation.cimExecutablePathDisposition
  })

  $happyMarker = Join-Path $privateRoot 'happy.marker'
  $happyReceiptPath = Join-Path $privateRoot 'happy.receipt'
  if (-not (Wait-PolicyFile -Path $happyMarker -TimeoutSeconds 15) -or -not (Wait-PolicyFile -Path $happyReceiptPath -TimeoutSeconds 15)) {
    throw 'The validated child did not run its marker and receipt.'
  }
  $reportLines = [IO.File]::ReadAllLines($happyReceiptPath)
  $childReport = [ordered]@{}
  foreach ($line in $reportLines) {
    $separator = $line.IndexOf('=')
    if ($separator -gt 0) { $childReport[$line.Substring(0, $separator)] = $line.Substring($separator + 1) }
  }
  $checks.unicodeArgvAndProfileReachOwnedChild = (
    $childReport['unicodeArgumentMatches'] -eq 'true' -and
    $childReport['userProfileMatches'] -eq 'true' -and
    $childReport['homeMatches'] -eq 'true' -and
    $childReport['appDataMatches'] -eq 'true' -and
    $childReport['localAppDataMatches'] -eq 'true' -and
    $childReport['tempMatches'] -eq 'true' -and
    $childReport['tmpMatches'] -eq 'true' -and
    $childReport['pathMatches'] -eq 'true' -and
    $childReport['stagedProcessDirectoryMatches'] -eq 'true'
  )
  Assert-PolicyCheck -Condition $checks.unicodeArgvAndProfileReachOwnedChild -Name 'unicodeArgvAndProfileReachOwnedChild'
  $checks.childEnvironmentDoesNotInheritCredentials = $childReport['credentialLikeEnvironmentAbsent'] -eq 'true'
  Assert-PolicyCheck -Condition $checks.childEnvironmentDoesNotInheritCredentials -Name 'childEnvironmentDoesNotInheritCredentials'
  $checks.childDoesNotInheritPersonalCanary = $childReport['personalCanaryAbsent'] -eq 'true'
  Assert-PolicyCheck -Condition $checks.childDoesNotInheritPersonalCanary -Name 'childDoesNotInheritPersonalCanary'

  $failurePhase = 'capsule-cleanup'
  $firstCleanup = $capsule.Dispose()
  $capsuleCleanup = [ordered]@{
    jobEmpty = [bool]$firstCleanup.jobEmpty
    rootExited = [bool]$firstCleanup.rootExited
    exitCode = if ($null -eq $firstCleanup.exitCode) { $null } else { [uint32]$firstCleanup.exitCode }
  }
  $checks.disposeConfirmsEmptyJobAndExitedRoot = [bool]$firstCleanup.jobEmpty -and [bool]$firstCleanup.rootExited
  Assert-PolicyCheck -Condition $checks.disposeConfirmsEmptyJobAndExitedRoot -Name 'disposeConfirmsEmptyJobAndExitedRoot'
  $allNativeJobsCleaned = $checks.disposeConfirmsEmptyJobAndExitedRoot
  $secondCleanup = $capsule.Dispose()
  $checks.disposeIsIdempotent = (
    [bool]$secondCleanup.jobEmpty -eq [bool]$firstCleanup.jobEmpty -and
    [bool]$secondCleanup.rootExited -eq [bool]$firstCleanup.rootExited -and
    $secondCleanup.GetType() -eq $firstCleanup.GetType()
  )
  Assert-PolicyCheck -Condition $checks.disposeIsIdempotent -Name 'disposeIsIdempotent'
  $outsider.Refresh()
  $outsiderAliveAtEnd = -not $outsider.HasExited
  $checks.outsiderSurvivesOwnedCleanup = $outsiderAliveAtEnd
  Assert-PolicyCheck -Condition $checks.outsiderSurvivesOwnedCleanup -Name 'outsiderSurvivesOwnedCleanup'
  [void]$observations.Add([pscustomobject]@{
    scenario = 'happy-start-dispose'
    childMarkerObserved = $true
    environmentAllowlistConfirmed = $checks.childEnvironmentDoesNotInheritCredentials
    jobEmpty = $checks.disposeConfirmsEmptyJobAndExitedRoot
    rootExited = $checks.disposeConfirmsEmptyJobAndExitedRoot
    outsiderAliveAfterCleanup = $outsiderAliveAtEnd
  })
} catch {
  $failure = 'Own Windows native process policy suite failed.'
  $exception = $_.Exception
  $failureErrorId = $null
  $failureType = 'System.Exception'
  if ($null -ne $exception) {
    $failureType = $exception.GetType().FullName
    $failureErrorId = Get-PolicyErrorId -Exception $exception
  }
  if ($null -eq $failureErrorId -and $_.FullyQualifiedErrorId) {
    $allowedPrefixes = @('Morrow.WindowsNativeProcess.InvalidDescriptor', 'Morrow.WindowsNativeProcess.IdentityMismatch', 'Morrow.WindowsNativeProcess.StartFailed', 'Morrow.WindowsNativeProcess.CleanupIncomplete')
    $caughtFullyQualifiedErrorId = [string]$_.FullyQualifiedErrorId
    foreach ($prefix in $allowedPrefixes) {
      if ($caughtFullyQualifiedErrorId -ceq $prefix -or
          ([string]$caughtFullyQualifiedErrorId).StartsWith($prefix + ',', [StringComparison]::Ordinal)) {
        $failureErrorId = $prefix
        break
      }
    }
  }
  $caughtPolicyDiagnostics = if ($null -ne $exception) { Get-PolicyDiagnostics -Exception $exception } else { $null }
  $caughtCleanup = if ($caughtPolicyDiagnostics -is [System.Collections.IDictionary]) { $caughtPolicyDiagnostics['cleanup'] } else { $null }
  if ($null -ne $caughtCleanup) {
    $disposeFailed = $caughtCleanup -is [System.Collections.IDictionary] -and
      $caughtCleanup.Contains('disposeFailed') -and [bool]$caughtCleanup['disposeFailed']
    $allNativeJobsCleaned = [bool]$caughtCleanup['attempted'] -and [bool]$caughtCleanup['jobEmpty'] -and
      [bool]$caughtCleanup['rootExited'] -and -not $disposeFailed
  } elseif ($failurePhase -eq 'happy-start' -and $null -ne $caughtPolicyDiagnostics -and
      [string]$caughtPolicyDiagnostics['stage'] -in @('descriptor-validation', 'path-validation', 'platform-preflight', 'dependency-preflight', 'system-path-resolution', 'environment-validation', 'environment-path-validation', 'environment-path-containment', 'executable-hash-validation')) {
    $allNativeJobsCleaned = $true
  }
  $failureDiagnostic = [ordered]@{
    phase = $failurePhase
    exceptionType = $failureType
    errorId = $failureErrorId
    hresult = if ($null -ne $exception) { [int64]$exception.HResult } else { $null }
  }
} finally {
  if ($personalCanarySetAttempted) {
    try {
      $canaryProviderPath = 'Env:' + $personalCanaryName
      if ($personalCanaryOriginalPresent) {
        Set-Item -LiteralPath $canaryProviderPath -Value $personalCanaryOriginalValue -ErrorAction Stop
      } elseif (Test-Path -LiteralPath $canaryProviderPath) {
        Remove-Item -LiteralPath $canaryProviderPath -ErrorAction Stop
      }
      $restoredPresent = $false
      $restoredValue = $null
      $restoredEnvironment = [Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::Process)
      foreach ($entry in $restoredEnvironment.GetEnumerator()) {
        if ([string]::Equals([string]$entry.Key, $personalCanaryName, [StringComparison]::OrdinalIgnoreCase)) {
          $restoredPresent = $true
          $restoredValue = [string]$entry.Value
          break
        }
      }
      $personalCanaryRestored = if ($personalCanaryOriginalPresent) {
        $restoredPresent -and [string]::Equals($restoredValue, $personalCanaryOriginalValue, [StringComparison]::Ordinal)
      } else {
        -not $restoredPresent
      }
      $checks.parentCanaryRestored = $personalCanaryRestored
      if (-not $personalCanaryRestored) { [void]$cleanupErrors.Add('The synthetic parent environment canary could not be restored.') }
    } catch {
      $checks.parentCanaryRestored = $false
      [void]$cleanupErrors.Add('The synthetic parent environment canary could not be restored.')
    }
  }
  if ($null -ne $capsule) {
    try {
      $finalCleanup = $capsule.Dispose()
      if (-not [bool]$finalCleanup.jobEmpty -or -not [bool]$finalCleanup.rootExited) {
        $allNativeJobsCleaned = $false
        [void]$cleanupErrors.Add('Capsule cleanup did not confirm Job empty and root exited.')
      } else {
        $allNativeJobsCleaned = $true
      }
    } catch {
      $allNativeJobsCleaned = $false
      [void]$cleanupErrors.Add('Capsule cleanup raised a sanitized failure.')
    }
  }
  if ($null -ne $outsider) {
    try {
      $outsider.Refresh()
      if (-not $outsider.HasExited) {
        $outsider.Kill()
        if (-not $outsider.WaitForExit(5000)) { throw 'The test-owned outsider did not exit after Kill.' }
      }
      $outsiderExited = $true
      $outsider.Dispose()
    } catch {
      [void]$cleanupErrors.Add('The test-owned outsider did not complete cleanup.')
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($junctionPath) -and [IO.Directory]::Exists($junctionPath)) {
    try { [IO.Directory]::Delete($junctionPath, $false) } catch { [void]$cleanupErrors.Add('The test-owned junction could not be removed.') }
  }
  if ($privateRootCreated -and [IO.Directory]::Exists($privateRoot) -and
      (-not $allNativeJobsCleaned -or -not $outsiderExited -or $cimDiagnosticCleanupUnconfirmed)) {
    $privateRuntimeRetained = $true
    [void]$cleanupErrors.Add('Private staging was retained because process cleanup was not fully confirmed.')
  } elseif ($privateRootCreated -and [IO.Directory]::Exists($privateRoot)) {
    try {
      $markerMatches = [IO.File]::Exists($ownerMarker) -and [IO.File]::ReadAllText($ownerMarker) -ceq $runId
      [void](Get-PilotTemporaryPathProof -Path $privateRoot -RunnerTemp $runnerTemp)
      if (-not $markerMatches -or (Test-PolicyPathUnder -Path $privateRoot -Root $evidenceFullPath) -or
          (Test-PolicyPathUnder -Path $evidenceFullPath -Root $privateRoot)) {
        throw 'Private temp ownership proof failed.'
      }
      [IO.Directory]::Delete($privateRoot, $true)
    } catch {
      $privateRuntimeRetained = [IO.Directory]::Exists($privateRoot)
      [void]$cleanupErrors.Add('The private runtime staging directory could not be safely removed.')
    }
  }
  if ($cleanupErrors.Count -gt 0 -and $null -eq $failure) {
    $failure = 'Own test cleanup did not fully complete.'
    $failureDiagnostic = [ordered]@{ phase = 'cleanup'; exceptionType = $null; errorId = 'Morrow.WindowsNativeProcess.CleanupIncomplete'; hresult = $null }
  }

  $policyHash = $null
  $testHash = $null
  try { $policyHash = (Get-FileHash -LiteralPath $policyPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() } catch { }
  try { $testHash = (Get-FileHash -LiteralPath $MyInvocation.MyCommand.Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() } catch { }
  $receipt = [ordered]@{
    schemaVersion = 1
    scope = 'issue-225 Windows native process policy own suite'
    status = if ($null -eq $failure) { 'passed' } else { 'failed' }
    runId = $runId
    os = [Environment]::OSVersion.VersionString
    powershell = $PSVersionTable.PSVersion.ToString()
    processArchitecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
    sourcePath = 'scripts/pilot/windows-native-process-policy.ps1'
    policySha256 = $policyHash
    ownTestPath = 'scripts/pilot/windows-native-process-policy.own.test.ps1'
    ownTestSha256 = $testHash
    exitCode = if ($null -eq $failure -and $cleanupErrors.Count -eq 0) { 0 } else { 1 }
    logs = [ordered]@{ childReceipt = if ($null -eq $childReport) { 'not-produced' } else { 'sanitized-profile-and-environment-checks' }; rawChildOutputRetained = $false }
    expectedCommand = 'pwsh -NoProfile -File scripts/pilot/windows-native-process-policy.own.test.ps1 -EvidenceRoot <new child of RUNNER_TEMP>'
    checks = $checks
    observations = @($observations)
    childEnvironmentReport = $childReport
    capsuleCleanup = $capsuleCleanup
    outsiderAliveAfterOwnedCleanup = $outsiderAliveAtEnd
    privateRuntimeRetained = $privateRuntimeRetained
    retainedRuntimePath = if ($privateRuntimeRetained) { $privateRoot } else { $null }
    appLaunched = $false
    tauriDriverStarted = $false
    edgeLaunched = $false
    webViewLaunched = $false
    guiOpened = $false
    failure = $failure
    failureDiagnostic = $failureDiagnostic
    cleanupErrors = @($cleanupErrors)
  }
  $receiptJson = ConvertTo-Json -InputObject $receipt -Depth 8 -Compress
  if ($receiptJson.Contains($secretSentinel)) {
    $receipt.status = 'failed'
    $receipt.failure = 'Sanitization check detected a sentinel in the receipt.'
    $receipt.failureDiagnostic = [ordered]@{ phase = 'sanitization'; exceptionType = $null; errorId = 'Morrow.WindowsNativeProcess.InvalidDescriptor'; hresult = $null }
    $receipt.exitCode = 1
    $receiptJson = ConvertTo-Json -InputObject $receipt -Depth 8 -Compress
  }
  if ($evidenceRootCreated -and $null -ne $evidenceFullPath) {
    try { [IO.File]::WriteAllText((Join-Path $evidenceFullPath 'receipt.json'), $receiptJson, [Text.UTF8Encoding]::new($false)) } catch {
      $receipt.status = 'failed'
      $receipt.failure = 'The sanitized receipt could not be persisted.'
      $receipt.failureDiagnostic = [ordered]@{ phase = 'evidence-write'; exceptionType = $null; errorId = 'Morrow.WindowsNativeProcess.StartFailed'; hresult = $null }
      $receipt.exitCode = 1
      $receiptJson = ConvertTo-Json -InputObject $receipt -Depth 8 -Compress
    }
  }
  [Console]::Out.WriteLine($receiptJson)
}

if ($null -ne $failure -or $cleanupErrors.Count -gt 0 -or $receipt.status -cne 'passed') { exit 1 }
exit 0
