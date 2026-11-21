[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string] $EvidenceRoot,
  [ValidateNotNullOrEmpty()][string] $ReaderPath = (Join-Path $PSScriptRoot 'windows-native-process.ps1')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-JsonlOwnCheck {
  param(
    [Parameter(Mandatory)][bool] $Condition,
    [Parameter(Mandatory)][string] $Name,
    [Parameter(Mandatory)][System.Collections.IDictionary] $Checks
  )

  if (-not $Condition) { throw "Acceptance check failed: $Name" }
  $Checks[$Name] = $true
}

function Get-JsonlOwnErrorId {
  param([Parameter(Mandatory)][Exception] $Exception)

  $current = $Exception
  for ($depth = 0; $null -ne $current -and $depth -lt 8; $depth++) {
    if ($current.Data.Contains('Morrow.WindowsNativeProcess.Jsonl.ErrorId')) {
      return [string]$current.Data['Morrow.WindowsNativeProcess.Jsonl.ErrorId']
    }
    $current = $current.InnerException
  }
  return $null
}

function Get-JsonlOwnDiagnostics {
  param([Parameter(Mandatory)][Exception] $Exception)

  $current = $Exception
  for ($depth = 0; $null -ne $current -and $depth -lt 8; $depth++) {
    if ($current.Data.Contains('Morrow.WindowsNativeProcess.Jsonl.Diagnostics')) {
      return $current.Data['Morrow.WindowsNativeProcess.Jsonl.Diagnostics']
    }
    $current = $current.InnerException
  }
  return $null
}

function Assert-JsonlOwnFailure {
  param(
    [Parameter(Mandatory)][scriptblock] $Action,
    [Parameter(Mandatory)][string] $ExpectedErrorId
  )

  $captured = $null
  try { $null = & $Action } catch { $captured = $_.Exception }
  if ($null -eq $captured) { throw "Expected rejection: $ExpectedErrorId" }
  $actualErrorId = Get-JsonlOwnErrorId -Exception $captured
  if ($actualErrorId -cne $ExpectedErrorId) { throw "Unexpected rejection: $ExpectedErrorId" }
  $diagnostics = Get-JsonlOwnDiagnostics -Exception $captured
  if ($diagnostics -isnot [System.Collections.IDictionary] -or
      @($diagnostics.Keys).Count -ne 2 -or
      @($diagnostics['fields']).Count -ne 0) {
    throw "Unsafe error diagnostics: $ExpectedErrorId"
  }
  if ($captured.Message -match 'capsule-|RUNNER_TEMP|[0-9A-Fa-f]{36}') {
    throw "Error message contains request data: $ExpectedErrorId"
  }
}

function New-JsonlOwnObserveText {
  param(
    [Parameter(Mandatory)][string] $RequestId,
    [string] $CapsuleId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  )

  return '{"version":1,"requestId":"' + $RequestId + '","operation":"observe","capsuleId":"' + $CapsuleId + '"}'
}

function New-JsonlOwnStopText {
  param(
    [Parameter(Mandatory)][string] $RequestId,
    [Parameter(Mandatory)][string] $TimeoutJson
  )

  return '{"version":1,"requestId":"' + $RequestId + '","operation":"stop","capsuleId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","timeoutMs":' + $TimeoutJson + '}'
}

function New-JsonlOwnStartText {
  param(
    [Parameter(Mandatory)][string] $RequestId,
    [string[]] $ArgumentList = @()
  )

  $descriptor = [ordered]@{
    executablePath = 'C:\Pilot\pwsh.exe'
    executableSha256 = ('A' * 64)
    argumentList = @($ArgumentList)
    workingDirectory = 'C:\Pilot'
    profilePath = 'C:\Pilot\Profile'
    environment = [ordered]@{
      SYSTEMROOT = 'C:\Windows'
      WINDIR = 'C:\Windows'
      PATH = 'C:\Windows\System32'
      USERPROFILE = 'C:\Pilot'
      APPDATA = 'C:\Pilot\AppData'
      LOCALAPPDATA = 'C:\Pilot\LocalAppData'
      TEMP = 'C:\Pilot\Temp'
      TMP = 'C:\Pilot\Temp'
    }
    expectedParentProcessId = [int]1
    expectedOwnerSid = 'S-1-5-18'
  }
  $descriptorJson = ConvertTo-Json -InputObject $descriptor -Depth 8 -Compress
  return '{"version":1,"requestId":"' + $RequestId + '","operation":"start","descriptor":' + $descriptorJson + '}'
}

function New-JsonlOwnMemoryReader {
  param(
    [Parameter(Mandatory)][AllowEmptyCollection()][byte[]] $Bytes,
    [int] $FrameTimeoutMilliseconds = 120000,
    [int] $ChunkSize = 4096
  )

  $stream = [Morrow.Pilot.JsonlTest.ChunkedMemoryStream]::new($Bytes, $ChunkSize)
  $context = New-PilotWindowsNativeProcessJsonlReaderContext `
    -Stream $stream `
    -FrameTimeoutMilliseconds $FrameTimeoutMilliseconds
  return [pscustomobject]@{ Stream = $stream; Context = $context }
}

function ConvertTo-JsonlOwnBytes {
  param([Parameter(Mandatory)][AllowEmptyString()][string] $Text)

  $encoding = [System.Text.UTF8Encoding]::new($false, $true)
  return ,$encoding.GetBytes($Text)
}

function Get-JsonlOwnContainerDepthErrorId {
  param([Parameter(Mandatory)][string] $Json)

  $options = [System.Text.Json.JsonDocumentOptions]::new()
  $options.MaxDepth = 64
  $document = [System.Text.Json.JsonDocument]::Parse($Json, $options)
  try {
    try {
      Assert-PilotWindowsNativeProcessJsonlNoDuplicateProperties `
        -Element $document.RootElement `
        -ContainerDepth 1
      return $null
    } catch {
      return Get-JsonlOwnErrorId -Exception $_.Exception
    }
  } finally {
    $document.Dispose()
  }
}

$script:JsonlOwnRunId = [Guid]::NewGuid().ToString('N')

$script:JsonlOwnChecks = [ordered]@{
  dotSourceDefinesFunctionsWithoutNativeTypes = $false
  cleanEofIsDistinct = $false
  lfFrameAccepted = $false
  coalescedFramesArePreserved = $false
  crlfAndMultibyteMayCrossReadBoundary = $false
  blankLfIsRejectedAsMalformedJson = $false
  preservesOriginalRequestIdAndPayload = $false
  capsuleIdIsGuidDAndCanonicalized = $false
  capsuleIdRejectsNonGuidValues = $false
  exactContentLimitAndTerminalCrlfAccepted = $false
  oversizedPartialFrameRejected = $false
  depthTwelveAccepted = $false
  depthThirteenRejected = $false
  duplicateExactPropertyRejected = $false
  duplicateCaseCollisionRejected = $false
  duplicateEscapedPropertyRejected = $false
  nestedDuplicateRejectedBeforeSchema = $false
  duplicateInsideArrayRejected = $false
  bomRejected = $false
  invalidUtf8Rejected = $false
  rawCarriageReturnRejected = $false
  partialEofRejected = $false
  malformedJsonRejected = $false
  rootSchemaIsClosedAndCaseExact = $false
  operationShapesAreClosed = $false
  versionRequiresIntegerToken = $false
  requestIdRequiresExactGuidD = $false
  descriptorIsValidatedWithoutNativeCalls = $false
  assertionShapeIsValidatedWithoutRewriting = $false
  emptyIdentityAssertionAccepted = $false
  nullIdentityAssertionRejected = $false
  timeoutBoundsRequireIntegerToken = $false
  explicitTimeoutZeroIsPreserved = $false
  omittedTimeoutRemainsOmitted = $false
  requestIdsReplayAcrossOperations = $false
  requestIdsNormalizeGuidCaseForReplay = $false
  replayWinsOverCapacity = $false
  uniqueRequestIdCapacityIs4096 = $false
  deadlineStartsBeforeFirstRead = $false
  dripDoesNotResetFrameDeadline = $false
  timeoutContextCannotBeReused = $false
  errorsContainNoRawFrame = $false
  rootAndNestedDictionariesPreserveOriginalFields = $false
}
$script:JsonlOwnFailure = $null
$script:JsonlOwnPhase = 'preflight'
$script:JsonlOwnExitCode = 1
$script:JsonlOwnEvidenceFullPath = $null
$script:JsonlOwnEvidenceCreatedByThisRun = $false
$script:JsonlOwnAdapterFullPath = $null
$script:JsonlOwnPolicyFullPath = Join-Path $PSScriptRoot 'windows-native-process-policy.ps1'
$script:JsonlOwnUtf8NoBom = [System.Text.UTF8Encoding]::new($false, $true)

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'The JSONL own suite requires Windows.' }
  $runnerTemp = [Environment]::GetEnvironmentVariable('RUNNER_TEMP', [EnvironmentVariableTarget]::Process)
  if ([string]::IsNullOrWhiteSpace($runnerTemp) -or -not [IO.Directory]::Exists($runnerTemp)) {
    throw 'RUNNER_TEMP is unavailable.'
  }
  if (-not [IO.File]::Exists($ReaderPath)) { throw 'The reader source file is unavailable.' }
  if (-not [IO.File]::Exists($script:JsonlOwnPolicyFullPath)) { throw 'The policy source file is unavailable.' }
  $script:JsonlOwnAdapterFullPath = [IO.Path]::GetFullPath($ReaderPath)
  $script:JsonlOwnEvidenceFullPath = [IO.Path]::GetFullPath($EvidenceRoot)
  $runnerTempFullPath = [IO.Path]::GetFullPath($runnerTemp)
  $relativeEvidence = [IO.Path]::GetRelativePath($runnerTempFullPath, $script:JsonlOwnEvidenceFullPath)
  $relativeComponents = @($relativeEvidence -split '[\\/]' | Where-Object { -not [string]::IsNullOrEmpty($_) })
  if ($relativeEvidence -eq '.' -or [IO.Path]::IsPathRooted($relativeEvidence) -or
      $relativeComponents.Count -eq 0 -or
      @($relativeComponents | Where-Object { $_ -eq '..' -or $_ -eq '.' }).Count -gt 0) {
    throw 'EvidenceRoot must be a new child of RUNNER_TEMP.'
  }
  $pathProbe = $runnerTempFullPath
  foreach ($component in $relativeComponents) {
    $pathProbe = Join-Path $pathProbe $component
    if ([IO.Directory]::Exists($pathProbe) -or [IO.File]::Exists($pathProbe)) {
      $pathAttributes = [IO.File]::GetAttributes($pathProbe)
      if (($pathAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'EvidenceRoot cannot traverse a reparse point.'
      }
    }
  }
  if ([IO.Directory]::Exists($script:JsonlOwnEvidenceFullPath) -or [IO.File]::Exists($script:JsonlOwnEvidenceFullPath)) {
    throw 'EvidenceRoot already exists.'
  }
  $createdEvidenceDirectory = [IO.Directory]::CreateDirectory($script:JsonlOwnEvidenceFullPath)
  if (-not $createdEvidenceDirectory.Exists -or
      -not [string]::Equals(
        [IO.Path]::GetFullPath($createdEvidenceDirectory.FullName),
        $script:JsonlOwnEvidenceFullPath,
        [StringComparison]::OrdinalIgnoreCase
      )) {
    throw 'EvidenceRoot creation could not be verified.'
  }
  $script:JsonlOwnEvidenceCreatedByThisRun = $true

  $script:JsonlOwnPhase = 'dot-source'
  $capsuleTypeBefore = $null -ne ('Morrow.Pilot.WindowsNativeProcessCapsule' -as [type])
  $jobTypeBefore = $null -ne ('Morrow.Pilot.WindowsNativeJobInterop' -as [type])
  $variablesBeforeDotSource = @((Get-Variable -Scope Script).Name)
  $dotSourceOutput = @(. $script:JsonlOwnAdapterFullPath)
  $variablesAfterDotSource = @((Get-Variable -Scope Script).Name)
  $newVariablesAfterDotSource = @($variablesAfterDotSource | Where-Object {
      $_ -notin $variablesBeforeDotSource -and
      $_ -notin @('variablesBeforeDotSource', 'dotSourceOutput', 'variablesAfterDotSource', 'newVariablesAfterDotSource')
    })
  $script:JsonlOwnChecks.dotSourceDefinesFunctionsWithoutNativeTypes = (
    $dotSourceOutput.Count -eq 0 -and $newVariablesAfterDotSource.Count -eq 0 -and
    (Get-Command New-PilotWindowsNativeProcessJsonlReaderContext -CommandType Function -ErrorAction SilentlyContinue) -and
    (Get-Command Read-PilotWindowsNativeProcessJsonlRequest -CommandType Function -ErrorAction SilentlyContinue) -and
    $capsuleTypeBefore -eq ($null -ne ('Morrow.Pilot.WindowsNativeProcessCapsule' -as [type])) -and
    $jobTypeBefore -eq ($null -ne ('Morrow.Pilot.WindowsNativeJobInterop' -as [type]))
  )
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.dotSourceDefinesFunctionsWithoutNativeTypes `
    -Name 'dotSourceDefinesFunctionsWithoutNativeTypes' -Checks $script:JsonlOwnChecks

  if (-not ('Morrow.Pilot.JsonlTest.ChunkedMemoryStream' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace Morrow.Pilot.JsonlTest
{
  public class ChunkedMemoryStream : MemoryStream
  {
    private readonly int _chunkSize;

    public ChunkedMemoryStream(byte[] bytes, int chunkSize) : base(bytes, false)
    {
      _chunkSize = Math.Max(1, chunkSize);
    }

    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
    {
      cancellationToken.ThrowIfCancellationRequested();
      return base.ReadAsync(buffer, offset, Math.Min(count, _chunkSize), cancellationToken);
    }
  }

  public sealed class DelayedChunkStream : MemoryStream
  {
    private readonly int _chunkSize;
    private readonly int _delayMilliseconds;

    public DelayedChunkStream(byte[] bytes, int chunkSize, int delayMilliseconds) : base(bytes, false)
    {
      _chunkSize = Math.Max(1, chunkSize);
      _delayMilliseconds = Math.Max(0, delayMilliseconds);
    }

    public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
    {
      await Task.Delay(_delayMilliseconds, cancellationToken).ConfigureAwait(false);
      cancellationToken.ThrowIfCancellationRequested();
      return await base.ReadAsync(buffer, offset, Math.Min(count, _chunkSize), cancellationToken).ConfigureAwait(false);
    }
  }
}
'@ -ErrorAction Stop | Out-Null
  }

  $script:JsonlOwnPhase = 'clean-eof-and-basic-frames'
  $emptyReader = New-JsonlOwnMemoryReader -Bytes ([byte[]]@())
  $emptyResult = Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $emptyReader.Context
  $script:JsonlOwnChecks.cleanEofIsDistinct = $null -eq $emptyResult -and $emptyReader.Context.Eof
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.cleanEofIsDistinct -Name 'cleanEofIsDistinct' -Checks $script:JsonlOwnChecks

  $blankLineReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text "`n")
  Assert-JsonlOwnFailure -Action { Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $blankLineReader.Context } `
    -ExpectedErrorId 'Morrow.WindowsNativeProcess.Jsonl.MalformedJson'
  $script:JsonlOwnChecks.blankLfIsRejectedAsMalformedJson = $blankLineReader.Context.Terminated
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.blankLfIsRejectedAsMalformedJson `
    -Name 'blankLfIsRejectedAsMalformedJson' -Checks $script:JsonlOwnChecks

  $idOne = [Guid]::NewGuid().ToString('D')
  $idTwo = [Guid]::NewGuid().ToString('D')
  $lineOne = New-JsonlOwnObserveText -RequestId $idOne
  $lineTwo = New-JsonlOwnObserveText -RequestId $idTwo -CapsuleId 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  $lfReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text ($lineOne + "`n"))
  $lfResult = Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $lfReader.Context
  $script:JsonlOwnChecks.lfFrameAccepted = ($lfResult['operation'] -ceq 'observe' -and $lfResult['requestId'] -ceq $idOne)
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.lfFrameAccepted -Name 'lfFrameAccepted' -Checks $script:JsonlOwnChecks

  $coalesced = ConvertTo-JsonlOwnBytes -Text ($lineOne + "`n" + $lineTwo + "`n")
  $coalescedReader = New-JsonlOwnMemoryReader -Bytes $coalesced
  $firstRequest = Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $coalescedReader.Context
  $secondRequest = Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $coalescedReader.Context
  $thirdRequest = Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $coalescedReader.Context
  $script:JsonlOwnChecks.coalescedFramesArePreserved = (
    $firstRequest['requestId'] -ceq $idOne -and
    $secondRequest['requestId'] -ceq $idTwo -and
    $secondRequest['capsuleId'] -ceq 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' -and
    $null -eq $thirdRequest
  )
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.coalescedFramesArePreserved -Name 'coalescedFramesArePreserved' -Checks $script:JsonlOwnChecks

  $multibyteMarker = 'JSONL-MULTIBYTE-BOUNDARY'
  $multibyteTemplate = New-JsonlOwnStartText `
    -RequestId ([Guid]::NewGuid().ToString('D')) `
    -ArgumentList @($multibyteMarker)
  $multibyteMarkerIndex = $multibyteTemplate.IndexOf($multibyteMarker, [StringComparison]::Ordinal)
  if ($multibyteMarkerIndex -lt 0) { throw 'The multibyte argument marker was not serialized.' }
  $multibytePrefix = $multibyteTemplate.Substring(0, $multibyteMarkerIndex)
  $paddingLength = 4095 - $script:JsonlOwnUtf8NoBom.GetByteCount($multibytePrefix)
  if ($paddingLength -lt 0) { throw 'The multibyte argument prefix exceeds the test read boundary.' }
  $splitMultibyteText = $multibytePrefix + ('a' * $paddingLength) + 'é' +
    $multibyteTemplate.Substring($multibyteMarkerIndex + $multibyteMarker.Length)
  $splitMultibyteBytes = $script:JsonlOwnUtf8NoBom.GetBytes($splitMultibyteText + "`r`n")
  $splitReader = New-JsonlOwnMemoryReader -Bytes $splitMultibyteBytes
  $splitResult = Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $splitReader.Context
  $script:JsonlOwnChecks.crlfAndMultibyteMayCrossReadBoundary = (
    $splitResult['operation'] -ceq 'start' -and
    $splitResult['descriptor']['argumentList'][0].EndsWith('aé', [StringComparison]::Ordinal)
  )
  $crlfBoundaryText = New-JsonlOwnObserveText -RequestId ([Guid]::NewGuid().ToString('D'))
  $crlfBoundaryText += ' ' * (4095 - $script:JsonlOwnUtf8NoBom.GetByteCount($crlfBoundaryText))
  $crlfBoundaryReader = New-JsonlOwnMemoryReader `
    -Bytes (ConvertTo-JsonlOwnBytes -Text ($crlfBoundaryText + "`r`n")) `
    -ChunkSize 4096
  $crlfBoundaryResult = Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $crlfBoundaryReader.Context
  $script:JsonlOwnChecks.crlfAndMultibyteMayCrossReadBoundary = (
    $script:JsonlOwnChecks.crlfAndMultibyteMayCrossReadBoundary -and
    $crlfBoundaryResult['operation'] -ceq 'observe'
  )
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.crlfAndMultibyteMayCrossReadBoundary `
    -Name 'crlfAndMultibyteMayCrossReadBoundary' -Checks $script:JsonlOwnChecks

  $originalIdentity = [ordered]@{ processId = [int]101; creationTimeUtc = '2026-11-21T12:34:56.1234567Z' }
  $identityJson = ConvertTo-Json -InputObject $originalIdentity -Compress
  $identityRequestId = [Guid]::NewGuid().ToString('D')
  $identityRequestText = '{"version":1,"requestId":"' + $identityRequestId + '","operation":"observe","capsuleId":"cccccccc-cccc-cccc-cccc-cccccccccccc","identityAssertion":' + $identityJson + '}' + "`n"
  $identityReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text $identityRequestText)
  $identityRequest = Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $identityReader.Context
  $script:JsonlOwnChecks.preservesOriginalRequestIdAndPayload = (
    $identityRequest['identityAssertion']['processId'] -is [long] -and
    $identityRequest['identityAssertion']['processId'] -eq 101 -and
    $identityRequest['identityAssertion']['creationTimeUtc'] -ceq '2026-11-21T12:34:56.1234567Z' -and
    $identityRequest['requestId'] -ceq $identityRequestId -and
    $identityReader.Context.RequestIds.Contains([Guid]$identityRequestId)
  )
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.preservesOriginalRequestIdAndPayload `
    -Name 'preservesOriginalRequestIdAndPayload' -Checks $script:JsonlOwnChecks

  $script:JsonlOwnPhase = 'frame-limits-and-depth'
  $normalJson = New-JsonlOwnObserveText -RequestId ([Guid]::NewGuid().ToString('D'))
  $contentAtLimit = $normalJson + (' ' * (262144 - $script:JsonlOwnUtf8NoBom.GetByteCount($normalJson)))
  $limitReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text ($contentAtLimit + "`r`n"))
  $limitResult = Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $limitReader.Context
  $script:JsonlOwnChecks.exactContentLimitAndTerminalCrlfAccepted = (
    $limitResult['operation'] -ceq 'observe' -and $limitReader.Context.PendingBytes.Count -eq 0
  )
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.exactContentLimitAndTerminalCrlfAccepted `
    -Name 'exactContentLimitAndTerminalCrlfAccepted' -Checks $script:JsonlOwnChecks

  $overLimitText = $normalJson + (' ' * (262145 - $script:JsonlOwnUtf8NoBom.GetByteCount($normalJson)))
  $overLimitReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text $overLimitText)
  Assert-JsonlOwnFailure -Action { Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $overLimitReader.Context } `
    -ExpectedErrorId 'Morrow.WindowsNativeProcess.Jsonl.FrameTooLarge'
  $script:JsonlOwnChecks.oversizedPartialFrameRejected = $overLimitReader.Context.Terminated
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.oversizedPartialFrameRejected `
    -Name 'oversizedPartialFrameRejected' -Checks $script:JsonlOwnChecks

  $script:JsonlOwnChecks.depthTwelveAccepted = $null -eq (Get-JsonlOwnContainerDepthErrorId -Json ('[' * 12 + '0' + ']' * 12))
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.depthTwelveAccepted -Name 'depthTwelveAccepted' -Checks $script:JsonlOwnChecks
  $script:JsonlOwnChecks.depthThirteenRejected = (
    (Get-JsonlOwnContainerDepthErrorId -Json ('[' * 13 + '0' + ']' * 13)) -ceq 'Morrow.WindowsNativeProcess.Jsonl.DepthExceeded'
  )
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.depthThirteenRejected -Name 'depthThirteenRejected' -Checks $script:JsonlOwnChecks

  $script:JsonlOwnPhase = 'duplicates-and-encoding'
  $duplicateId = [Guid]::NewGuid().ToString('D')
  $duplicateFrames = @(
    ('{"version":1,"requestId":"' + $duplicateId + '","operation":"observe","operation":"stop","capsuleId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}' + "`n"),
    ('{"version":1,"requestId":"' + $duplicateId + '","operation":"observe","Operation":"observe","capsuleId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}' + "`n"),
    ('{"version":1,"requestId":"' + $duplicateId + '","operation":"observe","\u006fperation":"observe","capsuleId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}' + "`n"),
    ('{"version":1,"requestId":"' + $duplicateId + '","operation":"start","descriptor":{"Field":1,"field":2}}' + "`n"),
    ('{"version":1,"requestId":"' + $duplicateId + '","operation":"observe","capsuleId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","extra":[{"Nested":1,"nested":2}]}' + "`n")
  )
  $duplicateCheckNames = @(
    'duplicateExactPropertyRejected',
    'duplicateCaseCollisionRejected',
    'duplicateEscapedPropertyRejected',
    'nestedDuplicateRejectedBeforeSchema',
    'duplicateInsideArrayRejected'
  )
  for ($index = 0; $index -lt $duplicateFrames.Count; $index++) {
    $duplicateReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text $duplicateFrames[$index])
    Assert-JsonlOwnFailure -Action { Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $duplicateReader.Context } `
      -ExpectedErrorId 'Morrow.WindowsNativeProcess.Jsonl.DuplicateProperty'
    $script:JsonlOwnChecks[$duplicateCheckNames[$index]] = $duplicateReader.Context.Terminated
    Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks[$duplicateCheckNames[$index]] `
      -Name $duplicateCheckNames[$index] -Checks $script:JsonlOwnChecks
  }

  $bomBytes = [byte[]]@([byte]239, [byte]187, [byte]191) + (ConvertTo-JsonlOwnBytes -Text ($lineOne + "`n"))
  $bomReader = New-JsonlOwnMemoryReader -Bytes $bomBytes
  Assert-JsonlOwnFailure -Action { Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $bomReader.Context } `
    -ExpectedErrorId 'Morrow.WindowsNativeProcess.Jsonl.BomNotAllowed'
  $script:JsonlOwnChecks.bomRejected = $bomReader.Context.Terminated
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.bomRejected -Name 'bomRejected' -Checks $script:JsonlOwnChecks

  $invalidUtf8Bytes = [byte[]]@([byte]123, [byte]34, [byte]120, [byte]34, [byte]58, [byte]34, [byte]255, [byte]34, [byte]125, [byte]10)
  $invalidUtf8Reader = New-JsonlOwnMemoryReader -Bytes $invalidUtf8Bytes
  Assert-JsonlOwnFailure -Action { Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $invalidUtf8Reader.Context } `
    -ExpectedErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidEncoding'
  $script:JsonlOwnChecks.invalidUtf8Rejected = $invalidUtf8Reader.Context.Terminated
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.invalidUtf8Rejected -Name 'invalidUtf8Rejected' -Checks $script:JsonlOwnChecks

  $rawCrBytes = ConvertTo-JsonlOwnBytes -Text ('{"version":1,' + "`r" + '"requestId":"' + [Guid]::NewGuid().ToString('D') + '","operation":"observe","capsuleId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}' + "`n")
  $rawCrReader = New-JsonlOwnMemoryReader -Bytes $rawCrBytes
  Assert-JsonlOwnFailure -Action { Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $rawCrReader.Context } `
    -ExpectedErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidLineEnding'
  $script:JsonlOwnChecks.rawCarriageReturnRejected = $rawCrReader.Context.Terminated
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.rawCarriageReturnRejected -Name 'rawCarriageReturnRejected' -Checks $script:JsonlOwnChecks

  $partialReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text $lineOne)
  Assert-JsonlOwnFailure -Action { Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $partialReader.Context } `
    -ExpectedErrorId 'Morrow.WindowsNativeProcess.Jsonl.UnexpectedPartialEof'
  $script:JsonlOwnChecks.partialEofRejected = $partialReader.Context.Terminated
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.partialEofRejected -Name 'partialEofRejected' -Checks $script:JsonlOwnChecks

  $malformedReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text ('{"version":1' + "`n"))
  Assert-JsonlOwnFailure -Action { Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $malformedReader.Context } `
    -ExpectedErrorId 'Morrow.WindowsNativeProcess.Jsonl.MalformedJson'
  $script:JsonlOwnChecks.malformedJsonRejected = $malformedReader.Context.Terminated
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.malformedJsonRejected -Name 'malformedJsonRejected' -Checks $script:JsonlOwnChecks

  $script:JsonlOwnPhase = 'schema-and-pure-validation'
  $badRootNames = @(
    ('{"Version":1,"requestId":"' + [Guid]::NewGuid().ToString('D') + '","operation":"observe","capsuleId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}' + "`n"),
    ('{"version":1,"requestId":"' + [Guid]::NewGuid().ToString('D') + '","operation":"observe","capsuleId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","extra":true}' + "`n")
  )
  foreach ($badRootText in $badRootNames) {
    $badRootReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text $badRootText)
    Assert-JsonlOwnFailure -Action { Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $badRootReader.Context } `
      -ExpectedErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidRequest'
  }
  $script:JsonlOwnChecks.rootSchemaIsClosedAndCaseExact = $true
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.rootSchemaIsClosedAndCaseExact -Name 'rootSchemaIsClosedAndCaseExact' -Checks $script:JsonlOwnChecks

  $wrongOperationShape = '{"version":1,"requestId":"' + [Guid]::NewGuid().ToString('D') + '","operation":"observe","capsuleId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","timeoutMs":1}' + "`n"
  $wrongOperationReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text $wrongOperationShape)
  Assert-JsonlOwnFailure -Action { Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $wrongOperationReader.Context } `
    -ExpectedErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidRequest'
  $script:JsonlOwnChecks.operationShapesAreClosed = $wrongOperationReader.Context.Terminated
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.operationShapesAreClosed -Name 'operationShapesAreClosed' -Checks $script:JsonlOwnChecks

  $badVersions = @('1.0', '1e0', 'true', '"1"', '2')
  foreach ($badVersion in $badVersions) {
    $badVersionText = '{"version":' + $badVersion + ',"requestId":"' + [Guid]::NewGuid().ToString('D') + '","operation":"observe","capsuleId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}' + "`n"
    $badVersionReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text $badVersionText)
    Assert-JsonlOwnFailure -Action { Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $badVersionReader.Context } `
      -ExpectedErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidRequest'
  }
  $script:JsonlOwnChecks.versionRequiresIntegerToken = $true
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.versionRequiresIntegerToken -Name 'versionRequiresIntegerToken' -Checks $script:JsonlOwnChecks

  $badIds = @('{00000000-0000-0000-0000-000000000000}', ' 00000000-0000-0000-0000-000000000000', '00000000000000000000000000000000')
  foreach ($badId in $badIds) {
    $badIdText = '{"version":1,"requestId":"' + $badId + '","operation":"observe","capsuleId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}' + "`n"
    $badIdReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text $badIdText)
    Assert-JsonlOwnFailure -Action { Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $badIdReader.Context } `
      -ExpectedErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidRequest'
  }
  $script:JsonlOwnChecks.requestIdRequiresExactGuidD = $true
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.requestIdRequiresExactGuidD -Name 'requestIdRequiresExactGuidD' -Checks $script:JsonlOwnChecks

  $upperCapsuleId = 'ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB'
  $upperRequestId = 'FEDCBAFE-DCBA-FEDC-BAFE-DCBAFEDCBAFE'
  $upperCapsuleText = New-JsonlOwnObserveText -RequestId $upperRequestId -CapsuleId $upperCapsuleId
  $upperCapsuleReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text ($upperCapsuleText + "`n"))
  $upperCapsuleRequest = Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $upperCapsuleReader.Context
  $script:JsonlOwnChecks.capsuleIdIsGuidDAndCanonicalized = (
    $upperCapsuleRequest['capsuleId'] -ceq ([Guid]$upperCapsuleId).ToString('D') -and
    $upperCapsuleRequest['requestId'] -ceq $upperRequestId -and
    $upperCapsuleReader.Context.RequestIds.Contains([Guid]$upperRequestId)
  )
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.capsuleIdIsGuidDAndCanonicalized `
    -Name 'capsuleIdIsGuidDAndCanonicalized' -Checks $script:JsonlOwnChecks

  $badCapsuleIds = @(
    'not-a-guid',
    '{00000000-0000-0000-0000-000000000000}',
    '00000000000000000000000000000000',
    ' 00000000-0000-0000-0000-000000000000',
    ('00000000-0000-0000-0000-00000000000' + ' '),
    '1111111é-1111-1111-1111-111111111111'
  )
  foreach ($badCapsuleId in $badCapsuleIds) {
    $badCapsuleText = New-JsonlOwnObserveText `
      -RequestId ([Guid]::NewGuid().ToString('D')) `
      -CapsuleId $badCapsuleId
    $badCapsuleReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text ($badCapsuleText + "`n"))
    Assert-JsonlOwnFailure -Action { Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $badCapsuleReader.Context } `
      -ExpectedErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidRequest'
  }
  $script:JsonlOwnChecks.capsuleIdRejectsNonGuidValues = $true
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.capsuleIdRejectsNonGuidValues `
    -Name 'capsuleIdRejectsNonGuidValues' -Checks $script:JsonlOwnChecks

  $validStartText = New-JsonlOwnStartText -RequestId ([Guid]::NewGuid().ToString('D'))
  $validStartReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text ($validStartText + "`n"))
  $validStart = Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $validStartReader.Context
  $script:JsonlOwnChecks.descriptorIsValidatedWithoutNativeCalls = (
    $validStart['operation'] -ceq 'start' -and
    $validStart['descriptor'] -is [System.Collections.IDictionary] -and
    $validStart['descriptor']['expectedParentProcessId'] -is [long] -and
    $null -eq ('Morrow.Pilot.WindowsNativeProcessCapsule' -as [type]) -and
    $null -eq ('Morrow.Pilot.WindowsNativeJobInterop' -as [type])
  )
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.descriptorIsValidatedWithoutNativeCalls `
    -Name 'descriptorIsValidatedWithoutNativeCalls' -Checks $script:JsonlOwnChecks

  $badDescriptor = '{"version":1,"requestId":"' + [Guid]::NewGuid().ToString('D') + '","operation":"start","descriptor":{}}' + "`n"
  $badDescriptorReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text $badDescriptor)
  Assert-JsonlOwnFailure -Action { Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $badDescriptorReader.Context } `
    -ExpectedErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidDescriptor'

  $validAssertionText = '{"version":1,"requestId":"' + [Guid]::NewGuid().ToString('D') + '","operation":"observe","capsuleId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","identityAssertion":{"processId":101,"creationTimeUtc":"2026-11-21T12:34:56.1234567Z"}}' + "`n"
  $validAssertionReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text $validAssertionText)
  $validAssertionRequest = Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $validAssertionReader.Context
  $script:JsonlOwnChecks.assertionShapeIsValidatedWithoutRewriting = (
    $validAssertionRequest['identityAssertion']['processId'] -is [long] -and
    $validAssertionRequest['identityAssertion']['creationTimeUtc'] -ceq '2026-11-21T12:34:56.1234567Z'
  )
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.assertionShapeIsValidatedWithoutRewriting `
    -Name 'assertionShapeIsValidatedWithoutRewriting' -Checks $script:JsonlOwnChecks

  $invalidAssertionText = '{"version":1,"requestId":"' + [Guid]::NewGuid().ToString('D') + '","operation":"observe","capsuleId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","identityAssertion":{"processId":1.0}}' + "`n"
  $invalidAssertionReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text $invalidAssertionText)
  Assert-JsonlOwnFailure -Action { Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $invalidAssertionReader.Context } `
    -ExpectedErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidIdentityAssertion'

  $emptyAssertionText = '{"version":1,"requestId":"' + [Guid]::NewGuid().ToString('D') + '","operation":"observe","capsuleId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","identityAssertion":{}}' + "`n"
  $emptyAssertionReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text $emptyAssertionText)
  $emptyAssertionRequest = Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $emptyAssertionReader.Context
  $script:JsonlOwnChecks.emptyIdentityAssertionAccepted = (
    $emptyAssertionRequest.ContainsKey('identityAssertion') -and
    $emptyAssertionRequest['identityAssertion'] -is [System.Collections.IDictionary] -and
    $emptyAssertionRequest['identityAssertion'].Count -eq 0
  )
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.emptyIdentityAssertionAccepted `
    -Name 'emptyIdentityAssertionAccepted' -Checks $script:JsonlOwnChecks

  $nullAssertionText = '{"version":1,"requestId":"' + [Guid]::NewGuid().ToString('D') + '","operation":"observe","capsuleId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","identityAssertion":null}' + "`n"
  $nullAssertionReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text $nullAssertionText)
  Assert-JsonlOwnFailure -Action { Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $nullAssertionReader.Context } `
    -ExpectedErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidIdentityAssertion'
  $script:JsonlOwnChecks.nullIdentityAssertionRejected = $nullAssertionReader.Context.Terminated
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.nullIdentityAssertionRejected `
    -Name 'nullIdentityAssertionRejected' -Checks $script:JsonlOwnChecks

  $script:JsonlOwnPhase = 'timeouts-and-replay'
  foreach ($goodTimeout in @(0, 120000)) {
    $timeoutText = New-JsonlOwnStopText -RequestId ([Guid]::NewGuid().ToString('D')) -TimeoutJson ([string]$goodTimeout)
    $timeoutReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text ($timeoutText + "`n"))
    $timeoutRequest = Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $timeoutReader.Context
    if ($timeoutRequest['timeoutMs'] -isnot [long] -or $timeoutRequest['timeoutMs'] -ne $goodTimeout) {
      throw 'An allowed stop timeout was changed.'
    }
    if ($goodTimeout -eq 0) { $script:JsonlOwnChecks.explicitTimeoutZeroIsPreserved = ($timeoutRequest['timeoutMs'] -eq 0) }
  }
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.explicitTimeoutZeroIsPreserved `
    -Name 'explicitTimeoutZeroIsPreserved' -Checks $script:JsonlOwnChecks

  $omittedTimeoutText = '{"version":1,"requestId":"' + [Guid]::NewGuid().ToString('D') + '","operation":"stop","capsuleId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}' + "`n"
  $omittedTimeoutReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text $omittedTimeoutText)
  $omittedTimeoutRequest = Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $omittedTimeoutReader.Context
  $script:JsonlOwnChecks.omittedTimeoutRemainsOmitted = -not $omittedTimeoutRequest.ContainsKey('timeoutMs')
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.omittedTimeoutRemainsOmitted `
    -Name 'omittedTimeoutRemainsOmitted' -Checks $script:JsonlOwnChecks

  $badTimeouts = @('120001', '-1', '1.0', '1e0', 'true', 'null', '"1"')
  foreach ($badTimeout in $badTimeouts) {
    $badTimeoutText = New-JsonlOwnStopText -RequestId ([Guid]::NewGuid().ToString('D')) -TimeoutJson $badTimeout
    $badTimeoutReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text ($badTimeoutText + "`n"))
    Assert-JsonlOwnFailure -Action { Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $badTimeoutReader.Context } `
      -ExpectedErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidTimeout'
  }
  $script:JsonlOwnChecks.timeoutBoundsRequireIntegerToken = $true
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.timeoutBoundsRequireIntegerToken `
    -Name 'timeoutBoundsRequireIntegerToken' -Checks $script:JsonlOwnChecks

  $firstId = [Guid]::NewGuid().ToString('D')
  $upperId = $firstId.ToUpperInvariant()
  $replayText = (New-JsonlOwnObserveText -RequestId $firstId) + "`n" +
    (New-JsonlOwnStopText -RequestId ([Guid]::NewGuid().ToString('D')) -TimeoutJson '1') + "`n" +
    (New-JsonlOwnStartText -RequestId $upperId) + "`n"
  $replayReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text $replayText)
  $firstReplayRequest = Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $replayReader.Context
  $secondReplayRequest = Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $replayReader.Context
  $script:JsonlOwnChecks.requestIdsReplayAcrossOperations = (
    $firstReplayRequest['operation'] -ceq 'observe' -and
    $secondReplayRequest['operation'] -ceq 'stop'
  )
  Assert-JsonlOwnFailure -Action { Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $replayReader.Context } `
    -ExpectedErrorId 'Morrow.WindowsNativeProcess.Jsonl.DuplicateRequestId'
  Assert-JsonlOwnCheck -Condition ($script:JsonlOwnChecks.requestIdsReplayAcrossOperations -and $replayReader.Context.Terminated) `
    -Name 'requestIdsReplayAcrossOperations' -Checks $script:JsonlOwnChecks

  $caseReplayId = [Guid]::NewGuid().ToString('D').ToUpperInvariant()
  $caseReplayText = (New-JsonlOwnObserveText -RequestId $caseReplayId) + "`n" +
    (New-JsonlOwnStopText -RequestId $caseReplayId.ToLowerInvariant() -TimeoutJson '0') + "`n"
  $caseReplayReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text $caseReplayText)
  $caseReplayFirstRequest = Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $caseReplayReader.Context
  if ($caseReplayFirstRequest['requestId'] -cne $caseReplayId) { throw 'The original request ID spelling changed.' }
  Assert-JsonlOwnFailure -Action { Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $caseReplayReader.Context } `
    -ExpectedErrorId 'Morrow.WindowsNativeProcess.Jsonl.DuplicateRequestId'
  $script:JsonlOwnChecks.requestIdsNormalizeGuidCaseForReplay = $caseReplayReader.Context.Terminated
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.requestIdsNormalizeGuidCaseForReplay `
    -Name 'requestIdsNormalizeGuidCaseForReplay' -Checks $script:JsonlOwnChecks

  $script:JsonlOwnPhase = 'request-id-capacity'
  $capacityIds = [System.Collections.Generic.List[string]]::new()
  $capacityLines = [System.Text.StringBuilder]::new()
  for ($index = 0; $index -lt 4097; $index++) {
    $capacityId = [Guid]::NewGuid().ToString('D')
    $capacityIds.Add($capacityId)
    [void]$capacityLines.Append((New-JsonlOwnObserveText -RequestId $capacityId)).Append("`n")
  }
  $capacityReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text $capacityLines.ToString())
  for ($index = 0; $index -lt 4096; $index++) {
    $accepted = Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $capacityReader.Context
    if ($accepted['requestId'] -cne $capacityIds[$index]) { throw 'The request order changed.' }
  }
  Assert-JsonlOwnFailure -Action { Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $capacityReader.Context } `
    -ExpectedErrorId 'Morrow.WindowsNativeProcess.Jsonl.RequestIdCapacityExceeded'
  $script:JsonlOwnChecks.uniqueRequestIdCapacityIs4096 = (
    $capacityReader.Context.RequestIds.Count -eq 4096 -and $capacityReader.Context.Terminated
  )
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.uniqueRequestIdCapacityIs4096 `
    -Name 'uniqueRequestIdCapacityIs4096' -Checks $script:JsonlOwnChecks

  $replayAtCapacityLines = [System.Text.StringBuilder]::new()
  $replayAtCapacityIds = [System.Collections.Generic.List[string]]::new()
  for ($index = 0; $index -lt 4096; $index++) {
    $capacityId = [Guid]::NewGuid().ToString('D')
    $replayAtCapacityIds.Add($capacityId)
    [void]$replayAtCapacityLines.Append((New-JsonlOwnObserveText -RequestId $capacityId)).Append("`n")
  }
  [void]$replayAtCapacityLines.Append((New-JsonlOwnStopText -RequestId $replayAtCapacityIds[0] -TimeoutJson '0')).Append("`n")
  $replayAtCapacityReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text $replayAtCapacityLines.ToString())
  for ($index = 0; $index -lt 4096; $index++) {
    $null = Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $replayAtCapacityReader.Context
  }
  Assert-JsonlOwnFailure -Action { Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $replayAtCapacityReader.Context } `
    -ExpectedErrorId 'Morrow.WindowsNativeProcess.Jsonl.DuplicateRequestId'
  $script:JsonlOwnChecks.replayWinsOverCapacity = $replayAtCapacityReader.Context.Terminated
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.replayWinsOverCapacity -Name 'replayWinsOverCapacity' -Checks $script:JsonlOwnChecks

  $script:JsonlOwnPhase = 'monotonic-deadline'
  $deadlineBytes = ConvertTo-JsonlOwnBytes -Text ($lineOne + "`n")
  $firstReadDelayStream = [Morrow.Pilot.JsonlTest.DelayedChunkStream]::new($deadlineBytes, 16, 250)
  $firstReadDelayContext = New-PilotWindowsNativeProcessJsonlReaderContext `
    -Stream $firstReadDelayStream `
    -FrameTimeoutMilliseconds 75
  Assert-JsonlOwnFailure -Action { Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $firstReadDelayContext } `
    -ExpectedErrorId 'Morrow.WindowsNativeProcess.Jsonl.DeadlineExceeded'
  $script:JsonlOwnChecks.deadlineStartsBeforeFirstRead = $firstReadDelayContext.Terminated
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.deadlineStartsBeforeFirstRead -Name 'deadlineStartsBeforeFirstRead' -Checks $script:JsonlOwnChecks

  $dripStream = [Morrow.Pilot.JsonlTest.DelayedChunkStream]::new($deadlineBytes, 16, 35)
  $dripContext = New-PilotWindowsNativeProcessJsonlReaderContext -Stream $dripStream -FrameTimeoutMilliseconds 75
  Assert-JsonlOwnFailure -Action { Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $dripContext } `
    -ExpectedErrorId 'Morrow.WindowsNativeProcess.Jsonl.DeadlineExceeded'
  $script:JsonlOwnChecks.dripDoesNotResetFrameDeadline = $dripContext.Terminated
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.dripDoesNotResetFrameDeadline -Name 'dripDoesNotResetFrameDeadline' -Checks $script:JsonlOwnChecks
  Assert-JsonlOwnFailure -Action { Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $dripContext } `
    -ExpectedErrorId 'Morrow.WindowsNativeProcess.Jsonl.ReaderTerminated'
  $script:JsonlOwnChecks.timeoutContextCannotBeReused = $dripContext.Terminated
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.timeoutContextCannotBeReused -Name 'timeoutContextCannotBeReused' -Checks $script:JsonlOwnChecks

  $sensitiveMarker = 'capsule-private-sensitive-value'
  $sensitiveText = '{"version":1,"requestId":"' + [Guid]::NewGuid().ToString('D') + '","operation":"observe","capsuleId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","extra":"' + $sensitiveMarker + '"}' + "`n"
  $sensitiveReader = New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text $sensitiveText)
  Assert-JsonlOwnFailure -Action { Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $sensitiveReader.Context } `
    -ExpectedErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidRequest'
  $sensitiveError = $null
  try { $null = Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext (New-JsonlOwnMemoryReader -Bytes (ConvertTo-JsonlOwnBytes -Text $sensitiveText)).Context } catch { $sensitiveError = $_.Exception }
  $script:JsonlOwnChecks.errorsContainNoRawFrame = (
    $null -ne $sensitiveError -and
    $sensitiveError.Message -cnotlike ('*' + $sensitiveMarker + '*') -and
    (Get-JsonlOwnErrorId -Exception $sensitiveError) -ceq 'Morrow.WindowsNativeProcess.Jsonl.InvalidRequest'
  )
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.errorsContainNoRawFrame -Name 'errorsContainNoRawFrame' -Checks $script:JsonlOwnChecks

  $script:JsonlOwnChecks.rootAndNestedDictionariesPreserveOriginalFields = (
    $validStart['descriptor'].ContainsKey('executableSha256') -and
    $validStart['descriptor']['executableSha256'] -ceq ('A' * 64) -and
    $validStart['descriptor']['environment'].ContainsKey('SYSTEMROOT') -and
    $validStart['descriptor']['environment']['SYSTEMROOT'] -ceq 'C:\Windows'
  )
  Assert-JsonlOwnCheck -Condition $script:JsonlOwnChecks.rootAndNestedDictionariesPreserveOriginalFields `
    -Name 'rootAndNestedDictionariesPreserveOriginalFields' -Checks $script:JsonlOwnChecks

  if (@($script:JsonlOwnChecks.Values | Where-Object { -not $_ }).Count -ne 0) {
    throw 'An acceptance check did not complete.'
  }
  $script:JsonlOwnExitCode = 0
} catch {
  $exception = $_.Exception
  $errorId = Get-JsonlOwnErrorId -Exception $exception
  $script:JsonlOwnFailure = [ordered]@{
    phase = $script:JsonlOwnPhase
    errorId = if ([string]::IsNullOrWhiteSpace($errorId)) { 'Morrow.WindowsNativeProcess.Jsonl.OwnTestFailed' } else { $errorId }
  }
  $script:JsonlOwnExitCode = 1
} finally {
  if ($script:JsonlOwnEvidenceCreatedByThisRun -and
      $null -ne $script:JsonlOwnEvidenceFullPath -and
      [IO.Directory]::Exists($script:JsonlOwnEvidenceFullPath) -and
      (([IO.File]::GetAttributes($script:JsonlOwnEvidenceFullPath) -band [IO.FileAttributes]::ReparsePoint) -eq 0)) {
    $receipt = [ordered]@{
      schemaVersion = 1
      issue = 246
      suite = 'own'
      runId = $script:JsonlOwnRunId
      status = if ($script:JsonlOwnExitCode -eq 0) { 'passed' } else { 'failed' }
      exitCode = $script:JsonlOwnExitCode
      adapterPath = if ($null -ne $script:JsonlOwnAdapterFullPath) { $script:JsonlOwnAdapterFullPath } else { $null }
      adapterSha256 = if ($null -ne $script:JsonlOwnAdapterFullPath -and [IO.File]::Exists($script:JsonlOwnAdapterFullPath)) {
        (Get-FileHash -LiteralPath $script:JsonlOwnAdapterFullPath -Algorithm SHA256).Hash.ToLowerInvariant()
      } else { $null }
      checks = $script:JsonlOwnChecks
      passedChecks = @($script:JsonlOwnChecks.Values | Where-Object { $_ }).Count
      totalChecks = $script:JsonlOwnChecks.Count
      noProductOrDriverActions = $true
      failure = $script:JsonlOwnFailure
    }
    $receiptPath = Join-Path $script:JsonlOwnEvidenceFullPath 'own-receipt.json'
    [IO.File]::WriteAllText(
      $receiptPath,
      ($receipt | ConvertTo-Json -Depth 12),
      [System.Text.UTF8Encoding]::new($false)
    )
  }
}

if ($script:JsonlOwnExitCode -eq 0) {
  Write-Output ('JSONL own suite: {0}/{0} acceptance checks passed.' -f $script:JsonlOwnChecks.Count)
} else {
  Write-Output ('JSONL own suite failed during {0} ({1}).' -f $script:JsonlOwnFailure.phase, $script:JsonlOwnFailure.errorId)
}
exit $script:JsonlOwnExitCode
