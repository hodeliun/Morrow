[CmdletBinding(PositionalBinding = $false)]
param(
  [string] $Protocol,
  [string] $FrameTimeoutMilliseconds = '120000'
)

. (Join-Path $PSScriptRoot 'windows-native-process.ps1')
. (Join-Path $PSScriptRoot 'windows-process.ps1')
. (Join-Path $PSScriptRoot 'windows-native-job.ps1')

function New-PilotWindowsNativeProcessControllerException {
  param(
    [Parameter(Mandatory)][string] $ErrorId,
    [Parameter(Mandatory)][string] $Stage,
    [string[]] $Fields = @()
  )

  $exception = [InvalidOperationException]::new('The process controller operation failed.')
  $exception.Data['Morrow.WindowsNativeProcess.Jsonl.ErrorId'] = $ErrorId
  $exception.Data['Morrow.WindowsNativeProcess.Jsonl.Diagnostics'] = [ordered]@{
    stage = $Stage
    fields = @($Fields)
  }
  return $exception
}

function Get-PilotWindowsNativeProcessControllerExceptionValue {
  param(
    [Parameter(Mandatory)][Exception] $Exception,
    [Parameter(Mandatory)][string[]] $Keys
  )

  $current = $Exception
  for ($depth = 0; $null -ne $current -and $depth -lt 8; $depth++) {
    foreach ($key in $Keys) {
      try {
        if ($current.Data.Contains($key)) { return $current.Data[$key] }
      } catch { }
    }
    $current = $current.InnerException
  }
  return $null
}

function Get-PilotWindowsNativeProcessControllerErrorInfo {
  param(
    [Parameter(Mandatory)][Exception] $Exception,
    [string] $FallbackStage = 'controller'
  )

  $errorId = [string](Get-PilotWindowsNativeProcessControllerExceptionValue -Exception $Exception -Keys @(
    'Morrow.WindowsNativeProcess.Jsonl.ErrorId',
    'Morrow.WindowsNativeProcess.ErrorId'
  ))
  $diagnostics = Get-PilotWindowsNativeProcessControllerExceptionValue -Exception $Exception -Keys @(
    'Morrow.WindowsNativeProcess.Jsonl.Diagnostics',
    'Morrow.WindowsNativeProcess.Diagnostics'
  )

  $publicCodes = @{
    'Morrow.WindowsNativeProcess.Jsonl.MalformedJson' = 'MalformedJson'
    'Morrow.WindowsNativeProcess.Jsonl.InvalidRequest' = 'InvalidRequest'
    'Morrow.WindowsNativeProcess.Jsonl.InvalidDescriptor' = 'InvalidDescriptor'
    'Morrow.WindowsNativeProcess.Jsonl.InvalidIdentityAssertion' = 'InvalidIdentityAssertion'
    'Morrow.WindowsNativeProcess.Jsonl.InvalidTimeout' = 'InvalidTimeout'
    'Morrow.WindowsNativeProcess.Jsonl.FrameTooLarge' = 'FrameTooLarge'
    'Morrow.WindowsNativeProcess.Jsonl.DepthExceeded' = 'DepthExceeded'
    'Morrow.WindowsNativeProcess.Jsonl.DuplicateProperty' = 'DuplicateProperty'
    'Morrow.WindowsNativeProcess.Jsonl.InvalidLineEnding' = 'InvalidLineEnding'
    'Morrow.WindowsNativeProcess.Jsonl.DeadlineExceeded' = 'DeadlineExceeded'
    'Morrow.WindowsNativeProcess.Jsonl.ReadFailed' = 'ReadFailed'
    'Morrow.WindowsNativeProcess.Jsonl.UnexpectedPartialEof' = 'UnexpectedPartialEof'
    'Morrow.WindowsNativeProcess.Jsonl.BomNotAllowed' = 'BomNotAllowed'
    'Morrow.WindowsNativeProcess.Jsonl.InvalidEncoding' = 'InvalidEncoding'
    'Morrow.WindowsNativeProcess.Jsonl.DuplicateRequestId' = 'DuplicateRequestId'
    'Morrow.WindowsNativeProcess.Jsonl.RequestIdCapacityExceeded' = 'RequestIdCapacityExceeded'
    'Morrow.WindowsNativeProcess.Jsonl.ReaderTerminated' = 'ReaderTerminated'
    'Morrow.WindowsNativeProcess.Jsonl.InvalidReaderContext' = 'InvalidReaderContext'
    'Morrow.WindowsNativeProcess.Jsonl.WrongCapsule' = 'UnknownCapsule'
    'Morrow.WindowsNativeProcess.Jsonl.CapsuleAlreadyActive' = 'CapsuleAlreadyActive'
    'Morrow.WindowsNativeProcess.Jsonl.ResponseTooLarge' = 'ResponseTooLarge'
    'Morrow.WindowsNativeProcess.Jsonl.InvalidInvocation' = 'InvalidInvocation'
    'Morrow.WindowsNativeProcess.Jsonl.InvalidFrameTimeout' = 'InvalidFrameTimeout'
    'Morrow.WindowsNativeProcess.Jsonl.StopTimedOut' = 'StopTimedOut'
    'Morrow.WindowsNativeProcess.Jsonl.CleanupIncomplete' = 'CleanupIncomplete'
    'Morrow.WindowsNativeProcess.Jsonl.InternalError' = 'InternalError'
    'Morrow.WindowsNativeProcess.InvalidDescriptor' = 'InvalidDescriptor'
    'Morrow.WindowsNativeProcess.InvalidCapsule' = 'InvalidCapsule'
    'Morrow.WindowsNativeProcess.InvalidIdentityAssertion' = 'InvalidIdentityAssertion'
    'Morrow.WindowsNativeProcess.IdentityMismatch' = 'IdentityMismatch'
    'Morrow.WindowsNativeProcess.IdentityUnavailable' = 'IdentityUnavailable'
    'Morrow.WindowsNativeProcess.InvalidStopTimeout' = 'InvalidTimeout'
    'Morrow.WindowsNativeProcess.CapsuleBusy' = 'CapsuleBusy'
    'Morrow.WindowsNativeProcess.StartFailed' = 'StartFailed'
    'Morrow.WindowsNativeProcess.CleanupIncomplete' = 'CleanupIncomplete'
  }
  if (-not $publicCodes.ContainsKey($errorId) -and $diagnostics -is [System.Collections.IDictionary]) {
    if ($diagnostics.Contains('originalErrorId') -and $diagnostics['originalErrorId'] -is [string]) {
      $errorId = 'Morrow.WindowsNativeProcess.CleanupIncomplete'
    } elseif ($diagnostics.Contains('cause') -and $diagnostics['cause'] -is [string] -and
        $publicCodes.ContainsKey([string]$diagnostics['cause'])) {
      $errorId = [string]$diagnostics['cause']
    }
  }
  $safeCode = if ($publicCodes.ContainsKey($errorId)) { [string]$publicCodes[$errorId] } else { 'InternalError' }

  $allowedStages = @(
    'frame-size', 'line-ending', 'frame-deadline', 'frame-read', 'frame-eof', 'json-depth',
    'json-duplicate-property', 'json-parse', 'root-shape', 'version-validation',
    'request-id-validation', 'operation-validation', 'operation-shape', 'descriptor-validation',
    'identity-assertion-validation', 'capsule-id-validation', 'timeout-validation',
    'request-id-replay', 'request-id-capacity', 'utf8-bom', 'utf8-decode', 'reader-state',
    'reader-concurrency', 'request-reader', 'reader-initialization',
    'descriptor-validation', 'path-validation', 'path-containment', 'platform-preflight',
    'dependency-preflight', 'system-path-resolution', 'environment-validation',
    'environment-path-validation', 'environment-path-containment', 'executable-hash-validation',
    'identity-dependency', 'suspended-create', 'native-observation', 'cim-observation',
    'job-membership', 'identity-comparison', 'identity-assertion-validation',
    'identity-assertion-comparison', 'capsule-create', 'resume', 'cleanup',
    'observe-capsule-validation', 'observe-identity', 'observe-native-read',
    'stop-timeout-validation', 'stop-capsule-validation', 'stop-lock-acquisition',
    'stop-identity-revalidation', 'stop-cleanup',
    'entrypoint', 'reader', 'capsule-lookup', 'capsule-state', 'start', 'start-observation',
    'start-identity', 'start-cleanup', 'observe', 'stop', 'stop-result', 'shutdown',
    'response-serialization', 'response-write', 'controller'
  )
  $stageValue = $FallbackStage
  if ($diagnostics -is [System.Collections.IDictionary] -and $diagnostics.Contains('stage')) {
    $candidateStage = [string]$diagnostics['stage']
    if ($candidateStage -cin $allowedStages) { $stageValue = $candidateStage }
  }

  $allowedFields = @(
    'executablePath', 'executableSha256', 'argumentList', 'workingDirectory', 'profilePath',
    'environment', 'expectedParentProcessId', 'expectedOwnerSid', 'SYSTEMROOT', 'WINDIR', 'PATH',
    'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'processId',
    'parentProcessId', 'creationTimeUtc', 'ownerSid', 'state', 'membership', 'jobPolicy',
    'resumeResult', 'RUNNER_TEMP'
  )
  $safeFields = [Collections.Generic.List[string]]::new()
  if ($diagnostics -is [System.Collections.IDictionary] -and $diagnostics.Contains('fields')) {
    foreach ($field in @($diagnostics['fields'])) {
      if ($field -is [string] -and $field -cin $allowedFields -and -not $safeFields.Contains([string]$field)) {
        [void]$safeFields.Add([string]$field)
      }
    }
  }
  return [pscustomobject][ordered]@{
    code = $safeCode
    stage = $stageValue
    fields = [string[]]$safeFields.ToArray()
  }
}

function New-PilotWindowsNativeProcessControllerCleanup {
  param(
    [Parameter(Mandatory)][ValidateSet('not-required', 'confirmed', 'unconfirmed')][string] $State,
    [AllowNull()][Nullable[bool]] $JobEmpty,
    [AllowNull()][Nullable[bool]] $RootExited,
    [AllowNull()][Nullable[bool]] $DisposeFailed
  )

  return [ordered]@{
    state = $State
    jobEmpty = if ($null -eq $JobEmpty) { $null } else { [bool]$JobEmpty }
    rootExited = if ($null -eq $RootExited) { $null } else { [bool]$RootExited }
    disposeFailed = if ($null -eq $DisposeFailed) { $null } else { [bool]$DisposeFailed }
  }
}

function New-PilotWindowsNativeProcessControllerNotRequiredCleanup {
  return (New-PilotWindowsNativeProcessControllerCleanup -State 'not-required' -JobEmpty $null -RootExited $null -DisposeFailed $null)
}

function New-PilotWindowsNativeProcessControllerConfirmedCleanup {
  return (New-PilotWindowsNativeProcessControllerCleanup -State 'confirmed' -JobEmpty $true -RootExited $true -DisposeFailed $false)
}

function Get-PilotWindowsNativeProcessControllerStartFailureCleanup {
  param([Parameter(Mandatory)][Exception] $Exception)

  $diagnostics = Get-PilotWindowsNativeProcessControllerExceptionValue -Exception $Exception -Keys @(
    'Morrow.WindowsNativeProcess.Diagnostics'
  )
  $errorId = [string](Get-PilotWindowsNativeProcessControllerExceptionValue -Exception $Exception -Keys @(
    'Morrow.WindowsNativeProcess.ErrorId'
  ))
  if ($diagnostics -isnot [System.Collections.IDictionary] -or -not $diagnostics.Contains('cleanup') -or
      $diagnostics['cleanup'] -isnot [System.Collections.IDictionary]) {
    $safePreNativeStages = @(
      'descriptor-validation', 'path-validation', 'path-containment', 'platform-preflight',
      'dependency-preflight', 'system-path-resolution', 'environment-validation',
      'environment-path-validation', 'environment-path-containment', 'executable-hash-validation',
      'identity-dependency'
    )
    if ($errorId -eq 'Morrow.WindowsNativeProcess.InvalidDescriptor' -or
        ($diagnostics -is [System.Collections.IDictionary] -and [string]$diagnostics['stage'] -cin $safePreNativeStages)) {
      return (New-PilotWindowsNativeProcessControllerNotRequiredCleanup)
    }
    return (New-PilotWindowsNativeProcessControllerCleanup -State 'unconfirmed' -JobEmpty $null -RootExited $null -DisposeFailed $null)
  }

  $attempt = $diagnostics['cleanup']
  $attempted = $attempt.Contains('attempted') -and $attempt['attempted'] -is [bool] -and [bool]$attempt['attempted']
  $jobEmpty = if ($attempt.Contains('jobEmpty') -and $attempt['jobEmpty'] -is [bool]) { [bool]$attempt['jobEmpty'] } else { $null }
  $rootExited = if ($attempt.Contains('rootExited') -and $attempt['rootExited'] -is [bool]) { [bool]$attempt['rootExited'] } else { $null }
  $disposeFailed = if ($attempt.Contains('disposeFailed') -and $attempt['disposeFailed'] -is [bool]) { [bool]$attempt['disposeFailed'] } else { $null }
  if ($errorId -ne 'Morrow.WindowsNativeProcess.CleanupIncomplete' -and $attempted -and
      $jobEmpty -eq $true -and $rootExited -eq $true -and ($null -eq $disposeFailed -or $disposeFailed -eq $false)) {
    return (New-PilotWindowsNativeProcessControllerConfirmedCleanup)
  }
  return (New-PilotWindowsNativeProcessControllerCleanup -State 'unconfirmed' `
    -JobEmpty $jobEmpty -RootExited $rootExited -DisposeFailed $disposeFailed)
}

function Get-PilotWindowsNativeProcessControllerDisposeCleanup {
  param([Parameter(Mandatory)][object] $Result)

  $jobEmptyProperty = $Result.PSObject.Properties['jobEmpty']
  $rootExitedProperty = $Result.PSObject.Properties['rootExited']
  $jobEmpty = if ($null -ne $jobEmptyProperty -and $jobEmptyProperty.Value -is [bool]) { [bool]$jobEmptyProperty.Value } else { $null }
  $rootExited = if ($null -ne $rootExitedProperty -and $rootExitedProperty.Value -is [bool]) { [bool]$rootExitedProperty.Value } else { $null }
  if ($jobEmpty -eq $true -and $rootExited -eq $true) { return (New-PilotWindowsNativeProcessControllerConfirmedCleanup) }
  return (New-PilotWindowsNativeProcessControllerCleanup -State 'unconfirmed' `
    -JobEmpty $jobEmpty -RootExited $rootExited -DisposeFailed $false)
}

function Get-PilotWindowsNativeProcessControllerThrownDisposeCleanup {
  param([Parameter(Mandatory)][Exception] $Exception)

  $diagnostics = Get-PilotWindowsNativeProcessControllerExceptionValue -Exception $Exception -Keys @(
    'Morrow.WindowsNativeProcess.Diagnostics'
  )
  $rawCleanup = if ($diagnostics -is [System.Collections.IDictionary] -and $diagnostics.Contains('cleanup') -and
    $diagnostics['cleanup'] -is [System.Collections.IDictionary]) { $diagnostics['cleanup'] } else { $null }
  $jobEmpty = if ($null -ne $rawCleanup -and $rawCleanup.Contains('jobEmpty') -and $rawCleanup['jobEmpty'] -is [bool]) { [bool]$rawCleanup['jobEmpty'] } else { $null }
  $rootExited = if ($null -ne $rawCleanup -and $rawCleanup.Contains('rootExited') -and $rawCleanup['rootExited'] -is [bool]) { [bool]$rawCleanup['rootExited'] } else { $null }
  $disposeFailed = if ($null -ne $rawCleanup -and $rawCleanup.Contains('disposeFailed') -and $rawCleanup['disposeFailed'] -is [bool]) { [bool]$rawCleanup['disposeFailed'] } else { $null }
  return (New-PilotWindowsNativeProcessControllerCleanup -State 'unconfirmed' `
    -JobEmpty $jobEmpty -RootExited $rootExited -DisposeFailed $disposeFailed)
}

function New-PilotWindowsNativeProcessControllerErrorEnvelope {
  param(
    [AllowNull()][object] $RequestId,
    [Parameter(Mandatory)][string] $Code,
    [Parameter(Mandatory)][string] $Stage,
    [string[]] $Fields = @(),
    [Parameter(Mandatory)][System.Collections.IDictionary] $Cleanup
  )

  return [ordered]@{
    version = 1
    requestId = $RequestId
    ok = $false
    error = [ordered]@{ code = $Code; stage = $Stage; fields = [string[]]$Fields }
    cleanup = $Cleanup
  }
}

function New-PilotWindowsNativeProcessControllerSuccessEnvelope {
  param(
    [Parameter(Mandatory)][string] $RequestId,
    [Parameter(Mandatory)][System.Collections.IDictionary] $Result,
    [Parameter(Mandatory)][System.Collections.IDictionary] $Cleanup
  )

  return [ordered]@{ version = 1; requestId = $RequestId; ok = $true; result = $Result; cleanup = $Cleanup }
}

function ConvertTo-PilotWindowsNativeProcessJsonlResponseBytes {
  param([Parameter(Mandatory)][System.Collections.IDictionary] $Envelope)

  try {
    $json = ConvertTo-Json -InputObject $Envelope -Depth 16 -Compress -WarningAction SilentlyContinue -ErrorAction Stop
    $bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes([string]$json + "`n")
  } catch {
    throw (New-PilotWindowsNativeProcessControllerException `
      -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.InternalError' -Stage 'response-serialization')
  }
  if ($bytes.Length -gt 1048576) {
    throw (New-PilotWindowsNativeProcessControllerException `
      -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.ResponseTooLarge' -Stage 'response-serialization')
  }
  return ,$bytes
}

function Write-PilotWindowsNativeProcessControllerResponse {
  param(
    [Parameter(Mandatory)][System.IO.Stream] $OutputStream,
    [Parameter(Mandatory)][System.Collections.IDictionary] $Envelope
  )

  $bytes = ConvertTo-PilotWindowsNativeProcessJsonlResponseBytes -Envelope $Envelope
  $OutputStream.Write($bytes, 0, $bytes.Length)
  $OutputStream.Flush()
}

function Write-PilotWindowsNativeProcessControllerDiagnostic {
  param(
    [Parameter(Mandatory)][System.IO.Stream] $DiagnosticStream,
    [Parameter(Mandatory)][string] $Code,
    [Parameter(Mandatory)][string] $Stage
  )

  $safeCodes = @(
    'MalformedJson', 'InvalidRequest', 'InvalidDescriptor', 'InvalidIdentityAssertion', 'InvalidTimeout',
    'FrameTooLarge', 'DepthExceeded', 'DuplicateProperty', 'InvalidLineEnding', 'DeadlineExceeded',
    'ReadFailed', 'UnexpectedPartialEof', 'BomNotAllowed', 'InvalidEncoding', 'DuplicateRequestId',
    'RequestIdCapacityExceeded', 'ReaderTerminated', 'InvalidReaderContext', 'UnknownCapsule',
    'CapsuleAlreadyActive', 'ResponseTooLarge', 'InvalidInvocation', 'InvalidFrameTimeout',
    'StopTimedOut', 'CleanupIncomplete', 'IdentityMismatch', 'IdentityUnavailable', 'StartFailed',
    'InvalidCapsule', 'CapsuleBusy', 'InternalError'
  )
  $safeStages = @(
    'frame-size', 'line-ending', 'frame-deadline', 'frame-read', 'frame-eof', 'json-depth',
    'json-duplicate-property', 'json-parse', 'root-shape', 'version-validation', 'request-id-validation',
    'operation-validation', 'operation-shape', 'descriptor-validation', 'identity-assertion-validation',
    'capsule-id-validation', 'timeout-validation', 'request-id-replay', 'request-id-capacity',
    'reader-state', 'request-reader', 'start-observation', 'stop-cleanup', 'cleanup', 'shutdown',
    'response-serialization', 'response-write', 'controller', 'entrypoint'
  )
  if ($Code -cnotin $safeCodes) { $Code = 'InternalError' }
  if ($Stage -cnotin $safeStages) { $Stage = 'controller' }
  $text = 'morrow-process-controller code=' + $Code + ' stage=' + $Stage + "`n"
  try {
    $bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes($text)
    $DiagnosticStream.Write($bytes, 0, $bytes.Length)
    $DiagnosticStream.Flush()
  } catch { }
}

function Test-PilotWindowsNativeProcessControllerPipeState {
  param(
    [Parameter(Mandatory)][bool] $InputRedirected,
    [Parameter(Mandatory)][bool] $OutputRedirected,
    [Parameter(Mandatory)][bool] $ErrorRedirected
  )
  return ($InputRedirected -and $OutputRedirected -and $ErrorRedirected)
}

function Get-PilotWindowsNativeProcessControllerProperty {
  param([AllowNull()][object] $InputObject, [Parameter(Mandatory)][string] $Name)
  if ($null -eq $InputObject) { return $null }
  if ($InputObject -is [System.Collections.IDictionary]) {
    if ($InputObject.Contains($Name)) {
      $value = $InputObject[$Name]
      if ($value -is [Array] -or $value -is [Collections.IList]) { return ,$value }
      return $value
    }
    return $null
  }
  $property = $InputObject.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  if ($property.Value -is [Array] -or $property.Value -is [Collections.IList]) { return ,$property.Value }
  return $property.Value
}

function ConvertTo-PilotWindowsNativeProcessControllerInt32 {
  param([AllowNull()][object] $Value)
  if ($null -eq $Value) { return $null }
  $integralTypes = @([byte], [sbyte], [short], [ushort], [int], [uint32], [long], [ulong])
  if ($Value.GetType() -notin $integralTypes) { return $null }
  try {
    $number = [decimal]$Value
    if ($number -lt [int]::MinValue -or $number -gt [int]::MaxValue) { return $null }
    return [int]$number
  } catch { return $null }
}

function ConvertTo-PilotWindowsNativeProcessControllerUInt32 {
  param([AllowNull()][object] $Value)
  if ($null -eq $Value) { return $null }
  $integralTypes = @([byte], [sbyte], [short], [ushort], [int], [uint32], [long], [ulong])
  if ($Value.GetType() -notin $integralTypes) { return $null }
  try {
    $number = [decimal]$Value
    if ($number -lt 0 -or $number -gt [uint32]::MaxValue) { return $null }
    return [uint32]$number
  } catch { return $null }
}

function ConvertTo-PilotWindowsNativeProcessControllerIdentity {
  param([AllowNull()][object] $Identity)
  if ($null -eq $Identity) { return $null }
  $processIdValue = ConvertTo-PilotWindowsNativeProcessControllerInt32 -Value (Get-PilotWindowsNativeProcessControllerProperty -InputObject $Identity -Name 'processId')
  $parentPid = ConvertTo-PilotWindowsNativeProcessControllerInt32 -Value (Get-PilotWindowsNativeProcessControllerProperty -InputObject $Identity -Name 'parentProcessId')
  $executablePath = Get-PilotWindowsNativeProcessControllerProperty -InputObject $Identity -Name 'executablePath'
  $hash = Get-PilotWindowsNativeProcessControllerProperty -InputObject $Identity -Name 'executableSha256'
  $creationTime = Get-PilotWindowsNativeProcessControllerProperty -InputObject $Identity -Name 'creationTimeUtc'
  $ownerSid = Get-PilotWindowsNativeProcessControllerProperty -InputObject $Identity -Name 'ownerSid'
  if ($null -eq $processIdValue -or $processIdValue -lt 1 -or $executablePath -isnot [string] -or $hash -isnot [string] -or
      $creationTime -isnot [string] -or $ownerSid -isnot [string]) { return $null }
  return [ordered]@{
    processId = $processIdValue
    parentProcessId = $parentPid
    executablePath = [string]$executablePath
    executableSha256 = [string]$hash
    creationTimeUtc = [string]$creationTime
    ownerSid = [string]$ownerSid
  }
}

function ConvertTo-PilotWindowsNativeProcessControllerInventory {
  param([AllowNull()][object] $Inventory)
  if ($null -eq $Inventory) { return $null }
  $validStatuses = @('available', 'empty', 'partial', 'unavailable')
  $status = [string](Get-PilotWindowsNativeProcessControllerProperty -InputObject $Inventory -Name 'status')
  if ($status -cnotin $validStatuses) { $status = 'unavailable' }
  $isEmptyValue = Get-PilotWindowsNativeProcessControllerProperty -InputObject $Inventory -Name 'isEmpty'
  $isEmpty = if ($isEmptyValue -is [bool]) { [bool]$isEmptyValue } else { $null }
  $beforeCount = ConvertTo-PilotWindowsNativeProcessControllerInt32 -Value (Get-PilotWindowsNativeProcessControllerProperty -InputObject $Inventory -Name 'memberCountBefore')
  $afterCount = ConvertTo-PilotWindowsNativeProcessControllerInt32 -Value (Get-PilotWindowsNativeProcessControllerProperty -InputObject $Inventory -Name 'memberCountAfter')
  $rawMembers = Get-PilotWindowsNativeProcessControllerProperty -InputObject $Inventory -Name 'members'
  $members = [Collections.Generic.List[object]]::new()
  $allowedMemberStates = @('observed', 'unobservable', 'arrived', 'disappeared')
  $membersTruncated = $false
  if ($rawMembers -is [Array] -or $rawMembers -is [Collections.IList]) {
    $membersTruncated = $rawMembers.Count -gt 64
    foreach ($rawMember in @($rawMembers | Select-Object -First 64)) {
      $processId = ConvertTo-PilotWindowsNativeProcessControllerInt32 -Value (Get-PilotWindowsNativeProcessControllerProperty -InputObject $rawMember -Name 'processId')
      $memberState = [string](Get-PilotWindowsNativeProcessControllerProperty -InputObject $rawMember -Name 'state')
      if ($null -eq $processId -or $processId -lt 1) { continue }
      if ($memberState -cnotin $allowedMemberStates) { $memberState = 'unobservable' }
      $rawMetadata = Get-PilotWindowsNativeProcessControllerProperty -InputObject $rawMember -Name 'metadata'
      $metadata = $null
      if ($null -ne $rawMetadata) {
        $metadataPid = ConvertTo-PilotWindowsNativeProcessControllerInt32 -Value (Get-PilotWindowsNativeProcessControllerProperty -InputObject $rawMetadata -Name 'processId')
        $metadataParentPid = ConvertTo-PilotWindowsNativeProcessControllerInt32 -Value (Get-PilotWindowsNativeProcessControllerProperty -InputObject $rawMetadata -Name 'parentProcessId')
        $name = Get-PilotWindowsNativeProcessControllerProperty -InputObject $rawMetadata -Name 'name'
        $metadataTime = Get-PilotWindowsNativeProcessControllerProperty -InputObject $rawMetadata -Name 'creationTimeUtc'
        if ($metadataPid -eq $processId -and ($null -eq $name -or $name -is [string]) -and
            ($null -eq $metadataTime -or $metadataTime -is [string])) {
          $metadata = [ordered]@{
            processId = $metadataPid
            parentProcessId = $metadataParentPid
            name = if ($name -is [string]) { [string]$name } else { $null }
            creationTimeUtc = if ($metadataTime -is [string]) { [string]$metadataTime } else { $null }
          }
        }
      }
      [void]$members.Add([ordered]@{ processId = $processId; state = $memberState; metadata = $metadata })
    }
  }
  if ($membersTruncated -and $status -ceq 'available') { $status = 'partial' }
  return [ordered]@{
    status = $status
    isEmpty = $isEmpty
    memberCountBefore = $beforeCount
    memberCountAfter = $afterCount
    members = [object[]]$members.ToArray()
  }
}

function ConvertTo-PilotWindowsNativeProcessControllerObservation {
  param([Parameter(Mandatory)][object] $Observation)
  $rawRoot = Get-PilotWindowsNativeProcessControllerProperty -InputObject $Observation -Name 'root'
  $rawInventory = Get-PilotWindowsNativeProcessControllerProperty -InputObject $Observation -Name 'inventory'
  if ($null -eq $rawRoot -or $null -eq $rawInventory) { return $null }
  $rootState = [string](Get-PilotWindowsNativeProcessControllerProperty -InputObject $rawRoot -Name 'state')
  if ($rootState -cnotin @('alive', 'exited', 'unavailable')) { $rootState = 'unavailable' }
  $identityStatus = [string](Get-PilotWindowsNativeProcessControllerProperty -InputObject $rawRoot -Name 'identityStatus')
  if ($identityStatus -cnotin @('fresh', 'snapshot', 'unavailable')) { $identityStatus = 'unavailable' }
  $identityFreshValue = Get-PilotWindowsNativeProcessControllerProperty -InputObject $rawRoot -Name 'identityFresh'
  $identityFresh = if ($identityFreshValue -is [bool]) { [bool]$identityFreshValue } else { ($identityStatus -eq 'fresh') }
  $identity = ConvertTo-PilotWindowsNativeProcessControllerIdentity `
    -Identity (Get-PilotWindowsNativeProcessControllerProperty -InputObject $rawRoot -Name 'identity')
  $exitCode = ConvertTo-PilotWindowsNativeProcessControllerUInt32 `
    -Value (Get-PilotWindowsNativeProcessControllerProperty -InputObject $rawRoot -Name 'exitCode')
  return [ordered]@{
    root = [ordered]@{
      state = $rootState
      identityStatus = $identityStatus
      identityFresh = [bool]$identityFresh
      identity = $identity
      exitCode = $exitCode
    }
    inventory = ConvertTo-PilotWindowsNativeProcessControllerInventory -Inventory $rawInventory
  }
}

function Test-PilotWindowsNativeProcessControllerIdentityProof {
  param([Parameter(Mandatory)][System.Collections.IDictionary] $Observation)
  $root = $Observation['root']
  return ($root['identityStatus'] -cin @('fresh', 'snapshot') -and
    $root['identity'] -is [System.Collections.IDictionary] -and
    $root['identity']['processId'] -is [int] -and $root['identity']['processId'] -gt 0)
}

function Invoke-PilotWindowsNativeProcessControllerOperation {
  param(
    [Parameter(Mandatory)][string] $Name,
    [Parameter(Mandatory)][object] $Arguments,
    [AllowNull()][System.Collections.IDictionary] $TestOperations,
    [Parameter(Mandatory)][scriptblock] $DefaultOperation
  )
  $operation = $DefaultOperation
  if ($null -ne $TestOperations) {
    if (-not $TestOperations.Contains($Name) -or $TestOperations[$Name] -isnot [scriptblock]) {
      throw (New-PilotWindowsNativeProcessControllerException `
        -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.InternalError' -Stage 'controller')
    }
    $operation = [scriptblock]$TestOperations[$Name]
  }
  $result = & $operation @Arguments
  return ,$result
}

function Invoke-PilotWindowsNativeProcessControllerDispose {
  param(
    [Parameter(Mandatory)][object] $Capsule,
    [AllowNull()][System.Collections.IDictionary] $TestOperations
  )
  $defaultDispose = { param($ownedCapsule) return $ownedCapsule.Dispose() }
  return (Invoke-PilotWindowsNativeProcessControllerOperation -Name 'Dispose' `
    -Arguments ([object[]]@($Capsule)) -TestOperations $TestOperations -DefaultOperation $defaultDispose)
}

function Invoke-PilotWindowsNativeProcessControllerCleanup {
  param(
    [Parameter(Mandatory)][object] $ControllerState,
    [AllowNull()][System.Collections.IDictionary] $TestOperations
  )
  $capsule = $ControllerState.Capsule
  if ($null -eq $capsule) { return (New-PilotWindowsNativeProcessControllerNotRequiredCleanup) }
  try {
    $cleanupResult = Invoke-PilotWindowsNativeProcessControllerDispose -Capsule $capsule -TestOperations $TestOperations
    $cleanup = Get-PilotWindowsNativeProcessControllerDisposeCleanup -Result $cleanupResult
  } catch {
    $cleanup = Get-PilotWindowsNativeProcessControllerThrownDisposeCleanup -Exception $_.Exception
  } finally {
    $ControllerState.Capsule = $null
    $ControllerState.CapsuleId = $null
  }
  return $cleanup
}

function Get-PilotWindowsNativeProcessControllerNewCapsuleId {
  param([AllowNull()][scriptblock] $TestCapsuleIdFactory)
  $value = if ($null -eq $TestCapsuleIdFactory) { [Guid]::NewGuid().ToString('D') } else { [string](& $TestCapsuleIdFactory) }
  $parsed = [Guid]::Empty
  if (-not [Guid]::TryParseExact($value, 'D', [ref]$parsed)) {
    throw (New-PilotWindowsNativeProcessControllerException `
      -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.InternalError' -Stage 'capsule-state')
  }
  return $parsed.ToString('D')
}

function New-PilotWindowsNativeProcessControllerFacadeError {
  param([Parameter(Mandatory)][string] $ErrorId, [Parameter(Mandatory)][string] $Stage)
  $exception = [InvalidOperationException]::new('The Windows native process policy operation failed.')
  $exception.Data['Morrow.WindowsNativeProcess.ErrorId'] = $ErrorId
  $exception.Data['Morrow.WindowsNativeProcess.Diagnostics'] = [ordered]@{
    stage = $Stage
    fields = @()
  }
  return $exception
}

function Invoke-PilotWindowsNativeProcessControllerRequest {
  param(
    [Parameter(Mandatory)][System.Collections.IDictionary] $Request,
    [Parameter(Mandatory)][object] $ControllerState,
    [AllowNull()][System.Collections.IDictionary] $TestOperations,
    [AllowNull()][scriptblock] $TestCapsuleIdFactory
  )

  $requestId = [string]$Request['requestId']
  $operationName = [string]$Request['operation']
  $notRequiredCleanup = New-PilotWindowsNativeProcessControllerNotRequiredCleanup
  if ($operationName -ceq 'start' -and $null -ne $ControllerState.Capsule) {
    $error = New-PilotWindowsNativeProcessControllerErrorEnvelope -RequestId $requestId `
      -Code 'CapsuleAlreadyActive' -Stage 'capsule-state' -Fields @() -Cleanup $notRequiredCleanup
    return [pscustomobject]@{ Envelope = $error; Terminal = $false; FatalCode = $null }
  }

  if ($operationName -ceq 'observe' -or $operationName -ceq 'stop') {
    if ($null -eq $ControllerState.Capsule -or
        -not [string]::Equals([string]$Request['capsuleId'], [string]$ControllerState.CapsuleId, [StringComparison]::Ordinal)) {
      $error = New-PilotWindowsNativeProcessControllerErrorEnvelope -RequestId $requestId `
        -Code 'UnknownCapsule' -Stage 'capsule-lookup' -Fields @() -Cleanup $notRequiredCleanup
      return [pscustomobject]@{ Envelope = $error; Terminal = $false; FatalCode = $null }
    }
  }

  if ($operationName -ceq 'start') {
    $defaultStart = { param($descriptor) Start-WindowsNativeProcess -Descriptor $descriptor }
    try {
      $capsule = Invoke-PilotWindowsNativeProcessControllerOperation -Name 'Start' `
        -Arguments ([object[]]@($Request['descriptor'])) -TestOperations $TestOperations -DefaultOperation $defaultStart
      if ($null -eq $capsule) {
        $error = New-PilotWindowsNativeProcessControllerErrorEnvelope -RequestId $requestId `
          -Code 'StartFailed' -Stage 'start' -Fields @() `
          -Cleanup (New-PilotWindowsNativeProcessControllerCleanup -State 'unconfirmed' -JobEmpty $null -RootExited $null -DisposeFailed $null)
        return [pscustomobject]@{ Envelope = $error; Terminal = $true; FatalCode = 'StartFailed' }
      }
      # Retain ownership before Observe or any serialization can fail.
      $ControllerState.Capsule = $capsule
    } catch {
      $errorInfo = Get-PilotWindowsNativeProcessControllerErrorInfo -Exception $_.Exception -FallbackStage 'start'
      $cleanup = Get-PilotWindowsNativeProcessControllerStartFailureCleanup -Exception $_.Exception
      $knownRecoverableStartFailure = $errorInfo.code -in @('IdentityMismatch', 'InvalidDescriptor', 'InvalidFrameTimeout', 'StartFailed')
      $terminal = $cleanup['state'] -eq 'unconfirmed' -or -not $knownRecoverableStartFailure
      $error = New-PilotWindowsNativeProcessControllerErrorEnvelope -RequestId $requestId `
        -Code $errorInfo.code -Stage $errorInfo.stage -Fields $errorInfo.fields -Cleanup $cleanup
      return [pscustomobject]@{ Envelope = $error; Terminal = $terminal; FatalCode = if ($terminal) { $errorInfo.code } else { $null } }
    }

    $defaultObserve = { param($ownedCapsule, $assertion) Observe-WindowsNativeProcess -Capsule $ownedCapsule -IdentityAssertion $assertion }
    try {
      $rawObservation = Invoke-PilotWindowsNativeProcessControllerOperation -Name 'Observe' `
        -Arguments ([object[]]@($capsule, $null)) -TestOperations $TestOperations -DefaultOperation $defaultObserve
      $observation = if ($null -eq $rawObservation) { $null } else {
        ConvertTo-PilotWindowsNativeProcessControllerObservation -Observation $rawObservation
      }
      if ($null -eq $observation -or -not (Test-PilotWindowsNativeProcessControllerIdentityProof -Observation $observation)) {
        throw (New-PilotWindowsNativeProcessControllerFacadeError `
          -ErrorId 'Morrow.WindowsNativeProcess.IdentityUnavailable' -Stage 'start-identity')
      }
      $capsuleId = Get-PilotWindowsNativeProcessControllerNewCapsuleId -TestCapsuleIdFactory $TestCapsuleIdFactory
      $ControllerState.CapsuleId = $capsuleId
      $result = [ordered]@{
        capsuleId = $capsuleId
        root = $observation.root
        inventory = $observation.inventory
      }
      $success = New-PilotWindowsNativeProcessControllerSuccessEnvelope `
        -RequestId $requestId -Result $result -Cleanup $notRequiredCleanup
      return [pscustomobject]@{ Envelope = $success; Terminal = $false; FatalCode = $null }
    } catch {
      $errorInfo = Get-PilotWindowsNativeProcessControllerErrorInfo -Exception $_.Exception -FallbackStage 'start-observation'
      $cleanup = Invoke-PilotWindowsNativeProcessControllerCleanup -ControllerState $ControllerState -TestOperations $TestOperations
      $error = New-PilotWindowsNativeProcessControllerErrorEnvelope -RequestId $requestId `
        -Code $errorInfo.code -Stage $errorInfo.stage -Fields $errorInfo.fields -Cleanup $cleanup
      return [pscustomobject]@{ Envelope = $error; Terminal = $true; FatalCode = $errorInfo.code }
    }
  }

  if ($operationName -ceq 'observe') {
    $defaultObserve = { param($ownedCapsule, $assertion) Observe-WindowsNativeProcess -Capsule $ownedCapsule -IdentityAssertion $assertion }
    $assertion = if ($Request.ContainsKey('identityAssertion')) { $Request['identityAssertion'] } else { $null }
    try {
      $rawObservation = Invoke-PilotWindowsNativeProcessControllerOperation -Name 'Observe' `
        -Arguments ([object[]]@($ControllerState.Capsule, $assertion)) -TestOperations $TestOperations -DefaultOperation $defaultObserve
      $observation = if ($null -eq $rawObservation) { $null } else {
        ConvertTo-PilotWindowsNativeProcessControllerObservation -Observation $rawObservation
      }
      if ($null -eq $observation) {
        throw (New-PilotWindowsNativeProcessControllerFacadeError `
          -ErrorId 'Morrow.WindowsNativeProcess.IdentityUnavailable' -Stage 'observe')
      }
      $result = [ordered]@{
        capsuleId = [string]$ControllerState.CapsuleId
        root = $observation.root
        inventory = $observation.inventory
      }
      $success = New-PilotWindowsNativeProcessControllerSuccessEnvelope `
        -RequestId $requestId -Result $result -Cleanup $notRequiredCleanup
      return [pscustomobject]@{ Envelope = $success; Terminal = $false; FatalCode = $null }
    } catch {
      $errorInfo = Get-PilotWindowsNativeProcessControllerErrorInfo -Exception $_.Exception -FallbackStage 'observe'
      if ($errorInfo.code -eq 'IdentityMismatch') {
        $error = New-PilotWindowsNativeProcessControllerErrorEnvelope -RequestId $requestId `
          -Code $errorInfo.code -Stage $errorInfo.stage -Fields $errorInfo.fields -Cleanup $notRequiredCleanup
        return [pscustomobject]@{ Envelope = $error; Terminal = $false; FatalCode = $null }
      }
      $cleanup = Invoke-PilotWindowsNativeProcessControllerCleanup -ControllerState $ControllerState -TestOperations $TestOperations
      $terminal = $true
      $error = New-PilotWindowsNativeProcessControllerErrorEnvelope -RequestId $requestId `
        -Code $errorInfo.code -Stage $errorInfo.stage -Fields $errorInfo.fields -Cleanup $cleanup
      return [pscustomobject]@{ Envelope = $error; Terminal = $terminal; FatalCode = $errorInfo.code }
    }
  }

  if ($operationName -ceq 'stop') {
    $defaultStop = {
      param($ownedCapsule, $identityAssertion, $timeoutMilliseconds, $timeoutWasSpecified)
      if ($timeoutWasSpecified) {
        Stop-WindowsNativeProcess -Capsule $ownedCapsule -IdentityAssertion $identityAssertion `
          -TimeoutMilliseconds $timeoutMilliseconds
      } else {
        Stop-WindowsNativeProcess -Capsule $ownedCapsule -IdentityAssertion $identityAssertion
      }
    }
    $assertion = if ($Request.ContainsKey('identityAssertion')) { $Request['identityAssertion'] } else { $null }
    $timeoutWasSpecified = $Request.ContainsKey('timeoutMs')
    $timeoutMilliseconds = if ($timeoutWasSpecified) { [int]$Request['timeoutMs'] } else { $null }
    try {
      $stopResult = Invoke-PilotWindowsNativeProcessControllerOperation -Name 'Stop' `
        -Arguments ([object[]]@($ControllerState.Capsule, $assertion, $timeoutMilliseconds, [bool]$timeoutWasSpecified)) `
        -TestOperations $TestOperations -DefaultOperation $defaultStop
    } catch {
      $errorInfo = Get-PilotWindowsNativeProcessControllerErrorInfo -Exception $_.Exception -FallbackStage 'stop'
      if ($errorInfo.code -eq 'IdentityMismatch') {
        $error = New-PilotWindowsNativeProcessControllerErrorEnvelope -RequestId $requestId `
          -Code $errorInfo.code -Stage $errorInfo.stage -Fields $errorInfo.fields -Cleanup $notRequiredCleanup
        return [pscustomobject]@{ Envelope = $error; Terminal = $false; FatalCode = $null }
      }
      $cleanup = Invoke-PilotWindowsNativeProcessControllerCleanup -ControllerState $ControllerState -TestOperations $TestOperations
      $error = New-PilotWindowsNativeProcessControllerErrorEnvelope -RequestId $requestId `
        -Code $errorInfo.code -Stage $errorInfo.stage -Fields $errorInfo.fields -Cleanup $cleanup
      return [pscustomobject]@{ Envelope = $error; Terminal = $true; FatalCode = $errorInfo.code }
    }

    $completed = (Get-PilotWindowsNativeProcessControllerProperty -InputObject $stopResult -Name 'completed') -is [bool] -and
      [bool](Get-PilotWindowsNativeProcessControllerProperty -InputObject $stopResult -Name 'completed')
    $timedOut = (Get-PilotWindowsNativeProcessControllerProperty -InputObject $stopResult -Name 'timedOut') -is [bool] -and
      [bool](Get-PilotWindowsNativeProcessControllerProperty -InputObject $stopResult -Name 'timedOut')
    $jobEmpty = (Get-PilotWindowsNativeProcessControllerProperty -InputObject $stopResult -Name 'jobEmpty') -is [bool] -and
      [bool](Get-PilotWindowsNativeProcessControllerProperty -InputObject $stopResult -Name 'jobEmpty')
    $rootExited = (Get-PilotWindowsNativeProcessControllerProperty -InputObject $stopResult -Name 'rootExited') -is [bool] -and
      [bool](Get-PilotWindowsNativeProcessControllerProperty -InputObject $stopResult -Name 'rootExited')
    $exitCode = ConvertTo-PilotWindowsNativeProcessControllerUInt32 `
      -Value (Get-PilotWindowsNativeProcessControllerProperty -InputObject $stopResult -Name 'exitCode')
    if ($timedOut -or -not ($completed -and $jobEmpty -and $rootExited)) {
      $errorCode = if ($timedOut) { 'StopTimedOut' } else { 'CleanupIncomplete' }
      $cleanup = Invoke-PilotWindowsNativeProcessControllerCleanup -ControllerState $ControllerState -TestOperations $TestOperations
      $error = New-PilotWindowsNativeProcessControllerErrorEnvelope -RequestId $requestId `
        -Code $errorCode -Stage 'stop-cleanup' -Fields @() -Cleanup $cleanup
      return [pscustomobject]@{ Envelope = $error; Terminal = $true; FatalCode = $errorCode }
    }

    $capsuleId = [string]$ControllerState.CapsuleId
    $ControllerState.Capsule = $null
    $ControllerState.CapsuleId = $null
    $result = [ordered]@{
      capsuleId = $capsuleId
      completed = $true
      timedOut = $false
      jobEmpty = $true
      rootExited = $true
      exitCode = $exitCode
    }
    $success = New-PilotWindowsNativeProcessControllerSuccessEnvelope `
      -RequestId $requestId -Result $result -Cleanup (New-PilotWindowsNativeProcessControllerConfirmedCleanup)
    return [pscustomobject]@{ Envelope = $success; Terminal = $false; FatalCode = $null }
  }

  $unknownOperationError = New-PilotWindowsNativeProcessControllerErrorEnvelope -RequestId $requestId `
    -Code 'InvalidRequest' -Stage 'operation-validation' -Fields @() -Cleanup $notRequiredCleanup
  return [pscustomobject]@{ Envelope = $unknownOperationError; Terminal = $true; FatalCode = 'InvalidRequest' }
}

function Invoke-PilotWindowsNativeProcessJsonlController {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][System.IO.Stream] $InputStream,
    [Parameter(Mandatory)][System.IO.Stream] $OutputStream,
    [Parameter(Mandatory)][System.IO.Stream] $DiagnosticStream,
    [ValidateRange(1, 120000)][int] $FrameTimeoutMilliseconds = 120000,
    [AllowNull()][System.Collections.IDictionary] $TestOperations,
    [AllowNull()][scriptblock] $TestCapsuleIdFactory
  )

  if (-not $InputStream.CanRead -or -not $OutputStream.CanWrite -or -not $DiagnosticStream.CanWrite) {
    Write-PilotWindowsNativeProcessControllerDiagnostic -DiagnosticStream $DiagnosticStream `
      -Code 'InvalidInvocation' -Stage 'entrypoint'
    return 64
  }
  if ($null -ne $TestOperations) {
    foreach ($name in @('Start', 'Observe', 'Stop', 'Dispose')) {
      if (-not $TestOperations.Contains($name) -or $TestOperations[$name] -isnot [scriptblock]) {
        Write-PilotWindowsNativeProcessControllerDiagnostic -DiagnosticStream $DiagnosticStream `
          -Code 'InternalError' -Stage 'controller'
        return 70
      }
    }
  }

  $oldErrorAction = $ErrorActionPreference
  $oldWarning = $WarningPreference
  $oldInformation = $InformationPreference
  $oldVerbose = $VerbosePreference
  $oldProgress = $ProgressPreference
  $ErrorActionPreference = 'Stop'
  $WarningPreference = 'SilentlyContinue'
  $InformationPreference = 'SilentlyContinue'
  $VerbosePreference = 'SilentlyContinue'
  $ProgressPreference = 'SilentlyContinue'
  $controllerState = [pscustomobject]@{ Capsule = $null; CapsuleId = $null }
  $readerContext = $null
  try {
    $readerContext = New-PilotWindowsNativeProcessJsonlReaderContext `
      -Stream $InputStream -FrameTimeoutMilliseconds $FrameTimeoutMilliseconds
  } catch {
    Write-PilotWindowsNativeProcessControllerDiagnostic -DiagnosticStream $DiagnosticStream `
      -Code 'InternalError' -Stage 'reader'
    return 70
  }

  try {
    while ($true) {
      $request = $null
      try {
        $request = Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $readerContext
      } catch {
        $errorInfo = Get-PilotWindowsNativeProcessControllerErrorInfo -Exception $_.Exception -FallbackStage 'reader'
        $cleanup = Invoke-PilotWindowsNativeProcessControllerCleanup -ControllerState $controllerState -TestOperations $TestOperations
        $envelope = New-PilotWindowsNativeProcessControllerErrorEnvelope -RequestId $null `
          -Code $errorInfo.code -Stage $errorInfo.stage -Fields $errorInfo.fields -Cleanup $cleanup
        try {
          Write-PilotWindowsNativeProcessControllerResponse -OutputStream $OutputStream -Envelope $envelope
        } catch {
          Write-PilotWindowsNativeProcessControllerDiagnostic -DiagnosticStream $DiagnosticStream `
            -Code $errorInfo.code -Stage $errorInfo.stage
        }
        if ($cleanup['state'] -ne 'confirmed' -and $cleanup['state'] -ne 'not-required') {
          Write-PilotWindowsNativeProcessControllerDiagnostic -DiagnosticStream $DiagnosticStream `
            -Code 'CleanupIncomplete' -Stage 'cleanup'
        }
        return 1
      }

      if ($null -eq $request) {
        $cleanup = Invoke-PilotWindowsNativeProcessControllerCleanup `
          -ControllerState $controllerState -TestOperations $TestOperations
        if ($cleanup['state'] -in @('not-required', 'confirmed')) { return 0 }
        Write-PilotWindowsNativeProcessControllerDiagnostic -DiagnosticStream $DiagnosticStream `
          -Code 'CleanupIncomplete' -Stage 'shutdown'
        return 1
      }

      try {
        $dispatch = Invoke-PilotWindowsNativeProcessControllerRequest `
          -Request $request -ControllerState $controllerState -TestOperations $TestOperations `
          -TestCapsuleIdFactory $TestCapsuleIdFactory
      } catch {
        $errorInfo = Get-PilotWindowsNativeProcessControllerErrorInfo -Exception $_.Exception -FallbackStage 'controller'
        $cleanup = Invoke-PilotWindowsNativeProcessControllerCleanup -ControllerState $controllerState -TestOperations $TestOperations
        $dispatch = [pscustomobject]@{
          Envelope = New-PilotWindowsNativeProcessControllerErrorEnvelope -RequestId ([string]$request['requestId']) `
            -Code $errorInfo.code -Stage $errorInfo.stage -Fields $errorInfo.fields -Cleanup $cleanup
          Terminal = $true
          FatalCode = $errorInfo.code
        }
      }

      try {
        Write-PilotWindowsNativeProcessControllerResponse -OutputStream $OutputStream -Envelope $dispatch.Envelope
      } catch {
        $writeError = Get-PilotWindowsNativeProcessControllerErrorInfo -Exception $_.Exception -FallbackStage 'response-write'
        if ($writeError.code -eq 'ResponseTooLarge') {
          $cleanup = Invoke-PilotWindowsNativeProcessControllerCleanup -ControllerState $controllerState -TestOperations $TestOperations
          $fallback = New-PilotWindowsNativeProcessControllerErrorEnvelope `
            -RequestId ([string]$request['requestId']) -Code 'ResponseTooLarge' `
            -Stage 'response-serialization' -Fields @() -Cleanup $cleanup
          try {
            Write-PilotWindowsNativeProcessControllerResponse -OutputStream $OutputStream -Envelope $fallback
          } catch {
            Write-PilotWindowsNativeProcessControllerDiagnostic -DiagnosticStream $DiagnosticStream `
              -Code 'ResponseTooLarge' -Stage 'response-write'
            return 1
          }
          return 1
        }
        $cleanup = Invoke-PilotWindowsNativeProcessControllerCleanup -ControllerState $controllerState -TestOperations $TestOperations
        Write-PilotWindowsNativeProcessControllerDiagnostic -DiagnosticStream $DiagnosticStream `
          -Code $writeError.code -Stage $writeError.stage
        return 1
      }

      if ([bool]$dispatch.Terminal) {
        if ($dispatch.FatalCode) {
          Write-PilotWindowsNativeProcessControllerDiagnostic -DiagnosticStream $DiagnosticStream `
            -Code ([string]$dispatch.FatalCode) -Stage ([string]$dispatch.Envelope.error.stage)
        }
        return 1
      }
    }
  } finally {
    $ErrorActionPreference = $oldErrorAction
    $WarningPreference = $oldWarning
    $InformationPreference = $oldInformation
    $VerbosePreference = $oldVerbose
    $ProgressPreference = $oldProgress
  }
}

function Write-PilotWindowsNativeProcessControllerStartupFailure {
  param([Parameter(Mandatory)][string] $Code)
  if (-not [Console]::IsOutputRedirected -or -not [Console]::IsErrorRedirected) { return }
  $diagnostic = [Console]::OpenStandardError()
  try {
    Write-PilotWindowsNativeProcessControllerDiagnostic -DiagnosticStream $diagnostic -Code $Code -Stage 'entrypoint'
  } finally {
    $diagnostic.Dispose()
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  if ($args.Count -gt 0 -or -not [string]::Equals([string]$Protocol, 'stdio-v1', [StringComparison]::Ordinal)) {
    Write-PilotWindowsNativeProcessControllerStartupFailure -Code 'InvalidInvocation'
    exit 64
  }
  $frameTimeoutValue = 0
  $frameTimeoutValid = $FrameTimeoutMilliseconds.Length -le 6 -and
    [int]::TryParse($FrameTimeoutMilliseconds, [Globalization.NumberStyles]::None,
      [Globalization.CultureInfo]::InvariantCulture, [ref]$frameTimeoutValue) -and
    $frameTimeoutValue -ge 1 -and $frameTimeoutValue -le 120000
  if (-not $frameTimeoutValid) {
    Write-PilotWindowsNativeProcessControllerStartupFailure -Code 'InvalidFrameTimeout'
    exit 64
  }
  if (-not (Test-PilotWindowsNativeProcessControllerPipeState `
      -InputRedirected ([Console]::IsInputRedirected) `
      -OutputRedirected ([Console]::IsOutputRedirected) `
      -ErrorRedirected ([Console]::IsErrorRedirected))) {
    Write-PilotWindowsNativeProcessControllerStartupFailure -Code 'InvalidInvocation'
    exit 64
  }
  $standardInput = [Console]::OpenStandardInput()
  $standardOutput = [Console]::OpenStandardOutput()
  $standardError = [Console]::OpenStandardError()
  try {
    $exitCode = Invoke-PilotWindowsNativeProcessJsonlController `
      -InputStream $standardInput -OutputStream $standardOutput -DiagnosticStream $standardError `
      -FrameTimeoutMilliseconds $frameTimeoutValue
    exit [int]$exitCode
  } catch {
    Write-PilotWindowsNativeProcessControllerDiagnostic -DiagnosticStream $standardError `
      -Code 'InternalError' -Stage 'controller'
    exit 70
  }
}
