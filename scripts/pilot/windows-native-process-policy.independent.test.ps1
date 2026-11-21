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

$script:Issue = 236
$script:RunStartedUtc = [DateTime]::UtcNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
$script:Checks = [ordered]@{}
$script:Failures = [Collections.Generic.List[string]]::new()
$script:CurrentSubstep = 'setup'
$script:PolicyFailureCandidate = $null
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
$script:EnvironmentCanaryName = 'MORROW_236_PARENT_ONLY_' + [Guid]::NewGuid().ToString('N').ToUpperInvariant()
$script:EnvironmentCanaryValue = [Guid]::NewGuid().ToString('N')
$script:OriginalCanaryValue = $null
$script:OriginalCanaryExisted = $false
$script:CanaryWasSet = $false
$script:Outsider = $null
$script:CaseOutcomes = [Collections.Generic.List[object]]::new()
$script:IdentityReceipts = [Collections.Generic.List[object]]::new()
$script:SafeObserveInventoryEvidence = $null
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

function Add-Check {
  param(
    [Parameter(Mandatory)][string] $Name,
    [Parameter(Mandatory)][scriptblock] $Action
  )
  $script:CurrentSubstep = $Name
  $script:PolicyFailureCandidate = $null
  try {
    $detail = & $Action
    $script:Checks[$Name] = [ordered]@{ status = 'passed'; detail = $detail }
    [Console]::Out.WriteLine(('PASS {0}' -f $Name))
  } catch {
    $failure = New-SafeFailureSummary -ErrorRecord $_ -CheckName $Name -Substep $script:CurrentSubstep
    $script:PolicyFailureCandidate = $null
    $script:Checks[$Name] = [ordered]@{ status = 'failed'; diagnostic = $failure }
    [void]$script:CaseOutcomes.Add($failure)
    $script:Failures.Add($Name)
    [Console]::Error.WriteLine(('FAIL {0} id={1} stage={2} substep={3}' -f $Name, $failure.errorId, $failure.stage, $failure.substep))
  }
}

function Get-PolicyErrorId {
  param([Parameter(Mandatory)][System.Management.Automation.ErrorRecord] $ErrorRecord)
  $current = $ErrorRecord.Exception
  for ($depth = 0; $null -ne $current -and $depth -lt 8; $depth++) {
    if ($current.Data.Contains('Morrow.WindowsNativeProcess.ErrorId')) {
      return [string]$current.Data['Morrow.WindowsNativeProcess.ErrorId']
    }
    $current = $current.InnerException
  }
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

function Get-DiagnosticValue {
  param(
    [AllowNull()][object] $Object,
    [Parameter(Mandatory)][string] $Name
  )
  if ($null -eq $Object) { return $null }
  if ($Object -is [System.Collections.IDictionary]) {
    if ($Object.Contains($Name)) { return $Object[$Name] }
    return $null
  }
  if ($Object.PSObject.Properties[$Name]) { return $Object.$Name }
  return $null
}

function Get-SafeBoundedCount {
  param(
    [AllowNull()][object] $Value,
    [Parameter(Mandatory)][ValidateRange(1, 1024)][int] $Maximum
  )

  if ($null -eq $Value) { return [ordered]@{ value = $null; valid = $true; capped = $false } }
  $integralTypes = @([byte], [sbyte], [short], [ushort], [int], [uint32], [long], [ulong])
  if ($Value.GetType() -notin $integralTypes) { return [ordered]@{ value = $null; valid = $false; capped = $false } }
  try { $number = [decimal]$Value } catch { return [ordered]@{ value = $null; valid = $false; capped = $false } }
  if ($number -lt 0) { return [ordered]@{ value = $null; valid = $false; capped = $false } }
  $capped = $number -gt $Maximum
  return [ordered]@{
    value = if ($capped) { $Maximum } else { [int]$number }
    valid = $true
    capped = $capped
  }
}

function New-SafeFailureSummary {
  param(
    [Parameter(Mandatory)][System.Management.Automation.ErrorRecord] $ErrorRecord,
    [Parameter(Mandatory)][string] $CheckName,
    [Parameter(Mandatory)][string] $Substep
  )

  $knownErrorIds = @(
    'Morrow.WindowsNativeProcess.InvalidDescriptor',
    'Morrow.WindowsNativeProcess.InvalidCapsule',
    'Morrow.WindowsNativeProcess.InvalidIdentityAssertion',
    'Morrow.WindowsNativeProcess.IdentityMismatch',
    'Morrow.WindowsNativeProcess.IdentityUnavailable',
    'Morrow.WindowsNativeProcess.StartFailed',
    'Morrow.WindowsNativeProcess.CleanupIncomplete'
  )
  $diagnosticSource = $ErrorRecord
  if ($script:PolicyFailureCandidate -is [System.Management.Automation.ErrorRecord]) {
    $diagnosticSource = $script:PolicyFailureCandidate
  }
  $rawErrorId = Get-PolicyErrorId -ErrorRecord $diagnosticSource
  if ($rawErrorId -in $knownErrorIds) {
    $safeErrorId = $rawErrorId
  } elseif ($rawErrorId -match '^[A-Za-z][A-Za-z0-9_.]{0,79}$') {
    $safeErrorId = 'Other.' + $rawErrorId
  } else {
    $safeErrorId = 'Other'
  }

  $knownStages = @(
    'descriptor-validation', 'path-validation', 'platform-preflight', 'dependency-preflight',
    'path-containment', 'environment-validation', 'environment-path-validation', 'environment-path-containment',
    'executable-hash-validation', 'system-path-resolution', 'identity-dependency', 'cim-observation',
    'suspended-create', 'native-observation', 'job-membership', 'identity-comparison', 'capsule-create', 'resume', 'cleanup',
    'identity-assertion-validation', 'identity-assertion-comparison', 'observe-capsule-validation', 'observe-identity'
  )
  $diagnostics = Get-PolicyDiagnostics -ErrorRecord $diagnosticSource
  $rawStage = Get-DiagnosticValue -Object $diagnostics -Name 'stage'
  $safeStage = if ($rawStage -is [string] -and $rawStage -in $knownStages) { $rawStage } else { 'unknown' }

  $knownFields = @(
    'executablePath', 'executableSha256', 'argumentList', 'workingDirectory', 'profilePath', 'environment',
    'expectedParentProcessId', 'expectedOwnerSid', 'processId', 'parentProcessId', 'ownerSid',
    'creationTimeUtc', 'state', 'membership', 'jobPolicy', 'resumeResult', 'RUNNER_TEMP',
    'SYSTEMROOT', 'WINDIR', 'PATH', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
    'inventory', 'identity', 'capsule'
  )
  $safeFields = [Collections.Generic.List[string]]::new()
  $rawFields = Get-DiagnosticValue -Object $diagnostics -Name 'fields'
  foreach ($field in @($rawFields)) {
    if ($field -is [string] -and $field -in $knownFields -and -not $safeFields.Contains($field)) {
      [void]$safeFields.Add($field)
    }
  }

  $rawCleanup = Get-DiagnosticValue -Object $diagnostics -Name 'cleanup'
  $cleanup = [ordered]@{
    attempted = $null
    jobEmpty = $null
    rootExited = $null
    disposeFailed = $null
  }
  foreach ($flag in @('attempted', 'jobEmpty', 'rootExited', 'disposeFailed')) {
    $value = Get-DiagnosticValue -Object $rawCleanup -Name $flag
    if ($value -is [bool]) { $cleanup[$flag] = $value }
  }

  $safeSubstep = if ($Substep -match '^[A-Za-z0-9:_-]{1,96}$' -and $Substep -notmatch '(?i)^S-\d+-') { $Substep } else { 'unknown' }
  $rawExceptionType = if ($null -ne $ErrorRecord.Exception) { [string]$ErrorRecord.Exception.GetType().FullName } else { '' }
  $safeExceptionType = if ($rawExceptionType -match '^System(?:\.[A-Za-z0-9_+`]+){1,8}$') { $rawExceptionType } else { 'Other' }
  $rawSourceLine = 0
  if ($null -ne $ErrorRecord.InvocationInfo) { $rawSourceLine = [int]$ErrorRecord.InvocationInfo.ScriptLineNumber }
  $safeSourceLine = if ($rawSourceLine -ge 1 -and $rawSourceLine -le 5000) { $rawSourceLine } else { $null }
  $summary = [ordered]@{
    check = $CheckName
    substep = $safeSubstep
    errorId = $safeErrorId
    stage = $safeStage
    exceptionType = $safeExceptionType
    sourceLine = $safeSourceLine
    fields = @($safeFields)
    cleanup = $cleanup
  }
  if ($CheckName -ceq 'observe-fresh-snapshot-assertions-and-owned-job-inventory' -and
      $script:SafeObserveInventoryEvidence -is [System.Collections.IDictionary]) {
    $summary['inventoryEvidence'] = $script:SafeObserveInventoryEvidence
  }
  return $summary
}

function Test-ExpectedPolicyError {
  param(
    [Parameter(Mandatory)][scriptblock] $Action,
    [Parameter(Mandatory)][string] $ExpectedErrorId,
    [string[]] $ExpectedFields = @(),
    [string[]] $ForbiddenText = @(),
    [string] $ExpectedStage,
    [string] $ExpectedCommand,
    [string] $ExpectedCategory
  )

  $errorRecord = $null
  try { $null = & $Action } catch { $errorRecord = $_ }
  if ($null -eq $errorRecord) { return $false }
  $actualId = Get-PolicyErrorId -ErrorRecord $errorRecord
  $diagnostics = Get-PolicyDiagnostics -ErrorRecord $errorRecord
  if ($actualId -cne $ExpectedErrorId -or $diagnostics -isnot [System.Collections.IDictionary] -or
      [string]$diagnostics['cause'] -cne $ExpectedErrorId -or
      (-not [string]::IsNullOrEmpty($ExpectedStage) -and [string]$diagnostics['stage'] -cne $ExpectedStage)) {
    return $false
  }
  if (-not [string]::IsNullOrEmpty($ExpectedCommand)) {
    $expectedFqId = $ExpectedErrorId + ',' + $ExpectedCommand
    if ([string]$errorRecord.FullyQualifiedErrorId -cne $expectedFqId) { return $false }
  }
  if (-not [string]::IsNullOrEmpty($ExpectedCategory) -and
      [string]$errorRecord.CategoryInfo.Category -cne $ExpectedCategory) { return $false }

  $allowedFields = @(
    'processId', 'parentProcessId', 'executablePath', 'executableSha256', 'creationTimeUtc', 'ownerSid',
    'state', 'membership', 'jobPolicy', 'identity', 'inventory', 'capsule'
  )
  $reportedFields = @($diagnostics['fields'])
  foreach ($field in $reportedFields) {
    if ($field -isnot [string] -or $field -cnotin $allowedFields) { return $false }
  }
  foreach ($field in $ExpectedFields) {
    if ($reportedFields -cnotcontains $field) { return $false }
  }
  if ($reportedFields.Count -ne $ExpectedFields.Count) { return $false }

  $diagnosticJson = ConvertTo-Json -InputObject $diagnostics -Depth 8 -Compress
  $safeText = [string]$errorRecord.Exception.Message
  foreach ($forbidden in $ForbiddenText) {
    if ([string]::IsNullOrEmpty($forbidden)) { continue }
    if ($safeText.IndexOf($forbidden, [StringComparison]::Ordinal) -ge 0 -or
        $diagnosticJson.IndexOf($forbidden, [StringComparison]::Ordinal) -ge 0) { return $false }
  }
  return $true
}

function Test-IndependentIdentityAssertionHelpers {
  $script:CurrentSubstep = 'assertion-helper:fixtures'
  $runId = [Guid]::NewGuid().ToString('N')
  $missingImagePath = Join-Path $script:EvidenceRootFull ('independent-missing-image-' + $runId + '.exe')
  if (Test-PathExists -Path $missingImagePath) { throw 'The syntactic assertion image unexpectedly exists.' }
  $expectedHash = 'a' * 64
  $observed = [pscustomobject][ordered]@{
    processId = 651234
    parentProcessId = 651111
    executablePath = $missingImagePath
    executableSha256 = $expectedHash
    creationTimeUtc = '2042-02-03T04:05:06.1234567Z'
    ownerSid = 'S-1-5-18'
  }

  $script:CurrentSubstep = 'assertion-helper:empty-inputs'
  $omitted = ConvertTo-PilotWindowsNativeProcessIdentityAssertion
  $nullInput = ConvertTo-PilotWindowsNativeProcessIdentityAssertion -IdentityAssertion $null
  $emptyInput = ConvertTo-PilotWindowsNativeProcessIdentityAssertion -IdentityAssertion ([ordered]@{})
  $different = [pscustomobject][ordered]@{
    processId = 650001
    parentProcessId = 650002
    executablePath = Join-Path $script:EvidenceRootFull ('other-image-' + $runId + '.exe')
    executableSha256 = 'b' * 64
    creationTimeUtc = '2042-02-03T04:05:07.1234567Z'
    ownerSid = 'S-1-1-0'
  }
  $null = Compare-PilotWindowsNativeProcessIdentityAssertion -NormalizedAssertion $omitted -ObservedIdentity $different
  $null = Compare-PilotWindowsNativeProcessIdentityAssertion -NormalizedAssertion $nullInput -ObservedIdentity $different
  $null = Compare-PilotWindowsNativeProcessIdentityAssertion -NormalizedAssertion $emptyInput -ObservedIdentity $different
  if ($omitted.Count -ne 0 -or $nullInput.Count -ne 0 -or $emptyInput.Count -ne 0) {
    throw 'Omitted, null, or empty assertions did not normalize to no comparison.'
  }

  $script:CurrentSubstep = 'assertion-helper:positive-normalization'
  $matching = [ordered]@{
    processId = [long]$observed.processId
    parentProcessId = [uint32]$observed.parentProcessId
    executablePath = ([string]$observed.executablePath).ToUpperInvariant()
    executableSha256 = $expectedHash.ToUpperInvariant()
    creationTimeUtc = '2042-02-03T07:05:06.1234567+03:00'
    ownerSid = [string]$observed.ownerSid
  }
  $normalizedMatching = ConvertTo-PilotWindowsNativeProcessIdentityAssertion -IdentityAssertion $matching
  $null = Compare-PilotWindowsNativeProcessIdentityAssertion `
    -NormalizedAssertion $normalizedMatching `
    -ObservedIdentity $observed
  if ($normalizedMatching.Count -ne 6 -or
      [string]$normalizedMatching.executableSha256 -cne $expectedHash -or
      [long]$normalizedMatching.creationTimeUtc -ne [long](ConvertTo-PilotWindowsNativeProcessAssertionUtcTicks -Value $observed.creationTimeUtc) -or
      [string]$normalizedMatching.ownerSid -cne [string]$observed.ownerSid -or
      (Test-PathExists -Path $missingImagePath)) {
    throw 'The six-field helper match, path/hash normalization, exact UTC conversion, or no-IO path allowance failed.'
  }
  foreach ($field in @('processId', 'parentProcessId', 'executablePath', 'executableSha256', 'creationTimeUtc', 'ownerSid')) {
    $oneFieldAssertion = [ordered]@{}
    $oneFieldAssertion.Add($field, $observed.PSObject.Properties[$field].Value)
    $normalizedOneField = ConvertTo-PilotWindowsNativeProcessIdentityAssertion -IdentityAssertion $oneFieldAssertion
    $null = Compare-PilotWindowsNativeProcessIdentityAssertion -NormalizedAssertion $normalizedOneField -ObservedIdentity $observed
  }

  $script:CurrentSubstep = 'assertion-helper:each-field-divergence'
  $mismatchCases = @(
    [pscustomobject]@{ field = 'processId'; value = 651235 },
    [pscustomobject]@{ field = 'parentProcessId'; value = 651112 },
    [pscustomobject]@{ field = 'executablePath'; value = (Join-Path $script:EvidenceRootFull ('mismatch-image-' + $runId + '.exe')) },
    [pscustomobject]@{ field = 'executableSha256'; value = ('b' * 64) },
    [pscustomobject]@{ field = 'creationTimeUtc'; value = '2042-02-03T04:05:06.1234568Z' },
    [pscustomobject]@{ field = 'ownerSid'; value = 'S-1-1-0' }
  )
  foreach ($case in $mismatchCases) {
    $assertion = [ordered]@{}
    $assertion.Add([string]$case.field, $case.value)
    $normalized = ConvertTo-PilotWindowsNativeProcessIdentityAssertion -IdentityAssertion $assertion
    $forbidden = [string]$case.value
    if (-not (Test-ExpectedPolicyError `
        -Action { Compare-PilotWindowsNativeProcessIdentityAssertion -NormalizedAssertion $normalized -ObservedIdentity $observed } `
        -ExpectedErrorId 'Morrow.WindowsNativeProcess.IdentityMismatch' `
        -ExpectedFields @([string]$case.field) `
        -ForbiddenText @($forbidden) `
        -ExpectedStage 'identity-assertion-comparison')) {
      throw 'A one-field mismatch was not recognized and sanitized.'
    }
  }

  $script:CurrentSubstep = 'assertion-helper:multiple-divergence'
  $multiple = [ordered]@{
    ownerSid = 'S-1-1-0'
    parentProcessId = 651112
    processId = 651235
  }
  $normalizedMultiple = ConvertTo-PilotWindowsNativeProcessIdentityAssertion -IdentityAssertion $multiple
  if (-not (Test-ExpectedPolicyError `
      -Action { Compare-PilotWindowsNativeProcessIdentityAssertion -NormalizedAssertion $normalizedMultiple -ObservedIdentity $observed } `
      -ExpectedErrorId 'Morrow.WindowsNativeProcess.IdentityMismatch' `
      -ExpectedFields @('processId', 'parentProcessId', 'ownerSid') `
      -ForbiddenText @('651235', '651112', 'S-1-1-0') `
      -ExpectedStage 'identity-assertion-comparison')) {
    throw 'Multiple well-formed identity divergences were not returned as field names only.'
  }

  $script:CurrentSubstep = 'assertion-helper:invalid-shapes'
  $duplicateKeys = New-OrderedMap
  $duplicateKeys.Add('processId', 651234)
  $duplicateKeys.Add('PROCESSID', 651234)
  $nonStringKey = [Collections.Hashtable]::new()
  $nonStringKey.Add(42, 'private-nonstring-key-value-' + $runId)
  $unknownKey = 'private-assertion-key-' + $runId
  $unknownValue = 'private-assertion-value-' + $runId
  $badCases = @(
    [pscustomobject]@{ value = 'scalar assertion'; fields = @(); forbidden = @('scalar assertion') },
    [pscustomobject]@{ value = $duplicateKeys; fields = @(); forbidden = @() },
    [pscustomobject]@{ value = $nonStringKey; fields = @(); forbidden = @('private-nonstring-key-value-' + $runId) },
    [pscustomobject]@{ value = ([ordered]@{ $unknownKey = $unknownValue }); fields = @(); forbidden = @($unknownKey, $unknownValue) },
    [pscustomobject]@{ value = ([ordered]@{ processId = $null }); fields = @('processId'); forbidden = @() },
    [pscustomobject]@{ value = ([ordered]@{ processId = '651234' }); fields = @('processId'); forbidden = @('651234') },
    [pscustomobject]@{ value = ([ordered]@{ parentProcessId = 0 }); fields = @('parentProcessId'); forbidden = @() },
    [pscustomobject]@{ value = ([ordered]@{ executablePath = 'relative\missing.exe' }); fields = @('executablePath'); forbidden = @('relative\missing.exe') },
    [pscustomobject]@{ value = ([ordered]@{ executablePath = (Join-Path $script:EvidenceRootFull 'folder\..\missing.exe') }); fields = @('executablePath'); forbidden = @() },
    [pscustomobject]@{ value = ([ordered]@{ executableSha256 = ('a' * 63) }); fields = @('executableSha256'); forbidden = @() },
    [pscustomobject]@{ value = ([ordered]@{ creationTimeUtc = '2042-02-03T04:05:06.1234567' }); fields = @('creationTimeUtc'); forbidden = @() },
    [pscustomobject]@{ value = ([ordered]@{ creationTimeUtc = '2042-02-03T04:05:06+25:00' }); fields = @('creationTimeUtc'); forbidden = @() },
    [pscustomobject]@{ value = ([ordered]@{ ownerSid = 's-1-5-18' }); fields = @('ownerSid'); forbidden = @('s-1-5-18') },
    [pscustomobject]@{ value = ([ordered]@{ ownerSid = 'not-a-sid' }); fields = @('ownerSid'); forbidden = @('not-a-sid') }
  )
  foreach ($case in $badCases) {
    if (-not (Test-ExpectedPolicyError `
        -Action { ConvertTo-PilotWindowsNativeProcessIdentityAssertion -IdentityAssertion $case.value } `
        -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidIdentityAssertion' `
        -ExpectedFields ([string[]]$case.fields) `
        -ForbiddenText ([string[]]$case.forbidden) `
        -ExpectedStage 'identity-assertion-validation')) {
      throw 'An invalid assertion shape/value was not rejected with sanitized diagnostics.'
    }
  }
  $missingObservationError = $null
  try {
    $null = Compare-PilotWindowsNativeProcessIdentityAssertion -NormalizedAssertion $normalizedMatching -ObservedIdentity $null
  } catch { $missingObservationError = $_ }
  if ($null -eq $missingObservationError -or
      ([string]$missingObservationError.Exception.Message).Contains([string]$observed.executablePath) -or
      ([string]$missingObservationError.Exception.Message).Contains([string]$observed.executableSha256) -or
      ([string]$missingObservationError.Exception.Message).Contains([string]$observed.ownerSid)) {
    throw 'A nonempty assertion silently passed an unavailable identity or leaked values.'
  }

  return [ordered]@{
    matchingFields = 6
    individuallyMatchingFields = 6
    individuallyRejectedFields = 6
    malformedInputsRejected = $badCases.Count
    matchingUsedNonexistentSyntacticPath = $true
    diagnosticsContainValues = $false
  }
}

function Test-IndependentInventoryProjection {
  $script:CurrentSubstep = 'inventory-projection:fixtures'
  $now = [DateTime]::SpecifyKind([DateTime]::Parse('2042-02-03T04:05:06.1234567Z'), [DateTimeKind]::Utc)
  $rows = [Collections.Generic.Dictionary[int, object]]::new()
  $counts = [Collections.Generic.Dictionary[int, int]]::new()
  $rows.Add(651234, [pscustomobject]@{ ProcessId = 651234; ParentProcessId = 651111; Name = 'pwsh.exe'; CreationDate = $now })
  $rows.Add(651235, [pscustomobject]@{ ProcessId = 651235; ParentProcessId = 651234; Name = 'pwsh.exe'; CreationDate = $now.AddSeconds(1) })
  $counts.Add(651234, 1)
  $counts.Add(651235, 1)

  $script:CurrentSubstep = 'inventory-projection:stable-members'
  $stable = @(Get-PilotWindowsNativeProcessObservationMembers `
    -BeforeProcessIds ([int[]]@(651234, 651235)) `
    -AfterProcessIds ([int[]]@(651234, 651235)) `
    -QueriedProcessIds ([int[]]@(651234, 651235)) `
    -RowsById $rows -RowCounts $counts -CimSucceeded $true -BeforeReadSucceeded $true -AfterReadSucceeded $true)
  $stableMetadata = $stable[0].metadata
  $stableNames = @($stableMetadata.PSObject.Properties.Name | Sort-Object)
  if ($stable.Count -ne 2 -or @($stable | Where-Object { $_.state -ceq 'observed' }).Count -ne 2 -or
      ([string]::Join('|', $stableNames) -cne 'creationTimeUtc|name|parentProcessId|processId')) {
    throw 'Stable inventory projection did not return only limited process metadata.'
  }
  if ($stableMetadata.PSObject.Properties['CommandLine'] -or $stableMetadata.PSObject.Properties['ExecutablePath'] -or
      $stableMetadata.PSObject.Properties['OwnerSid'] -or $stableMetadata.PSObject.Properties['executableSha256']) {
    throw 'Descendant inventory exposed unapproved process metadata.'
  }

  $script:CurrentSubstep = 'inventory-projection:arrived-and-disappeared'
  $transitions = @(Get-PilotWindowsNativeProcessObservationMembers `
    -BeforeProcessIds ([int[]]@(651234, 651236)) `
    -AfterProcessIds ([int[]]@(651234, 651235)) `
    -QueriedProcessIds ([int[]]@(651234, 651236)) `
    -RowsById $rows -RowCounts $counts -CimSucceeded $true -BeforeReadSucceeded $true -AfterReadSucceeded $true)
  $disappeared = @($transitions | Where-Object { $_.processId -eq 651236 })
  $arrived = @($transitions | Where-Object { $_.processId -eq 651235 })
  if ($disappeared.Count -ne 1 -or $disappeared[0].state -cne 'disappeared' -or $null -ne $disappeared[0].metadata -or
      $arrived.Count -ne 1 -or $arrived[0].state -cne 'arrived' -or $null -ne $arrived[0].metadata) {
    throw 'Inventory membership changes were not represented explicitly without invented metadata.'
  }

  $script:CurrentSubstep = 'inventory-projection:unavailable-is-not-empty'
  $unavailableMembers = @(Get-PilotWindowsNativeProcessObservationMembers `
    -BeforeProcessIds ([int[]]@(651234)) `
    -AfterProcessIds ([int[]]@(651234)) `
    -QueriedProcessIds ([int[]]@(651234)) `
    -RowsById ([Collections.Generic.Dictionary[int, object]]::new()) `
    -RowCounts ([Collections.Generic.Dictionary[int, int]]::new()) `
    -CimSucceeded $false -BeforeReadSucceeded $true -AfterReadSucceeded $true)
  $unavailableStatus = Get-PilotWindowsNativeProcessObservationInventoryStatus `
    -SnapshotsAvailable $true -CimRowsAvailable $false -MemberCountBefore 1 -MemberCountAfter 1 `
    -HasInvalidMembers $false -IsTruncated $false -HasUnobservableMembers $true `
    -HasTransitions $false -IdentityUnavailable $false -IsConfirmedEmpty $false
  $emptyStatus = Get-PilotWindowsNativeProcessObservationInventoryStatus `
    -SnapshotsAvailable $true -CimRowsAvailable $true -MemberCountBefore 0 -MemberCountAfter 0 `
    -HasInvalidMembers $false -IsTruncated $false -HasUnobservableMembers $false `
    -HasTransitions $false -IdentityUnavailable $false -IsConfirmedEmpty $true
  if ($unavailableMembers.Count -ne 1 -or $unavailableMembers[0].state -cne 'unobservable' -or
      $unavailableStatus -cne 'unavailable' -or $emptyStatus -cne 'empty') {
    throw 'Unavailable CIM data was confused with an empty Job inventory.'
  }

  $script:CurrentSubstep = 'inventory-projection:final-snapshot-generation'
  $finalSnapshotMembers = @(Get-PilotWindowsNativeProcessObservationMembers `
    -BeforeProcessIds ([int[]]@(651234)) -AfterProcessIds ([int[]]@()) `
    -QueriedProcessIds ([int[]]@(651234)) -RowsById $rows -RowCounts $counts `
    -CimSucceeded $true -BeforeReadSucceeded $true -AfterReadSucceeded $false)
  $finalSnapshotStatus = Get-PilotWindowsNativeProcessObservationInventoryStatus `
    -SnapshotsAvailable $false -CimRowsAvailable $true -MemberCountBefore 1 -MemberCountAfter 0 `
    -HasInvalidMembers $false -IsTruncated $false -HasUnobservableMembers $true `
    -HasTransitions $false -IdentityUnavailable $true -IsConfirmedEmpty $false
  if ($finalSnapshotMembers.Count -ne 1 -or $finalSnapshotMembers[0].state -cne 'unobservable' -or
      $finalSnapshotStatus -cne 'unavailable') {
    throw 'A missing final synchronized snapshot was incorrectly reported as a disappeared member.'
  }

  return [ordered]@{
    stableRowsProjected = $stable.Count
    membershipTransitionsExplicit = $true
    unavailableDistinctFromEmpty = $true
    missingFinalSnapshotIsUnavailable = $true
    descendantMetadataLimited = $true
  }
}

function Invoke-ExpectedPolicyFailure {
  param(
    [Parameter(Mandatory)][AllowNull()][object] $Descriptor,
    [Parameter(Mandatory)][string] $ExpectedErrorId,
    [string] $ExpectedStage,
    [switch] $ExpectCompleteCleanup,
    [string] $ExpectedField
  )

  $script:PolicyFailureCandidate = $null
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
  $script:PolicyFailureCandidate = $caught

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
  $script:PolicyFailureCandidate = $null
  return $diagnostics
}

function New-CaseRoot {
  param([Parameter(Mandatory)][string] $Name)
  $script:CaseCounter++
  $leaf = '{0}-{1}-{2}' -f $Name, $script:CaseCounter, [Guid]::NewGuid().ToString('N')
  $path = Join-Path $script:EvidenceRootFull (Join-Path 'cases' $leaf)
  [void](Assert-StrictChildPath -Path $path -Root $script:RunnerTempFull -Message 'A case directory escaped RUNNER_TEMP.')
  [void][IO.Directory]::CreateDirectory($path)
  [IO.File]::WriteAllText((Join-Path $path '.issue-236-independent-owner'), [Guid]::NewGuid().ToString('N'), $script:Utf8NoBom)
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
$processPath = [Environment]::ProcessPath
if ([string]::IsNullOrWhiteSpace($processPath)) { throw 'The fixture could not identify its PowerShell process image.' }
$processHome = [IO.Path]::GetDirectoryName($processPath)
if ([string]::IsNullOrWhiteSpace($processHome)) { throw 'The fixture process image has no executable directory.' }
$powerShellPathPrefix = $processHome + [IO.Path]::PathSeparator
$expectedRuntimePath = if ($ExpectedPath.StartsWith($powerShellPathPrefix, [StringComparison]::Ordinal)) { $ExpectedPath } else { $powerShellPathPrefix + $ExpectedPath }
$processRows = @(Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = {0}' -f $PID) -ErrorAction Stop)
$commandLine = if ($processRows.Count -eq 1) { [string]$processRows[0].CommandLine } else { '' }
$receipt = [ordered]@{
  schemaVersion = 1
  processId = [int]$PID
  argumentSpacePreserved = ($SpaceValue -ceq 'issue225 argument with spaces')
  argumentUnicodePreserved = ($UnicodeValue -ceq 'issue225-á漢')
  systemRootMatches = ([string]$env:SYSTEMROOT -ceq $ExpectedSystemRoot)
  windirMatches = ([string]$env:WINDIR -ceq $ExpectedSystemRoot)
  pathMatches = ([string]$env:PATH -ceq $expectedRuntimePath)
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

function Initialize-TestProcessImageQuery {
  $typeName = 'Morrow.Pilot.IndependentProcessImageQuery'
  if ($null -eq ($typeName -as [type])) {
    $source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Morrow.Pilot
{
    public static class IndependentProcessImageQuery
    {
        [DllImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryFullProcessImageNameW(
            SafeProcessHandle processHandle,
            uint flags,
            StringBuilder imagePath,
            ref uint imagePathLength);

        public static string Read(SafeProcessHandle processHandle)
        {
            if (processHandle == null || processHandle.IsInvalid || processHandle.IsClosed)
            {
                throw new InvalidOperationException("The retained test process handle is unavailable.");
            }

            var imagePath = new StringBuilder(32768);
            uint imagePathLength = (uint)imagePath.Capacity;
            if (!QueryFullProcessImageNameW(processHandle, 0, imagePath, ref imagePathLength))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "QueryFullProcessImageNameW failed for the retained test process handle.");
            }

            return imagePath.ToString();
        }
    }
}
'@
    Add-Type -TypeDefinition $source -ErrorAction Stop | Out-Null
  }
  if ($null -eq ($typeName -as [type])) { throw 'The independent test process image query helper did not load.' }
}

function Get-TestProcessImagePath {
  param([Parameter(Mandatory)][object] $SafeProcessHandle)
  if ($SafeProcessHandle -isnot [Microsoft.Win32.SafeHandles.SafeProcessHandle]) {
    throw 'The independent test process does not have its retained SafeProcessHandle.'
  }
  $imagePath = [Morrow.Pilot.IndependentProcessImageQuery]::Read($SafeProcessHandle)
  if ([string]::IsNullOrWhiteSpace($imagePath)) { throw 'The retained process handle returned no executable image path.' }
  return [IO.Path]::GetFullPath($imagePath)
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
  $expectedImagePath = [IO.Path]::GetFullPath($ExecutablePath)
  $psi = New-ProcessStartInfo -ExecutablePath $ExecutablePath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory -Environment $Environment
  $script:CurrentSubstep = $Role + ':process-start'
  $process = [Diagnostics.Process]::Start($psi)
  if ($null -eq $process) { throw 'The independent test process could not be started.' }
  $record = [pscustomobject]@{
    role = $Role
    process = $process
    safeProcessHandle = $null
    processId = $null
    expectedImagePath = $expectedImagePath
    imagePath = $null
    creationTimeUtc = $null
    exitCode = $null
    hasExited = $false
    emergencyCleanup = $false
    imageObservationFailed = $false
  }
  [void]$script:TrackedProcesses.Add($record)
  try {
    $script:CurrentSubstep = $Role + ':handle-capture'
    $record.safeProcessHandle = $process.SafeHandle
    $script:CurrentSubstep = $Role + ':pid-observation'
    $record.processId = [int]$process.Id
    $script:CurrentSubstep = $Role + ':image-observation'
    $record.imagePath = Get-TestProcessImagePath -SafeProcessHandle $record.safeProcessHandle
    if (-not [string]::Equals([string]$record.imagePath, [string]$record.expectedImagePath, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'A test process image did not match the staged executable.'
    }
    $script:CurrentSubstep = $Role + ':creation-time-observation'
    $record.creationTimeUtc = $process.StartTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)
  } catch {
    $record.imageObservationFailed = $true
    throw
  }
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
      sixFieldIdentityMatched = $true
      retainedProcessHandleTimeMatched = ([Math]::Abs(($cimTime - $handleTime).Ticks) -le 20)
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

  $script:RuntimeRoot = Join-Path $script:RunnerTempFull ('issue-236-independent-runtime-' + $script:RuntimeOwnerMarker)
  [void](Assert-StrictChildPath -Path $script:RuntimeRoot -Root $script:RunnerTempFull -Message 'The private PowerShell runtime staging path escaped RUNNER_TEMP.')
  if (Test-PathExists -Path $script:RuntimeRoot) { throw 'The private PowerShell runtime staging path already exists.' }
  [void][IO.Directory]::CreateDirectory($script:RuntimeRoot)
  [IO.File]::WriteAllText((Join-Path $script:RuntimeRoot '.issue-236-independent-owner'), $script:RuntimeOwnerMarker, $script:Utf8NoBom)
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
  $script:CurrentSubstep = 'dot-source:prepare'
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
  $environment.Add('MORROW_236_DOT_SOURCE_PROBE', [Guid]::NewGuid().ToString('N'))
  $arguments = @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', $probePath,
    '-PolicyPath', $script:PolicyFullPath,
    '-ProcessAdapterPath', $script:ProcessAdapterPath,
    '-JobAdapterPath', $script:JobAdapterPath,
    '-ReceiptPath', $probeReceiptPath,
    '-MarkerPath', $markerPath,
    '-ExpectedExecutablePath', $script:PwshPath
  )
  $script:CurrentSubstep = 'dot-source:process-start'
  $record = Start-ObservedTestProcess -Role 'dot-source-probe' -ExecutablePath $script:PwshPath -ArgumentList $arguments -WorkingDirectory $caseRoot -Environment $environment
  $script:CurrentSubstep = 'dot-source:probe-result'
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
  $script:CurrentSubstep = 'outsider:prepare'
  $caseRoot = New-CaseRoot -Name 'outsider'
  $descriptor = New-ValidDescriptor -CaseRoot $caseRoot -ArgumentList @('unused') -ExpectedParentProcessId ([int]$PID) -ExpectedOwnerSid ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
  $fixtureArgs = Get-NewFixtureArguments -CaseRoot $caseRoot -Role 'outsider'
  $environment = $descriptor.environment
  $script:CurrentSubstep = 'outsider:process-start'
  $record = Start-ObservedTestProcess -Role 'outsider' -ExecutablePath $script:PwshPath -ArgumentList $fixtureArgs.arguments -WorkingDirectory $caseRoot -Environment $environment
  $script:Outsider = [pscustomobject]@{
    process = $record.process
    safeProcessHandle = $record.safeProcessHandle
    processId = $record.processId
    imagePath = $record.imagePath
    creationTimeUtc = $record.creationTimeUtc
    markerPath = $fixtureArgs.markerPath
    receiptPath = $fixtureArgs.receiptPath
    marker = $fixtureArgs.marker
  }
  $script:CurrentSubstep = 'outsider:receipt-wait'
  Wait-ForFile -Path $fixtureArgs.receiptPath -TimeoutMs 10000 -Description 'the uncontained outsider receipt'
  Wait-ForFile -Path $fixtureArgs.markerPath -TimeoutMs 10000 -Description 'the uncontained outsider marker'
  if ($script:Outsider.process.HasExited) { throw 'The outsider exited before containment checks began.' }
  return [ordered]@{
    started = $true
    retainedImageIdentityMatched = $true
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
    identityRevalidated = $true
    retainedProcessStayedAlive = $true
    retainedImageIdentityMatched = $true
  })
  $image = Get-TestProcessImagePath -SafeProcessHandle $script:Outsider.safeProcessHandle
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
  $script:CurrentSubstep = 'positive:prepare'
  $caseRoot = New-CaseRoot -Name 'positive-start'
  $fixtureArgs = Get-NewFixtureArguments -CaseRoot $caseRoot -Role 'positive'
  $ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $descriptor = New-ValidDescriptor -CaseRoot $caseRoot -ArgumentList $fixtureArgs.arguments -ExpectedParentProcessId ([int]$PID) -ExpectedOwnerSid $ownerSid
  $descriptor['expectedParentProcessId'] = [long]$PID
  $canaryPath = 'Env:\' + $script:EnvironmentCanaryName
  $originalCanaryItem = Get-Item -LiteralPath $canaryPath -ErrorAction SilentlyContinue
  $script:OriginalCanaryExisted = $null -ne $originalCanaryItem
  $script:OriginalCanaryValue = if ($script:OriginalCanaryExisted) { [string]$originalCanaryItem.Value } else { $null }
  $script:CanaryWasSet = $true
  [Environment]::SetEnvironmentVariable($script:EnvironmentCanaryName, $script:EnvironmentCanaryValue, [EnvironmentVariableTarget]::Process)
  $script:CurrentSubstep = 'positive:start-policy'
  $startOutput = @(Start-WindowsNativeProcess -Descriptor $descriptor -Verbose 4>&1)
  $returnedCapsules = @($startOutput | Where-Object { $_ -is [Morrow.Pilot.WindowsNativeProcessCapsule] })
  $verboseMessages = @($startOutput | Where-Object { $_ -is [System.Management.Automation.VerboseRecord] } | ForEach-Object { [string]$_.Message })
  if ($returnedCapsules.Count -ne 1) { throw 'Start did not return exactly one opaque capsule.' }
  $capsule = $returnedCapsules[0]
  [void]$script:Capsules.Add($capsule)
  $script:CurrentSubstep = 'positive:resume-order-proof'
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
  $script:CurrentSubstep = 'positive:fixture-receipt'
  $fixtureReceipt = Wait-ForFixtureReceipt -ReceiptPath $fixtureArgs.receiptPath -MarkerPath $fixtureArgs.markerPath -TimeoutMs 10000
  Assert-ReceiptBooleanFields -Receipt $fixtureReceipt
  $script:CurrentSubstep = 'positive:cim-identity'
  $identity = Get-ProcessIdentityRecord -ProcessId ([int]$fixtureReceipt.processId)
  Assert-CimIdentityMatchesDescriptor -Identity $identity -Descriptor $descriptor -ReceiptProcessId ([int]$fixtureReceipt.processId)
  [void]$script:CaseOutcomes.Add([ordered]@{
    name = 'positive-start'
    status = 'passed'
    sixFieldIdentityMatched = $true
    parentAndOwnerMatched = $true
    markerObservedAfterStart = [IO.File]::Exists($fixtureArgs.markerPath)
    identityProofPrecededInternalResume = $true
  })

  $script:CurrentSubstep = 'positive:capsule-dispose'
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
  $script:CurrentSubstep = 'positive:outsider-preserved'
  Assert-OutsiderStillAlive
  $script:CleanupNotes.Add('positive capsule Dispose verified empty Job and exited root; outsider retained and alive')
  return [ordered]@{
    capsuleTypeOpaque = $true
    fixtureEnvironmentMatched = $true
    fixtureCredentialNamesAbsent = [bool]$fixtureReceipt.githubVariableNamesAbsent -and [bool]$fixtureReceipt.actionsVariableNamesAbsent -and [bool]$fixtureReceipt.githubTokenAbsent
    identityRevalidatedIndependently = $true
    verboseEvidence = [ordered]@{ identityProofPrecededResume = $true; messageCount = $verboseMessages.Count }
    cleanup = [ordered]@{ jobEmpty = [bool]$cleanup.jobEmpty; rootExited = [bool]$cleanup.rootExited }
    disposeElapsedMs = $watch.ElapsedMilliseconds
    repeatDisposeElapsedMs = $secondWatch.ElapsedMilliseconds
    outsiderAlive = $true
  }
}

function Get-IndependentCimIdentitySnapshot {
  param([Parameter(Mandatory)][int] $ProcessId)
  if ($ProcessId -lt 1) { throw 'Independent CIM requires a positive synthetic-process identity.' }

  $rows = @(Get-CimInstance -ClassName Win32_Process `
    -Filter ('ProcessId = ' + [string]$ProcessId) `
    -OperationTimeoutSec 5 -ErrorAction Stop)
  if ($rows.Count -ne 1 -or $null -eq $rows[0]) { throw 'Independent CIM did not return exactly one row for the synthetic process.' }
  $row = $rows[0]
  if ([int]$row.ProcessId -ne $ProcessId -or [int]$row.ParentProcessId -lt 1) {
    throw 'Independent CIM returned invalid synthetic process identity fields.'
  }
  if ($row.CreationDate -is [datetime]) {
    $creation = $row.CreationDate.ToUniversalTime()
  } elseif ($row.CreationDate -is [string] -and -not [string]::IsNullOrEmpty([string]$row.CreationDate)) {
    $creation = [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$row.CreationDate).ToUniversalTime()
  } else {
    throw 'Independent CIM returned an unsupported synthetic creation-time value.'
  }
  $owner = Invoke-CimMethod -InputObject $row -MethodName GetOwnerSid -OperationTimeoutSec 5 -ErrorAction Stop
  if ($null -eq $owner -or [int]$owner.ReturnValue -ne 0 -or [string]::IsNullOrWhiteSpace([string]$owner.Sid)) {
    throw 'Independent CIM did not return a successful owner SID for the synthetic process.'
  }
  $sid = [Security.Principal.SecurityIdentifier]::new([string]$owner.Sid)
  if ($sid.Value -cne [string]$owner.Sid) { throw 'Independent CIM returned a noncanonical owner SID.' }
  return [pscustomobject][ordered]@{
    processId = [int]$row.ProcessId
    parentProcessId = [int]$row.ParentProcessId
    creationTimeUtc = $creation.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    ownerSid = $sid.Value
    row = $row
  }
}

function Test-IndependentObserveAndRootExitInventory {
  $script:SafeObserveInventoryEvidence = $null
  $script:CurrentSubstep = 'observe-independent:prepare'
  $caseRoot = New-CaseRoot -Name 'observe-root-descendant'
  $descendantReadyPath = Join-Path $caseRoot 'descendant-ready.marker'
  $descendantPidPath = Join-Path $caseRoot 'descendant.pid'
  $rootReadyPath = Join-Path $caseRoot 'root-ready.marker'
  $rootPidPath = Join-Path $caseRoot 'root.pid'
  $releasePath = Join-Path $caseRoot 'root-release.signal'
  $descendantScriptPath = Join-Path $caseRoot 'descendant.ps1'
  $rootScriptPath = Join-Path $caseRoot 'root.ps1'
  [void](Assert-StrictChildPath -Path $descendantScriptPath -Root $caseRoot -Message 'The synthetic descendant script escaped its private fixture directory.')
  [void](Assert-StrictChildPath -Path $rootScriptPath -Root $caseRoot -Message 'The synthetic root script escaped its private fixture directory.')

  $descendantSource = @'
[CmdletBinding()]
param([Parameter(Mandatory)][string] $ReadyPath)
$ErrorActionPreference = 'Stop'
[IO.File]::WriteAllText($ReadyPath, 'ready', [Text.UTF8Encoding]::new($false))
$deadline = [DateTime]::UtcNow.AddSeconds(180)
while ([DateTime]::UtcNow -lt $deadline) { [Threading.Thread]::Sleep(50) }
'@
  $rootSource = @'
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string] $PowerShellPath,
  [Parameter(Mandatory)][string] $DescendantScriptPath,
  [Parameter(Mandatory)][string] $DescendantReadyPath,
  [Parameter(Mandatory)][string] $DescendantPidPath,
  [Parameter(Mandatory)][string] $RootReadyPath,
  [Parameter(Mandatory)][string] $RootPidPath,
  [Parameter(Mandatory)][string] $ReleasePath
)
$ErrorActionPreference = 'Stop'
[IO.File]::WriteAllText($RootPidPath, [string]$PID, [Text.UTF8Encoding]::new($false))
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = $PowerShellPath
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $DescendantScriptPath, $DescendantReadyPath)) {
  [void]$info.ArgumentList.Add([string]$argument)
}
$descendant = [Diagnostics.Process]::Start($info)
if ($null -eq $descendant) { exit 93 }
[IO.File]::WriteAllText($DescendantPidPath, [string]$descendant.Id, [Text.UTF8Encoding]::new($false))
$descendant.Dispose()
$readyDeadline = [DateTime]::UtcNow.AddSeconds(15)
while (-not [IO.File]::Exists($DescendantReadyPath) -and [DateTime]::UtcNow -lt $readyDeadline) {
  [Threading.Thread]::Sleep(50)
}
if (-not [IO.File]::Exists($DescendantReadyPath)) { exit 94 }
[IO.File]::WriteAllText($RootReadyPath, 'ready', [Text.UTF8Encoding]::new($false))
$releaseDeadline = [DateTime]::UtcNow.AddSeconds(90)
while (-not [IO.File]::Exists($ReleasePath) -and [DateTime]::UtcNow -lt $releaseDeadline) {
  [Threading.Thread]::Sleep(50)
}
if (-not [IO.File]::Exists($ReleasePath)) { exit 95 }
exit 0
'@
  [IO.File]::WriteAllText($descendantScriptPath, $descendantSource, $script:Utf8NoBom)
  [IO.File]::WriteAllText($rootScriptPath, $rootSource, $script:Utf8NoBom)

  $observeCapsule = $null
  $rootWaitProcess = $null
  $descendantWaitProcess = $null
  $cleanupConfirmed = $false
  $descendantProcessId = 0
  $rootProcessId = 0
  $cleanupElapsedMs = $null
  try {
    $script:CurrentSubstep = 'observe-independent:start-synthetic-tree'
    $arguments = [string[]]@(
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', $rootScriptPath,
      $script:PwshPath, $descendantScriptPath, $descendantReadyPath, $descendantPidPath,
      $rootReadyPath, $rootPidPath, $releasePath
    )
    $descriptor = New-ValidDescriptor `
      -CaseRoot $caseRoot `
      -ArgumentList $arguments `
      -ExpectedParentProcessId ([int]$PID) `
      -ExpectedOwnerSid ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    $startOutput = @(Start-WindowsNativeProcess -Descriptor $descriptor -Verbose 4>&1)
    $capsuleType = 'Morrow.Pilot.WindowsNativeProcessCapsule' -as [type]
    $capsules = @($startOutput | Where-Object { $null -ne $capsuleType -and $capsuleType.IsInstanceOfType($_) })
    if ($capsules.Count -ne 1) { throw 'The synthetic tree start did not return exactly one opaque capsule.' }
    $observeCapsule = $capsules[0]
    [void]$script:Capsules.Add($observeCapsule)
    Assert-StartResultOpaque -Capsule $observeCapsule

    foreach ($wait in @(
        @{ path = $descendantReadyPath; description = 'synthetic descendant readiness' },
        @{ path = $descendantPidPath; description = 'synthetic descendant identity receipt' },
        @{ path = $rootReadyPath; description = 'synthetic root readiness' },
        @{ path = $rootPidPath; description = 'synthetic root identity receipt' }
      )) {
      Wait-ForFile -Path $wait.path -TimeoutMs 15000 -Description $wait.description
    }
    try { $rootProcessId = [int][IO.File]::ReadAllText($rootPidPath) } catch { $rootProcessId = 0 }
    try { $descendantProcessId = [int][IO.File]::ReadAllText($descendantPidPath) } catch { $descendantProcessId = 0 }
    if ($rootProcessId -lt 1 -or $descendantProcessId -lt 1 -or $rootProcessId -eq $descendantProcessId) {
      throw 'The synthetic root or descendant identity receipt was invalid.'
    }

    # Retain test-only wait handles while both synthetic processes are known live.
    # These handles are never passed to the policy or used to terminate a process.
    $rootWaitProcess = [Diagnostics.Process]::GetProcessById($rootProcessId)
    $descendantWaitProcess = [Diagnostics.Process]::GetProcessById($descendantProcessId)
    $null = $rootWaitProcess.Handle
    $null = $descendantWaitProcess.Handle
    Assert-True -Condition (-not $rootWaitProcess.HasExited -and -not $descendantWaitProcess.HasExited) -Message 'A synthetic process exited before the Observe checks began.'

    $script:CurrentSubstep = 'observe-independent:live-root-proof'
    $observeClock = [Diagnostics.Stopwatch]::StartNew()
    $liveObservation = Observe-WindowsNativeProcess -Capsule $observeCapsule
    $observeClock.Stop()
    Assert-True -Condition ($observeClock.ElapsedMilliseconds -le 12000) -Message 'A live Observe exceeded the inventory and identity time budget.'
    Assert-Equal -Actual ([string]$liveObservation.root.state) -Expected 'alive' -Message 'Observe did not report the live synthetic root.'
    Assert-Equal -Actual ([string]$liveObservation.root.identityStatus) -Expected 'fresh' -Message 'Observe did not report a fresh live-root identity.'
    Assert-True -Condition ([bool]$liveObservation.root.identityFresh) -Message 'Observe marked the live root identity as stale.'
    if ($null -ne $liveObservation.root.exitCode) { throw 'Observe reported an exit code for the live root.' }

    $rootCim = Get-IndependentCimIdentitySnapshot -ProcessId $rootProcessId
    $descendantCim = Get-IndependentCimIdentitySnapshot -ProcessId $descendantProcessId
    $liveIdentity = $liveObservation.root.identity
    $identityNames = @($liveIdentity.PSObject.Properties.Name | Sort-Object)
    $expectedIdentityNames = @('creationTimeUtc', 'executablePath', 'executableSha256', 'ownerSid', 'parentProcessId', 'processId')
    if ([string]::Join('|', $identityNames) -cne [string]::Join('|', $expectedIdentityNames)) {
      throw 'The live Observe identity did not contain exactly the six contract fields.'
    }
    $knownImagePath = Get-CanonicalFullPath -Path $script:PwshPath
    $knownImageHash = Get-Sha256 -Path $knownImagePath
    $independentNativeImagePath = Get-TestProcessImagePath -SafeProcessHandle $rootWaitProcess.SafeHandle
    Assert-Equal -Actual $independentNativeImagePath -Expected $knownImagePath -IgnoreCase -Message 'The independent retained root handle did not identify the staged executable.'
    Assert-Equal -Actual ([int]$liveIdentity.processId) -Expected $rootProcessId -Message 'Fresh root PID differed from the independent fixture and CIM.'
    Assert-Equal -Actual ([int]$liveIdentity.parentProcessId) -Expected ([int]$rootCim.parentProcessId) -Message 'Fresh root parent differed from independent CIM.'
    Assert-Equal -Actual ([int]$rootCim.parentProcessId) -Expected ([int]$PID) -Message 'Independent CIM parent differed from the test process.'
    Assert-Equal -Actual ([string]$liveIdentity.executablePath) -Expected $knownImagePath -IgnoreCase -Message 'Fresh root image differed from the staged executable.'
    Assert-Equal -Actual ([string]$liveIdentity.executableSha256).ToLowerInvariant() -Expected $knownImageHash -Message 'Fresh root digest differed from the independent known-file digest.'
    Assert-Equal -Actual ([string]$liveIdentity.ownerSid) -Expected ([string]$rootCim.ownerSid) -Message 'Fresh root SID differed from independent CIM.'
    $observedRootTime = [DateTimeOffset]::Parse([string]$liveIdentity.creationTimeUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None)
    $independentRootTime = [DateTimeOffset]::Parse([string]$rootCim.creationTimeUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None)
    if ($observedRootTime.UtcDateTime.Ticks -ne $independentRootTime.UtcDateTime.Ticks) { throw 'Fresh root creation time differed from independent CIM.' }
    $retainedRootTime = $rootWaitProcess.StartTime.ToUniversalTime()
    if ([Math]::Abs(($retainedRootTime - $independentRootTime.UtcDateTime).Ticks) -gt 20) {
      throw 'Independent root CIM time differed from the test-retained process handle.'
    }

    $expectedAssertion = [ordered]@{
      processId = $rootProcessId
      parentProcessId = [int]$rootCim.parentProcessId
      executablePath = $knownImagePath
      executableSha256 = $knownImageHash
      creationTimeUtc = $rootCim.creationTimeUtc
      ownerSid = [string]$rootCim.ownerSid
    }
    $alternateTimestamp = $independentRootTime.ToOffset([TimeSpan]::FromHours(3)).ToString("yyyy-MM-dd'T'HH:mm:ss.fffffffzzz", [Globalization.CultureInfo]::InvariantCulture)
    $alternateCaseAssertion = [ordered]@{
      processId = [long]$expectedAssertion.processId
      parentProcessId = [uint32]$expectedAssertion.parentProcessId
      executablePath = ([string]$expectedAssertion.executablePath).ToUpperInvariant()
      executableSha256 = ([string]$expectedAssertion.executableSha256).ToUpperInvariant()
      creationTimeUtc = $alternateTimestamp
      ownerSid = [string]$expectedAssertion.ownerSid
    }
    $script:CurrentSubstep = 'observe-independent:matching-six-field-assertion'
    $matchingObservation = Observe-WindowsNativeProcess -Capsule $observeCapsule -IdentityAssertion $alternateCaseAssertion
    Assert-Equal -Actual ([string]$matchingObservation.root.identityStatus) -Expected 'fresh' -Message 'A matching six-field assertion did not return a fresh identity.'

    $script:CurrentSubstep = 'observe-independent:malformed-assertions'
    if (-not (Test-ExpectedPolicyError `
        -Action { Observe-WindowsNativeProcess -Capsule ([pscustomobject]@{ session = 'private-fake-capsule' }) } `
        -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidCapsule' `
        -ExpectedStage 'observe-capsule-validation' `
        -ExpectedCommand 'Observe-WindowsNativeProcess' `
        -ExpectedCategory 'InvalidOperation')) {
      throw 'Observe did not reject a caller-shaped fake capsule with its public safe error identity.'
    }
    $duplicatePublicKeys = New-OrderedMap
    $duplicatePublicKeys.Add('processId', $rootProcessId)
    $duplicatePublicKeys.Add('PROCESSID', $rootProcessId)
    $unknownField = 'private-observe-field-' + [Guid]::NewGuid().ToString('N')
    $unknownValue = 'private-observe-value-' + [Guid]::NewGuid().ToString('N')
    $malformedCases = @(
      [pscustomobject]@{ value = 'private-scalar-assertion'; fields = @(); forbidden = @('private-scalar-assertion') },
      [pscustomobject]@{ value = $duplicatePublicKeys; fields = @(); forbidden = @() },
      [pscustomobject]@{ value = ([ordered]@{ $unknownField = $unknownValue }); fields = @(); forbidden = @($unknownField, $unknownValue) },
      [pscustomobject]@{ value = ([ordered]@{ ownerSid = $null }); fields = @('ownerSid'); forbidden = @() },
      [pscustomobject]@{ value = ([ordered]@{ processId = 'private-not-an-integer' }); fields = @('processId'); forbidden = @('private-not-an-integer') }
    )
    foreach ($case in $malformedCases) {
      if (-not (Test-ExpectedPolicyError `
          -Action { Observe-WindowsNativeProcess -Capsule $observeCapsule -IdentityAssertion $case.value } `
          -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidIdentityAssertion' `
          -ExpectedFields ([string[]]$case.fields) `
          -ForbiddenText ([string[]]$case.forbidden) `
          -ExpectedStage 'identity-assertion-validation' `
          -ExpectedCommand 'Observe-WindowsNativeProcess' `
          -ExpectedCategory 'InvalidArgument')) {
        throw 'Observe did not reject a malformed assertion with its public safe error identity.'
      }
    }

    $script:CurrentSubstep = 'observe-independent:all-six-divergences'
    $wrongPath = Join-Path $caseRoot 'syntactically-valid-but-absent.exe'
    $wrongHash = if ([string]$expectedAssertion.executableSha256 -match '\Aa') {
      'b' + ([string]$expectedAssertion.executableSha256).Substring(1)
    } else {
      'a' + ([string]$expectedAssertion.executableSha256).Substring(1)
    }
    $wrongTime = $independentRootTime.AddTicks(1).ToString("yyyy-MM-dd'T'HH:mm:ss.fffffffzzz", [Globalization.CultureInfo]::InvariantCulture)
    $wrongSid = if ([string]$expectedAssertion.ownerSid -ceq 'S-1-1-0') { 'S-1-5-18' } else { 'S-1-1-0' }
    $divergences = @(
      [pscustomobject]@{ field = 'processId'; value = [int]$rootProcessId + 1 },
      [pscustomobject]@{ field = 'parentProcessId'; value = [int]$expectedAssertion.parentProcessId + 1 },
      [pscustomobject]@{ field = 'executablePath'; value = $wrongPath },
      [pscustomobject]@{ field = 'executableSha256'; value = $wrongHash },
      [pscustomobject]@{ field = 'creationTimeUtc'; value = $wrongTime },
      [pscustomobject]@{ field = 'ownerSid'; value = $wrongSid }
    )
    foreach ($case in $divergences) {
      $oneField = [ordered]@{}
      $oneField.Add([string]$case.field, $case.value)
      if (-not (Test-ExpectedPolicyError `
          -Action { Observe-WindowsNativeProcess -Capsule $observeCapsule -IdentityAssertion $oneField } `
          -ExpectedErrorId 'Morrow.WindowsNativeProcess.IdentityMismatch' `
          -ExpectedFields @([string]$case.field) `
          -ForbiddenText @([string]$case.value) `
          -ExpectedStage 'identity-assertion-comparison' `
          -ExpectedCommand 'Observe-WindowsNativeProcess')) {
        throw 'Observe did not reject an individual well-formed identity divergence with sanitized diagnostics.'
      }
    }
    $afterDivergences = Observe-WindowsNativeProcess -Capsule $observeCapsule -IdentityAssertion $expectedAssertion
    Assert-Equal -Actual ([string]$afterDivergences.root.identityStatus) -Expected 'fresh' -Message 'A failed assertion destroyed or invalidated the live capsule.'
    $rootWaitProcess.Refresh()
    $descendantWaitProcess.Refresh()
    Assert-True -Condition (-not $rootWaitProcess.HasExited -and -not $descendantWaitProcess.HasExited) -Message 'An assertion failure terminated a synthetic Job member.'
    $script:Outsider.process.Refresh()
    Assert-True -Condition (-not $script:Outsider.process.HasExited) -Message 'An assertion failure terminated the outsider.'

    $script:CurrentSubstep = 'observe-independent:limited-live-inventory'
    $observationNames = @($liveObservation.PSObject.Properties.Name | Sort-Object)
    if ([string]::Join('|', $observationNames) -cne 'inventory|root') { throw 'Observe exposed unexpected top-level fields.' }
    $rootResultNames = @($liveObservation.root.PSObject.Properties.Name | Sort-Object)
    if ([string]::Join('|', $rootResultNames) -cne 'exitCode|identity|identityFresh|identityStatus|state') {
      throw 'Observe exposed unexpected root-result fields.'
    }
    $inventoryResultNames = @($liveObservation.inventory.PSObject.Properties.Name | Sort-Object)
    if ([string]::Join('|', $inventoryResultNames) -cne 'isEmpty|memberCountAfter|memberCountBefore|members|status') {
      throw 'Observe exposed unexpected inventory-result fields.'
    }
    Assert-True -Condition ($liveObservation.inventory.status -ceq 'available' -and -not [bool]$liveObservation.inventory.isEmpty) -Message 'The stable private Job inventory was not reported as available and nonempty.'
    Assert-True -Condition ([int]$liveObservation.inventory.memberCountBefore -le 64 -and [int]$liveObservation.inventory.memberCountAfter -le 64 -and @($liveObservation.inventory.members).Count -le 128) -Message 'Observe exceeded its bounded inventory projection.'
    $rootEntries = @($liveObservation.inventory.members | Where-Object { [int]$_.processId -eq $rootProcessId -and $_.state -ceq 'observed' })
    $descendantEntries = @($liveObservation.inventory.members | Where-Object { [int]$_.processId -eq $descendantProcessId -and $_.state -ceq 'observed' })
    $outsiderEntries = @($liveObservation.inventory.members | Where-Object { [int]$_.processId -eq [int]$script:Outsider.processId })
    if ($rootEntries.Count -ne 1 -or $descendantEntries.Count -ne 1 -or $outsiderEntries.Count -ne 0) {
      throw 'The live inventory did not contain exactly the observed synthetic Job members while excluding the outsider.'
    }
    foreach ($entry in @($rootEntries[0], $descendantEntries[0])) {
      $memberNames = @($entry.PSObject.Properties.Name | Sort-Object)
      if ([string]::Join('|', $memberNames) -cne 'metadata|processId|state') {
        throw 'A Job member entry exposed fields outside the limited projection.'
      }
      $metadataNames = @($entry.metadata.PSObject.Properties.Name | Sort-Object)
      if ([string]::Join('|', $metadataNames) -cne 'creationTimeUtc|name|parentProcessId|processId' -or
          $entry.metadata.PSObject.Properties['CommandLine'] -or $entry.metadata.PSObject.Properties['ExecutablePath'] -or
          $entry.metadata.PSObject.Properties['OwnerSid'] -or $entry.metadata.PSObject.Properties['executableSha256']) {
        throw 'A Job member metadata projection exposed a path, command line, digest, owner, or extra field.'
      }
    }
    Assert-Equal -Actual ([int]$descendantEntries[0].metadata.parentProcessId) -Expected $rootProcessId -Message 'The descendant parent came from something other than independent CIM.'
    Assert-Equal -Actual ([int]$descendantCim.parentProcessId) -Expected $rootProcessId -Message 'Independent CIM did not identify the synthetic root as the descendant parent.'

    $script:CurrentSubstep = 'observe-independent:root-release-signal'
    [IO.File]::WriteAllText($releasePath, 'release', $script:Utf8NoBom)
    $script:CurrentSubstep = 'observe-independent:root-managed-exit-wait'
    if (-not $rootWaitProcess.WaitForExit(15000)) { throw 'The synthetic root did not exit within its bounded wait.' }
    $script:CurrentSubstep = 'observe-independent:root-managed-exit-code'
    Assert-Equal -Actual ([int]$rootWaitProcess.ExitCode) -Expected 0 -Message 'The synthetic root returned a fixture failure code.'
    $script:CurrentSubstep = 'observe-independent:child-remained-alive-after-root-exit'
    $descendantWaitProcess.Refresh()
    Assert-True -Condition (-not $descendantWaitProcess.HasExited) -Message 'The synthetic descendant did not remain alive after its root exited.'

    $script:CurrentSubstep = 'observe-independent:exited-root-observe-call'
    $exitedObservation = Observe-WindowsNativeProcess -Capsule $observeCapsule -IdentityAssertion $expectedAssertion
    $script:CurrentSubstep = 'observe-independent:exited-root-state'
    Assert-Equal -Actual ([string]$exitedObservation.root.state) -Expected 'exited' -Message 'Observe did not report the exited synthetic root.'
    Assert-Equal -Actual ([string]$exitedObservation.root.identityStatus) -Expected 'snapshot' -Message 'Observe did not mark the exited root identity as a snapshot.'
    Assert-True -Condition (-not [bool]$exitedObservation.root.identityFresh) -Message 'The exited root identity was mislabeled fresh.'
    Assert-Equal -Actual ([uint32]$exitedObservation.root.exitCode) -Expected ([uint32]$rootWaitProcess.ExitCode) -Message 'Observe returned an incorrect cached root exit code.'
    $script:CurrentSubstep = 'observe-independent:exited-root-snapshot-fields'
    foreach ($field in @('processId', 'parentProcessId', 'executablePath', 'executableSha256', 'creationTimeUtc', 'ownerSid')) {
      $expectedValue = $liveIdentity.PSObject.Properties[$field].Value
      $snapshotValue = $exitedObservation.root.identity.PSObject.Properties[$field].Value
      if ($field -in @('executablePath', 'executableSha256')) {
        Assert-Equal -Actual ([string]$snapshotValue) -Expected ([string]$expectedValue) -IgnoreCase -Message 'The exited root snapshot differed from its last proved identity.'
      } else {
        Assert-Equal -Actual $snapshotValue -Expected $expectedValue -Message 'The exited root snapshot differed from its last proved identity.'
      }
    }
    $script:CurrentSubstep = 'observe-independent:exited-job-inventory-diagnostics'
    $exitedInventoryMembers = @()
    if ($null -ne $exitedObservation.inventory.members) { $exitedInventoryMembers = @($exitedObservation.inventory.members) }
    $exitedObservedEntries = @($exitedInventoryMembers | Where-Object { $_.state -ceq 'observed' })
    $exitedArrivedEntries = @($exitedInventoryMembers | Where-Object { $_.state -ceq 'arrived' })
    $exitedDisappearedEntries = @($exitedInventoryMembers | Where-Object { $_.state -ceq 'disappeared' })
    $exitedUnobservableEntries = @($exitedInventoryMembers | Where-Object { $_.state -ceq 'unobservable' })
    $exitedDescendantEntries = @($exitedInventoryMembers | Where-Object { [int]$_.processId -eq $descendantProcessId })
    $exitedRootEntries = @($exitedInventoryMembers | Where-Object { [int]$_.processId -eq $rootProcessId })
    $exitedOutsiderEntries = @($exitedInventoryMembers | Where-Object { [int]$_.processId -eq [int]$script:Outsider.processId })
    $otherInventoryEntries = @($exitedInventoryMembers | Where-Object {
      [int]$_.processId -notin @($rootProcessId, $descendantProcessId, [int]$script:Outsider.processId)
    })
    $otherObservedEntries = @($otherInventoryEntries | Where-Object { $_.state -ceq 'observed' })
    $otherArrivedEntries = @($otherInventoryEntries | Where-Object { $_.state -ceq 'arrived' })
    $otherDisappearedEntries = @($otherInventoryEntries | Where-Object { $_.state -ceq 'disappeared' })
    $otherUnobservableEntries = @($otherInventoryEntries | Where-Object { $_.state -ceq 'unobservable' })
    $liveInventoryMembers = @()
    if ($null -ne $liveObservation.inventory.members) { $liveInventoryMembers = @($liveObservation.inventory.members) }
    $knownDescendantObservedCount = @($exitedDescendantEntries | Where-Object { $_.state -ceq 'observed' }).Count
    $exitedBeforeCount = Get-SafeBoundedCount -Value $exitedObservation.inventory.memberCountBefore -Maximum 64
    $exitedAfterCount = Get-SafeBoundedCount -Value $exitedObservation.inventory.memberCountAfter -Maximum 64
    $exitedProjectedCount = Get-SafeBoundedCount -Value $exitedInventoryMembers.Count -Maximum 128
    $liveBeforeCount = Get-SafeBoundedCount -Value $liveObservation.inventory.memberCountBefore -Maximum 64
    $liveAfterCount = Get-SafeBoundedCount -Value $liveObservation.inventory.memberCountAfter -Maximum 64
    $liveProjectedCount = Get-SafeBoundedCount -Value $liveInventoryMembers.Count -Maximum 128
    $inventoryStatusValue = [string]$exitedObservation.inventory.status
    if ($inventoryStatusValue -notin @('available', 'unavailable', 'partial', 'empty')) { $inventoryStatusValue = 'unknown' }
    $safeIsEmptyValue = if ($exitedObservation.inventory.isEmpty -is [bool]) { [bool]$exitedObservation.inventory.isEmpty } else { $null }
    $descendantParentProof = $exitedDescendantEntries.Count -eq 1 -and
      [int]$exitedDescendantEntries[0].metadata.parentProcessId -eq $rootProcessId -and
      [int]$descendantCim.parentProcessId -eq $rootProcessId
    $script:SafeObserveInventoryEvidence = [ordered]@{
      status = $inventoryStatusValue
      isEmpty = $safeIsEmptyValue
      exitedMemberCountBefore = $exitedBeforeCount.value
      exitedMemberCountBeforeValid = $exitedBeforeCount.valid
      exitedMemberCountBeforeCapped = $exitedBeforeCount.capped
      exitedMemberCountAfter = $exitedAfterCount.value
      exitedMemberCountAfterValid = $exitedAfterCount.valid
      exitedMemberCountAfterCapped = $exitedAfterCount.capped
      exitedProjectedMemberCount = $exitedProjectedCount.value
      exitedProjectedMemberCountCapped = $exitedProjectedCount.capped
      liveMemberCountBefore = $liveBeforeCount.value
      liveMemberCountBeforeValid = $liveBeforeCount.valid
      liveMemberCountBeforeCapped = $liveBeforeCount.capped
      liveMemberCountAfter = $liveAfterCount.value
      liveMemberCountAfterValid = $liveAfterCount.valid
      liveMemberCountAfterCapped = $liveAfterCount.capped
      liveProjectedMemberCount = $liveProjectedCount.value
      liveProjectedMemberCountCapped = $liveProjectedCount.capped
      observedCount = (Get-SafeBoundedCount -Value $exitedObservedEntries.Count -Maximum 128).value
      arrivedCount = (Get-SafeBoundedCount -Value $exitedArrivedEntries.Count -Maximum 128).value
      disappearedCount = (Get-SafeBoundedCount -Value $exitedDisappearedEntries.Count -Maximum 128).value
      unobservableCount = (Get-SafeBoundedCount -Value $exitedUnobservableEntries.Count -Maximum 128).value
      knownDescendantEntryCount = (Get-SafeBoundedCount -Value $exitedDescendantEntries.Count -Maximum 128).value
      knownDescendantObservedCount = (Get-SafeBoundedCount -Value $knownDescendantObservedCount -Maximum 128).value
      rootMemberPresent = ($exitedRootEntries.Count -gt 0)
      outsiderMemberPresent = ($exitedOutsiderEntries.Count -gt 0)
      descendantParentMatchesRoot = [bool]$descendantParentProof
      additionalMemberCount = (Get-SafeBoundedCount -Value $otherInventoryEntries.Count -Maximum 128).value
      additionalObservedCount = (Get-SafeBoundedCount -Value $otherObservedEntries.Count -Maximum 128).value
      additionalArrivedCount = (Get-SafeBoundedCount -Value $otherArrivedEntries.Count -Maximum 128).value
      additionalDisappearedCount = (Get-SafeBoundedCount -Value $otherDisappearedEntries.Count -Maximum 128).value
      additionalUnobservableCount = (Get-SafeBoundedCount -Value $otherUnobservableEntries.Count -Maximum 128).value
    }

    $script:CurrentSubstep = 'observe-independent:exited-job-inventory-status'
    Assert-Equal -Actual ([string]$exitedObservation.inventory.status) -Expected 'available' -Message 'The remaining Job inventory was not available after root exit.'
    $script:CurrentSubstep = 'observe-independent:exited-job-inventory-nonempty'
    Assert-True -Condition (-not [bool]$exitedObservation.inventory.isEmpty) -Message 'The exited-root inventory was incorrectly reported empty.'
    $script:CurrentSubstep = 'observe-independent:exited-job-inventory-bounds'
    Assert-True -Condition ([int]$exitedObservation.inventory.memberCountBefore -ge 0 -and [int]$exitedObservation.inventory.memberCountBefore -le 64 -and
      [int]$exitedObservation.inventory.memberCountAfter -ge 0 -and [int]$exitedObservation.inventory.memberCountAfter -le 64 -and
      $exitedInventoryMembers.Count -le 128) -Message 'The exited-root inventory exceeded its bounded process projection.'
    $script:CurrentSubstep = 'observe-independent:exited-job-inventory-before-count'
    Assert-Equal -Actual ([int]$exitedObservation.inventory.memberCountBefore) -Expected 1 -Message 'The pre-observation Job member count after root exit differed from the expected single child.'
    $script:CurrentSubstep = 'observe-independent:exited-job-inventory-after-count'
    Assert-Equal -Actual ([int]$exitedObservation.inventory.memberCountAfter) -Expected 1 -Message 'The final Job member count after root exit differed from the expected single child.'
    $script:CurrentSubstep = 'observe-independent:exited-job-inventory-descendant'
    $remainingEntries = @($exitedInventoryMembers | Where-Object { $_.state -ceq 'observed' })
    if ($remainingEntries.Count -ne 1 -or [int]$remainingEntries[0].processId -ne $descendantProcessId) {
      throw 'The exited-root inventory did not preserve the live child and CIM parent without fabricating a root member.'
    }
    $script:CurrentSubstep = 'observe-independent:exited-job-inventory-parent-proof'
    if ([int]$remainingEntries[0].metadata.parentProcessId -ne $rootProcessId -or [int]$descendantCim.parentProcessId -ne $rootProcessId) {
      throw 'The remaining Job child did not retain the independently confirmed root parent.'
    }
    $script:CurrentSubstep = 'observe-independent:exited-job-inventory-root-excluded'
    if ($exitedRootEntries.Count -ne 0) {
      throw 'The exited root was fabricated as a current Job member.'
    }
    $script:CurrentSubstep = 'observe-independent:exited-job-inventory-outsider-excluded'
    if ($exitedOutsiderEntries.Count -ne 0) { throw 'The outsider appeared in the private capsule Job inventory.' }

    $script:CurrentSubstep = 'observe-independent:stale-assertion-is-nondestructive'
    $staleMismatch = [ordered]@{ parentProcessId = [int]$expectedAssertion.parentProcessId + 1 }
    if (-not (Test-ExpectedPolicyError `
        -Action { Observe-WindowsNativeProcess -Capsule $observeCapsule -IdentityAssertion $staleMismatch } `
        -ExpectedErrorId 'Morrow.WindowsNativeProcess.IdentityMismatch' `
        -ExpectedFields @('parentProcessId') `
        -ForbiddenText @([string]$staleMismatch.parentProcessId) `
        -ExpectedStage 'identity-assertion-comparison' `
        -ExpectedCommand 'Observe-WindowsNativeProcess')) {
      throw 'A divergent assertion against the exited-root snapshot was not sanitized.'
    }
    $descendantWaitProcess.Refresh()
    Assert-True -Condition (-not $descendantWaitProcess.HasExited) -Message 'A stale-snapshot assertion mismatch terminated the surviving Job descendant.'
    $script:Outsider.process.Refresh()
    Assert-True -Condition (-not $script:Outsider.process.HasExited) -Message 'Observe or its assertion checks terminated the outsider.'

    $script:CurrentSubstep = 'observe-independent:owned-job-dispose'
    $cleanupWatch = [Diagnostics.Stopwatch]::StartNew()
    $cleanup = $observeCapsule.Dispose()
    $cleanupWatch.Stop()
    $cleanupElapsedMs = $cleanupWatch.ElapsedMilliseconds
    Assert-True -Condition ([bool]$cleanup.jobEmpty -and [bool]$cleanup.rootExited) -Message 'Capsule disposal did not confirm an empty Job and exited root.'
    Assert-True -Condition ($cleanupElapsedMs -le 11000) -Message 'Capsule disposal exceeded its owned-Job cleanup bound.'
    $cleanupConfirmed = $true
    if (-not $descendantWaitProcess.WaitForExit(5000)) { throw 'Owned-Job disposal did not terminate its retained synthetic descendant handle.' }
    $script:Outsider.process.Refresh()
    Assert-True -Condition (-not $script:Outsider.process.HasExited) -Message 'Owned-Job disposal terminated the outsider.'
    $script:CleanupNotes.Add('Observe returned fresh and exited-snapshot identities, bounded member projections, and preserved an outsider; only capsule Dispose cleaned the owned Job')

    [void]$script:CaseOutcomes.Add([ordered]@{
      name = 'observe-live-root-exited-snapshot-and-job-inventory'
      status = 'passed'
      identityFreshWhileLive = $true
      identitySnapshotAfterExit = $true
      matchingSixFieldAssertion = $true
      individualDivergencesRejected = 6
      malformedAssertionsRejected = $malformedCases.Count
      assertionsWereNonDestructive = $true
      descendantRemainedAfterRootExit = $true
      inventoryProjectionLimited = $true
      outsiderExcludedAndPreserved = $true
      cleanupJobEmpty = [bool]$cleanup.jobEmpty
      cleanupRootExited = [bool]$cleanup.rootExited
      observeElapsedMs = $observeClock.ElapsedMilliseconds
      cleanupElapsedMs = $cleanupElapsedMs
      exitedInventoryDiagnostics = $script:SafeObserveInventoryEvidence
    })
    return [ordered]@{
      identityFreshWhileLive = $true
      identitySnapshotAfterExit = $true
      matchingSixFieldAssertion = $true
      individualDivergencesRejected = 6
      malformedAssertionsRejected = $malformedCases.Count
      assertionsWereNonDestructive = $true
      descendantRemainedAfterRootExit = $true
      inventoryProjectionLimited = $true
      outsiderExcludedAndPreserved = $true
      inventoryStatusWhileLive = [string]$liveObservation.inventory.status
      inventoryStatusAfterRootExit = [string]$exitedObservation.inventory.status
      exitedInventoryDiagnostics = $script:SafeObserveInventoryEvidence
      cleanupElapsedMs = $cleanupElapsedMs
    }
  } finally {
    if ($null -ne $observeCapsule -and -not $cleanupConfirmed) {
      try {
        $fallbackCleanup = $observeCapsule.Dispose()
        $cleanupConfirmed = [bool]$fallbackCleanup.jobEmpty -and [bool]$fallbackCleanup.rootExited
      } catch { $cleanupConfirmed = $false }
      if (-not $cleanupConfirmed) {
        [void]$script:CleanupNotes.Add('Observe fixture cleanup was not confirmed; its RUNNER_TEMP evidence was retained for inspection')
        [void]$script:Failures.Add('observe-owned-job-cleanup-unconfirmed')
      }
    }
    if ($null -ne $rootWaitProcess) { try { $rootWaitProcess.Dispose() } catch { } }
    if ($null -ne $descendantWaitProcess) { try { $descendantWaitProcess.Dispose() } catch { } }
  }
}

function Test-DirectSuspendedIdentityProof {
  $script:CurrentSubstep = 'direct-suspended:prepare'
  $caseRoot = New-CaseRoot -Name 'direct-suspended-identity'
  $fixtureArgs = Get-NewFixtureArguments -CaseRoot $caseRoot -Role 'direct-suspended'
  $expectedSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $descriptor = New-ValidDescriptor -CaseRoot $caseRoot -ArgumentList $fixtureArgs.arguments -ExpectedParentProcessId ([int]$PID) -ExpectedOwnerSid $expectedSid
  $nativeEnvironment = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($name in $descriptor.environment.Keys) {
    $nativeEnvironment.Add([string]$name, [string]$descriptor.environment[$name])
  }

  $session = $null
  $proofError = $null
  $cleanupError = $false
  $cleanupResult = $null
  $cleanupElapsedMs = $null
  $proofWatch = [Diagnostics.Stopwatch]::StartNew()
  $cimPathDisposition = 'absent-or-empty'
  $hashMismatchRejected = $false
  try {
    $script:CurrentSubstep = 'direct-suspended:create'
    $session = CreateAtomicSuspendedRoot `
      -ExecutablePath ([string]$descriptor.executablePath) `
      -ArgumentList ([string[]]$descriptor.argumentList) `
      -Environment $nativeEnvironment `
      -WorkingDirectory ([string]$descriptor.workingDirectory)

    $script:CurrentSubstep = 'direct-suspended:native-observation'
    $nativeObservation = $session.ObserveRoot()
    Assert-True -Condition ($null -ne $nativeObservation) -Message 'The suspended root handle returned no observation.'
    Assert-Equal -Actual ([string]$nativeObservation.state) -Expected 'suspended' -Message 'The synthetic root was not still suspended.'
    Assert-True -Condition ([bool]$nativeObservation.isMember -and [bool]$nativeObservation.wasAssociatedAtCreation) -Message 'The retained root was not confirmed in its private Job from atomic creation.'
    Assert-Equal -Actual ([uint32]$nativeObservation.jobLimitFlags) -Expected ([uint32]8192) -Message 'The retained root Job lacked the required kill-on-close policy.'
    Assert-True -Condition (-not [bool]$nativeObservation.jobHandleInheritable) -Message 'The retained root Job handle was inheritable.'
    $memberIds = @($session.ListMemberIds())
    Assert-True -Condition ($memberIds.Count -eq 1 -and [uint32]$memberIds[0] -eq [uint32]$nativeObservation.processId) -Message 'The private Job did not contain exactly the one suspended synthetic root.'

    $knownImagePath = Get-CanonicalFullPath -Path ([string]$descriptor.executablePath)
    $retainedImagePath = Get-CanonicalFullPath -Path ([string]$nativeObservation.executablePath)
    Assert-Equal -Actual $retainedImagePath -Expected $knownImagePath -IgnoreCase -Message 'The retained native image did not match the known staged PowerShell executable.'

    $script:CurrentSubstep = 'direct-suspended:fresh-known-file-digest'
    $freshKnownFileHash = Get-Sha256 -Path $knownImagePath
    Assert-Equal -Actual $freshKnownFileHash -Expected ([string]$descriptor.executableSha256).ToLowerInvariant() -Message 'The fresh post-create digest of the known staged executable differed from the descriptor digest.'
    Assert-Equal -Actual $freshKnownFileHash -Expected $script:StagedPwshSha256 -Message 'The fresh post-create digest differed from the independently staged executable digest.'

    $script:CurrentSubstep = 'direct-suspended:cim-identity'
    $processRows = @(
      Get-CimInstance -ClassName Win32_Process `
        -Filter ('ProcessId = ' + [string][uint32]$nativeObservation.processId) `
        -OperationTimeoutSec 5 `
        -ErrorAction Stop
    )
    Assert-True -Condition ($processRows.Count -eq 1 -and $null -ne $processRows[0]) -Message 'CIM did not return exactly one row for the retained suspended root.'
    $processRow = $processRows[0]
    $cimPidProperty = $processRow.PSObject.Properties['ProcessId']
    if ($null -eq $cimPidProperty -or $null -eq $cimPidProperty.Value) { throw 'The suspended-root CIM row lacked its PID.' }
    Assert-Equal -Actual ([uint32]$cimPidProperty.Value) -Expected ([uint32]$nativeObservation.processId) -Message 'CIM PID differed from the retained native root PID.'

    $parentProperty = $processRow.PSObject.Properties['ParentProcessId']
    if ($null -eq $parentProperty -or $null -eq $parentProperty.Value) { throw 'The suspended-root CIM row lacked its parent PID.' }
    Assert-Equal -Actual ([uint32]$parentProperty.Value) -Expected ([uint32]$PID) -Message 'CIM parent PID differed from the test process that created the synthetic root.'

    $creationProperty = $processRow.PSObject.Properties['CreationDate']
    if ($null -eq $creationProperty -or $null -eq $creationProperty.Value) { throw 'The suspended-root CIM row lacked its creation time.' }
    if ($creationProperty.Value -is [datetime]) {
      $cimCreationUtc = $creationProperty.Value.ToUniversalTime()
    } elseif ($creationProperty.Value -is [string] -and -not [string]::IsNullOrEmpty([string]$creationProperty.Value)) {
      $cimCreationUtc = [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$creationProperty.Value).ToUniversalTime()
    } else {
      throw 'The suspended-root CIM creation time had an unsupported shape.'
    }
    $nativeCreationUtc = [DateTime]::Parse(
      [string]$nativeObservation.creationTimeUtc,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind
    ).ToUniversalTime()
    $creationDeltaTicks = [Math]::Abs(($nativeCreationUtc - $cimCreationUtc).Ticks)
    Assert-True -Condition ($creationDeltaTicks -le 20) -Message 'CIM creation time differed from the retained native handle by more than 20 ticks.'

    $script:CurrentSubstep = 'direct-suspended:cim-owner'
    $ownerResult = Invoke-CimMethod -InputObject $processRow -MethodName GetOwnerSid -OperationTimeoutSec 5 -ErrorAction Stop
    $returnValueProperty = $ownerResult.PSObject.Properties['ReturnValue']
    $sidProperty = $ownerResult.PSObject.Properties['Sid']
    $integralTypes = @([byte], [sbyte], [short], [ushort], [int], [uint32], [long], [ulong])
    if ($null -eq $returnValueProperty -or $null -eq $returnValueProperty.Value -or
        $returnValueProperty.Value.GetType() -notin $integralTypes -or [decimal]$returnValueProperty.Value -ne 0 -or
        $null -eq $sidProperty -or $sidProperty.Value -isnot [string]) {
      throw 'CIM GetOwnerSid did not return a successful typed SID result.'
    }
    $cimOwnerSid = [Security.Principal.SecurityIdentifier]::new([string]$sidProperty.Value).Value
    Assert-Equal -Actual $cimOwnerSid -Expected $expectedSid -Message 'CIM owner SID differed from the test process owner SID.'

    $pathProperty = $processRow.PSObject.Properties['ExecutablePath']
    if ($null -ne $pathProperty -and $null -ne $pathProperty.Value) {
      if ($pathProperty.Value -isnot [string]) { throw 'A present CIM executable path was not a string.' }
      $cimPath = [string]$pathProperty.Value
      if (-not [string]::IsNullOrEmpty($cimPath)) {
        if ([string]::IsNullOrWhiteSpace($cimPath)) { throw 'A present CIM executable path was whitespace.' }
        $canonicalCimPath = Get-CanonicalFullPath -Path $cimPath
        Assert-Equal -Actual $canonicalCimPath -Expected $knownImagePath -IgnoreCase -Message 'The optional CIM executable path differed from the known staged executable.'
        Assert-Equal -Actual $canonicalCimPath -Expected $retainedImagePath -IgnoreCase -Message 'The optional CIM executable path differed from the retained native image.'
        $cimPathDisposition = 'corroborated'
      }
    }

    $script:CurrentSubstep = 'direct-suspended:production-identity-helper'
    $productionIdentity = Get-PilotWindowsNativeProcessObservedIdentity `
      -NativeObservation $nativeObservation `
      -Descriptor $descriptor `
      -ExpectedExecutablePath $knownImagePath `
      -ExpectedHash $freshKnownFileHash
    $actualIdentityFields = @($productionIdentity.PSObject.Properties.Name | Sort-Object)
    $expectedIdentityFields = @('creationTimeUtc', 'executablePath', 'executableSha256', 'ownerSid', 'parentProcessId', 'processId')
    Assert-Equal -Actual ([string]::Join('|', $actualIdentityFields)) -Expected ([string]::Join('|', $expectedIdentityFields)) -Message 'The production suspended identity result did not contain exactly the six contract fields.'
    Assert-Equal -Actual ([uint32]$productionIdentity.processId) -Expected ([uint32]$nativeObservation.processId) -Message 'The production identity PID differed from the retained handle.'
    Assert-Equal -Actual ([uint32]$productionIdentity.parentProcessId) -Expected ([uint32]$PID) -Message 'The production identity parent differed from the independent CIM parent.'
    Assert-Equal -Actual ([string]$productionIdentity.ownerSid) -Expected $expectedSid -Message 'The production identity SID differed from the independent CIM owner.'
    Assert-Equal -Actual ([string]$productionIdentity.executablePath) -Expected $retainedImagePath -IgnoreCase -Message 'The production identity image path differed from the retained handle.'
    Assert-Equal -Actual ([string]$productionIdentity.executableSha256).ToLowerInvariant() -Expected $freshKnownFileHash -Message 'The production identity digest differed from the independently measured post-create digest.'
    $productionCreationUtc = [DateTime]::Parse([string]$productionIdentity.creationTimeUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
    Assert-True -Condition ([Math]::Abs(($productionCreationUtc - $cimCreationUtc).Ticks) -le 20) -Message 'The production identity creation time differed from the independent CIM time.'

    $script:CurrentSubstep = 'direct-suspended:production-post-create-hash-mismatch'
    $wrongExpectedHash = if ($freshKnownFileHash.StartsWith('0', [StringComparison]::Ordinal)) { '1' + $freshKnownFileHash.Substring(1) } else { '0' + $freshKnownFileHash.Substring(1) }
    $hashMismatchError = $null
    try {
      $null = Get-PilotWindowsNativeProcessImageProof `
        -NativeObservation $nativeObservation `
        -ExpectedExecutablePath $knownImagePath `
        -ExpectedHash $wrongExpectedHash
    } catch {
      $hashMismatchError = $_
    }
    if ($null -eq $hashMismatchError) { throw 'The production image proof accepted a valid retained image with a known wrong expected digest.' }
    $hashMismatchErrorId = $null
    $hashMismatchException = $hashMismatchError.Exception
    for ($depth = 0; $null -ne $hashMismatchException -and $depth -lt 8; $depth++) {
      if ($hashMismatchException.Data.Contains('Morrow.WindowsNativeProcess.ErrorId')) {
        $hashMismatchErrorId = [string]$hashMismatchException.Data['Morrow.WindowsNativeProcess.ErrorId']
        break
      }
      $hashMismatchException = $hashMismatchException.InnerException
    }
    $hashMismatchDiagnostics = Get-PolicyDiagnostics -ErrorRecord $hashMismatchError
    $hashMismatchFields = @(Get-DiagnosticValue -Object $hashMismatchDiagnostics -Name 'fields')
    Assert-Equal -Actual $hashMismatchErrorId -Expected 'Morrow.WindowsNativeProcess.StartFailed' -Message 'The production image proof returned an unexpected error for a digest mismatch.'
    Assert-Equal -Actual ([string](Get-DiagnosticValue -Object $hashMismatchDiagnostics -Name 'stage')) -Expected 'identity-comparison' -Message 'The production image proof reported the wrong digest-mismatch stage.'
    Assert-True -Condition ($hashMismatchFields -ccontains 'executableSha256') -Message 'The production image proof omitted the digest field from its sanitized mismatch.'
    $hashMismatchRejected = $true

    $script:CurrentSubstep = 'direct-suspended:no-resume-or-marker'
    $afterProofObservation = $session.ObserveRoot()
    Assert-Equal -Actual ([string]$afterProofObservation.state) -Expected 'suspended' -Message 'The retained synthetic process left suspended state during identity proof.'
    Assert-True -Condition (-not [IO.File]::Exists($fixtureArgs.markerPath) -and -not [IO.File]::Exists($fixtureArgs.receiptPath)) -Message 'The synthetic fixture ran before authorization or wrote a marker/receipt.'
    Assert-OutsiderStillAlive
    $proofWatch.Stop()
    Assert-True -Condition ($proofWatch.ElapsedMilliseconds -le 25000) -Message 'The direct suspended identity proof exceeded its bounded observation window.'
  } catch {
    $proofError = $_
  } finally {
    if ($null -ne $session) {
      $cleanupWatch = [Diagnostics.Stopwatch]::StartNew()
      try {
        $script:CurrentSubstep = 'direct-suspended:job-cleanup'
        $cleanupResult = $session.StopAndWait(10000)
      } catch {
        $cleanupError = $true
      }
      try {
        $session.Dispose()
      } catch {
        $cleanupError = $true
      }
      $cleanupWatch.Stop()
      $cleanupElapsedMs = $cleanupWatch.ElapsedMilliseconds
    }
  }

  if ($null -ne $proofError) {
    if ($cleanupError -or $null -eq $cleanupResult -or -not [bool]$cleanupResult.jobEmpty -or -not [bool]$cleanupResult.rootExited) {
      $script:CleanupNotes.Add('direct synthetic suspended proof failed and private Job cleanup could not be fully verified')
    }
    throw $proofError
  }
  Assert-True -Condition (-not $cleanupError -and $null -ne $cleanupResult) -Message 'The direct synthetic root Job cleanup did not return a confirmed result.'
  Assert-True -Condition ([bool]$cleanupResult.jobEmpty -and [bool]$cleanupResult.rootExited -and -not [bool]$cleanupResult.timedOut) -Message 'The direct synthetic root cleanup did not confirm Job empty and root exited.'
  Assert-True -Condition ($cleanupElapsedMs -le 11000) -Message 'The direct synthetic root cleanup exceeded its bound.'
  Assert-True -Condition (-not [IO.File]::Exists($fixtureArgs.markerPath) -and -not [IO.File]::Exists($fixtureArgs.receiptPath)) -Message 'The synthetic fixture wrote a marker or receipt before cleanup.'
  Assert-OutsiderStillAlive
  $script:CleanupNotes.Add('direct suspended synthetic root proved retained image, fresh known-file digest and CIM identity; private Job cleanup verified without Resume')
  $outcome = [ordered]@{
    name = 'direct-suspended-retained-image-fresh-digest-and-cim-proof'
    status = 'passed'
    retainedNativeImageMatchesKnownFile = $true
    freshKnownFileDigestMatchesDescriptor = $true
    cimPidParentCreationAndOwnerMatch = $true
    cimPathDisposition = $cimPathDisposition
    productionIdentityContainsSixFields = $true
    productionPostCreateWrongDigestRejected = $hashMismatchRejected
    resumeNotRequested = $true
    fixtureMarkerAndReceiptAbsent = $true
    jobEmpty = [bool]$cleanupResult.jobEmpty
    rootExited = [bool]$cleanupResult.rootExited
    cleanupElapsedMs = $cleanupElapsedMs
    outsiderAlive = $true
  }
  [void]$script:CaseOutcomes.Add($outcome)
  return $outcome
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
    $script:CurrentSubstep = 'invalid-descriptor:' + [string]$testCase.name
    $diagnostics = Invoke-ExpectedPolicyFailure -Descriptor $testCase.descriptor -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -ExpectedField $testCase.expectedField
    if ([IO.File]::Exists($fixtureArgs.markerPath) -or [IO.File]::Exists($fixtureArgs.receiptPath)) { throw 'A rejected descriptor executed the synthetic fixture.' }
    Assert-NoLiveOwnedFixtureProcess -OwnershipMarker $fixtureArgs.marker
    $script:CaseOutcomes.Add([ordered]@{ name = [string]$testCase.name; status = 'passed'; stage = [string]$diagnostics.stage })
  }

  $junctionPaths = [Collections.Generic.List[string]]::new()
  try {
    $script:CurrentSubstep = 'invalid-reparse:executable'
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

    $script:CurrentSubstep = 'invalid-reparse:working-directory'
    $workingTarget = Join-Path $CaseRoot 'working-target'
    [void][IO.Directory]::CreateDirectory($workingTarget)
    $workingJunction = Join-Path $CaseRoot 'working-junction'
    New-Item -Path $workingJunction -ItemType Junction -Target $workingTarget -ErrorAction Stop | Out-Null
    [void]$junctionPaths.Add($workingJunction)
    $workingDescriptor = Copy-DescriptorWithMutation -Descriptor $valid -Mutation { param($d) $d['workingDirectory'] = $workingJunction }
    $workingDiagnostics = Invoke-ExpectedPolicyFailure -Descriptor $workingDescriptor -ExpectedErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor'
    $script:CaseOutcomes.Add([ordered]@{ name = 'working-directory-reparse-junction-refused'; status = 'passed'; stage = [string]$workingDiagnostics.stage })

    $script:CurrentSubstep = 'invalid-reparse:profile'
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

    $script:CurrentSubstep = 'invalid-reparse:environment-temp'
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
  $script:CurrentSubstep = 'post-create:' + $MismatchKind
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
    $hasExited = $false
    $stateKnown = $false
    try {
      $hasExited = [bool]$Record.process.HasExited
      $stateKnown = $true
    } catch {
      $script:Failures.Add('tracked-process-state-observation-failed')
      $script:CleanupNotes.Add('owned test process state was uncertain; termination through its retained Process handle was still attempted')
    }

    if (-not $stateKnown -or -not $hasExited) {
      try {
        if ($null -eq $Record.safeProcessHandle) { throw 'The test process SafeProcessHandle was not captured.' }
        $image = Get-TestProcessImagePath -SafeProcessHandle $Record.safeProcessHandle
        if (-not [string]::Equals($image, [string]$Record.expectedImagePath, [StringComparison]::OrdinalIgnoreCase)) {
          $script:Failures.Add('tracked-process-image-identity-mismatch')
          $script:CleanupNotes.Add('owned test process image differed from its recorded start image; termination through its original Process handle was still attempted')
        }
      } catch {
        $Record.imageObservationFailed = $true
        $script:Failures.Add('tracked-process-image-observation-failed')
        $script:CleanupNotes.Add('owned test process image could not be verified; termination through its original Process handle was still attempted')
      }

      try {
        $Record.process.Kill()
        if (-not $Record.process.WaitForExit(5000)) { throw 'The owned test process did not exit within five seconds.' }
        $Record.emergencyCleanup = $true
      } catch {
        $exitedAfterAttempt = $false
        try { $exitedAfterAttempt = [bool]$Record.process.HasExited } catch { }
        if (-not $exitedAfterAttempt) { throw 'Termination through the owned Process handle did not complete.' }
      }
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
      $canaryPath = 'Env:\' + $script:EnvironmentCanaryName
      if ($script:OriginalCanaryExisted) {
        Set-Item -LiteralPath $canaryPath -Value ([string]$script:OriginalCanaryValue) -ErrorAction Stop
      } else {
        $currentItem = Get-Item -LiteralPath $canaryPath -ErrorAction SilentlyContinue
        if ($null -ne $currentItem) { Remove-Item -LiteralPath $canaryPath -ErrorAction Stop }
      }
      $restoredItem = Get-Item -LiteralPath $canaryPath -ErrorAction SilentlyContinue
      if ($script:OriginalCanaryExisted) {
        if ($null -eq $restoredItem -or [string]$restoredItem.Value -cne [string]$script:OriginalCanaryValue) {
          throw 'The parent-only environment canary value did not restore exactly.'
        }
      } elseif ($null -ne $restoredItem) {
        throw 'The parent-only environment canary was not removed after restoration.'
      }
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
  $markerPath = Join-Path $script:RuntimeRoot '.issue-236-independent-owner'
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
    [Console]::Out.WriteLine('{"schemaVersion":1,"issue":236,"status":"failed","evidenceAvailable":false}')
    return
  }
  $receipt = [ordered]@{
    schemaVersion = 1
    issue = $script:Issue
    coverageIssues = @(225, 235, 236)
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
        image = [IO.Path]::GetFileName([string]$_.imagePath)
        exitCode = $_.exitCode
        emergencyCleanup = $_.emergencyCleanup
        safeProcessHandleCaptured = ($null -ne $_.safeProcessHandle)
        imageObservationFailed = [bool]$_.imageObservationFailed
      }
    })
    cleanup = [ordered]@{
      notes = @($script:CleanupNotes)
      outstandingProcessCount = @($script:TrackedProcesses | Where-Object { -not [bool]$_.hasExited }).Count
      outstandingProcessHandleCount = @($script:TrackedProcesses | Where-Object { -not [bool]$_.hasExited }).Count
      outstandingProcessIdUnknownCount = @($script:TrackedProcesses | Where-Object { -not [bool]$_.hasExited -and $null -eq $_.processId }).Count
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
    [Console]::Out.WriteLine('{"schemaVersion":1,"issue":236,"status":"failed","receiptWriteFailed":true}')
    $script:Failures.Add('receipt-write-failed')
  }
}

$runFailed = $false
try {
  $script:CurrentSubstep = 'setup:windows-platform'
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This independent native process policy probe must run on a real Windows runner.'
  }
  $script:CurrentSubstep = 'setup:runner-temp'
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
  [IO.File]::WriteAllText((Join-Path $script:EvidenceRootFull '.issue-236-independent-owner'), [Guid]::NewGuid().ToString('N'), $script:Utf8NoBom)

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

  $script:CurrentSubstep = 'setup:runtime-stage'
  New-StagedRuntime
  $script:CurrentSubstep = 'setup:write-fixture'
  $fixtureDirectory = Join-Path $script:EvidenceRootFull 'fixtures'
  [void][IO.Directory]::CreateDirectory($fixtureDirectory)
  $script:FixturePath = Join-Path $fixtureDirectory 'windows-native-process-policy.fixture.ps1'
  Write-FixtureScript -Path $script:FixturePath
  $script:FixtureSha256 = Get-Sha256 -Path $script:FixturePath
  $script:CurrentSubstep = 'setup:process-image-query'
  Initialize-TestProcessImageQuery
  $script:CurrentSubstep = 'dot-source:process-probe'
  $probePlan = Start-DotSourcePurityProbe
  $script:Checks['dot-source-has-no-side-effects'] = [ordered]@{
    status = 'passed'
    detail = $probePlan.receipt
    probeSha256 = $probePlan.probeSha256
  }
  [Console]::Out.WriteLine('PASS dot-source-has-no-side-effects')

  $script:CurrentSubstep = 'setup:dot-source-policy'
  . $script:ProcessAdapterPath
  . $script:JobAdapterPath
  . $script:PolicyFullPath
  Add-Check -Name 'identity-assertion-six-field-validation' -Action { Test-IndependentIdentityAssertionHelpers }
  Add-Check -Name 'inventory-projection-transition-and-availability-contract' -Action { Test-IndependentInventoryProjection }
  $script:CurrentSubstep = 'outsider:setup'
  $outsiderDetails = New-Outsider
  $script:Checks['outsider-setup'] = [ordered]@{ status = 'passed'; detail = $outsiderDetails }
  [Console]::Out.WriteLine('PASS outsider-setup')

  Add-Check -Name 'positive-start-identity-environment-and-capsule-dispose' -Action { Test-PositiveStartAndDispose }
  Add-Check -Name 'observe-fresh-snapshot-assertions-and-owned-job-inventory' -Action { Test-IndependentObserveAndRootExitInventory }
  Add-Check -Name 'direct-suspended-retained-image-fresh-digest-and-cim-proof' -Action { Test-DirectSuspendedIdentityProof }
  Add-Check -Name 'closed-descriptor-and-precreate-refusals' -Action { New-InvalidDescriptorCases -CaseRoot (New-CaseRoot -Name 'invalid-descriptors') }
  Add-Check -Name 'post-create-owner-sid-mismatch-cleans-only-owned-job' -Action { Test-PostCreateMismatch -MismatchName 'mismatch-owner-sid' -MismatchKind ownerSid }
  Add-Check -Name 'post-create-parent-process-mismatch-cleans-only-owned-job' -Action { Test-PostCreateMismatch -MismatchName 'mismatch-parent-process' -MismatchKind parentProcessId }
} catch {
  $runFailed = $true
  $failure = New-SafeFailureSummary -ErrorRecord $_ -CheckName 'setup' -Substep $script:CurrentSubstep
  $script:Checks['setup'] = [ordered]@{ status = 'failed'; diagnostic = $failure }
  [void]$script:CaseOutcomes.Add($failure)
  $script:Failures.Add('setup-failed')
  [Console]::Error.WriteLine(('FAIL setup id={0} stage={1} substep={2}' -f $failure.errorId, $failure.stage, $failure.substep))
} finally {
  try { Close-AllOwnedCapsules } catch { $script:Failures.Add('capsule-finalization-unhandled') }
  try { Restore-TestEnvironment } catch { $script:Failures.Add('environment-finalization-unhandled') }
  try { Close-AllTrackedProcesses } catch { $script:Failures.Add('tracked-process-finalization-unhandled') }
  try { Remove-OwnedRuntimeStage } catch { $script:Failures.Add('runtime-finalization-unhandled') }
  try { Write-FinalReceipt } catch {
    $script:Failures.Add('final-receipt-finalization-unhandled')
    [Console]::Error.WriteLine('FAIL receipt: finalization failed before the sanitized receipt could be completed.')
    [Console]::Out.WriteLine('{"schemaVersion":1,"issue":236,"status":"failed","receiptWriteFailed":true}')
  }
}

if ($runFailed -or (Get-ReceiptStatus) -ne 'passed') { exit 1 }
exit 0
