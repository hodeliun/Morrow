[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string] $EvidenceRoot,
  [switch] $SyntheticOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:StartedUtc = [DateTime]::UtcNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
$script:RunId = [Guid]::NewGuid().ToString('N')
$script:Checks = [ordered]@{
  dotSourceDefinesControllerWithoutNativeSideEffects = $false
  retainedObserverSafeHandleCompiles = $false
  evidenceReservationRejectsUntrustedPaths = $false
  sequentialStartObserveStopIsCorrelated = $false
  wrongCapsuleAndSecondStartAreRecoverable = $false
  assertionMismatchPreservesCapsule = $false
  startFailureCanRetryOnlyAfterVerifiedCleanup = $false
  startObservationFailureIsTerminalAfterCleanup = $false
  duplicateRequestIdCleansOwnCapsule = $false
  fatalReaderErrorUsesNullRequestIdAndVerifiedCleanup = $false
  fatalReaderErrorDoesNotClaimUnconfirmedCleanup = $false
  partialFrameDeadlineCleansOwnCapsule = $false
  cleanEofRequiresVerifiedCleanupAndHasNoReply = $false
  unconfirmedEofIsNonzeroWithoutSyntheticReply = $false
  stopTimeoutSurvivesDisposeOutcome = $false
  responseLimitRejectsBeforeWriting = $false
  oversizedResponseCleansOwnCapsuleAndUsesSmallFallback = $false
  oversizedInventoryIsMarkedPartialAndBounded = $false
  unavailableInventoryStatusIsPreserved = $false
  externalStartIdentityMismatchAllowsRetry = $false
  externalStartObserveStopOwnsOnlySyntheticProcesses = $false
  externalDeadlineCleansOwnCapsule = $false
  externalAbruptExitCleansOwnJobAndPreservesOutsider = $false
  redirectedProcessStreamsUseStrictUtf8WithoutBom = $false
  stderrDrainTaskIsAsyncBoundedAndIdempotent = $false
  stderrDrainContinuesPastPrefixLimit = $false
  externalStderrDrainsAreRecoveredOnce = $false
  threeRedirectedPipesAreRequired = $false
}
$script:Failures = [Collections.Generic.List[string]]::new()
$script:TrackedProcesses = [Collections.Generic.List[Diagnostics.Process]]::new()
$script:HeldProcessHandles = [Collections.Generic.List[object]]::new()
$script:ExternalPaths = [Collections.Generic.List[string]]::new()
$script:Utf8 = [Text.UTF8Encoding]::new($false, $true)
$script:StderrPrefixLimit = 65536
$script:ControllerPath = Join-Path $PSScriptRoot 'windows-native-process.controller.ps1'
$script:ReaderPath = Join-Path $PSScriptRoot 'windows-native-process.ps1'
$script:PolicyPath = Join-Path $PSScriptRoot 'windows-native-process-policy.ps1'
$script:ProcessHelperPath = Join-Path $PSScriptRoot 'windows-process.ps1'
$script:JobHelperPath = Join-Path $PSScriptRoot 'windows-native-job.ps1'
$script:EvidenceFullPath = $null
$script:EvidenceWriteReady = $false
$script:EvidenceReceiptStream = $null
$script:RunnerTemp = $null
$script:PrivateRoot = $null
$script:RuntimeRoot = $null
$script:ProfilePath = $null
$script:PwshPath = $null
$script:PwshHash = $null
$script:WindowsDirectory = $null
$script:System32 = $null
$script:OwnerSid = $null
$script:EnvironmentMap = $null
$script:WorkerPath = $null
$script:ControllerHostPath = $null

function Assert-ControllerOwnCheck {
  param([Parameter(Mandatory)][bool] $Condition, [Parameter(Mandatory)][string] $Name)
  if (-not $Condition) { throw "Acceptance check failed: $Name" }
  $script:Checks[$Name] = $true
}

function Get-ControllerOwnErrorId {
  param([Parameter(Mandatory)][Exception] $Exception)
  $current = $Exception
  for ($depth = 0; $null -ne $current -and $depth -lt 8; $depth++) {
    foreach ($key in @('Morrow.WindowsNativeProcess.Jsonl.ErrorId', 'Morrow.WindowsNativeProcess.ErrorId')) {
      if ($current.Data.Contains($key)) { return [string]$current.Data[$key] }
    }
    $current = $current.InnerException
  }
  return $null
}

function New-ControllerOwnNativeFailure {
  param([Parameter(Mandatory)][string] $ErrorId, [string] $Stage = 'test-native', [string[]] $Fields = @())
  $exception = [InvalidOperationException]::new('synthetic controller failure; raw sentinel secret 2d394e7b must never be serialized')
  $exception.Data['Morrow.WindowsNativeProcess.ErrorId'] = $ErrorId
  $exception.Data['Morrow.WindowsNativeProcess.Diagnostics'] = [ordered]@{
    stage = $Stage
    cause = $ErrorId
    fields = @($Fields)
  }
  return $exception
}

function New-ControllerOwnObservation {
  param([switch] $Oversized, [int] $MemberCount = 1)
  $identityPath = if ($Oversized) { 'C:\' + ('x' * 1100000) } else { 'C:\Pilot\pwsh.exe' }
  $members = [Collections.Generic.List[object]]::new()
  for ($index = 0; $index -lt $MemberCount; $index++) {
    $processIdValue = 4112 + $index
    [void]$members.Add([pscustomobject][ordered]@{
      processId = $processIdValue
      state = 'observed'
      metadata = [pscustomobject][ordered]@{
        processId = $processIdValue
        parentProcessId = 3096
        name = 'pwsh.exe'
        creationTimeUtc = '2026-11-21T12:00:00.0000000Z'
      }
    })
  }
  return [pscustomobject][ordered]@{
    root = [pscustomobject][ordered]@{
      state = 'alive'
      identityStatus = 'fresh'
      identityFresh = $true
      identity = [pscustomobject][ordered]@{
        processId = 4112
        parentProcessId = 3096
        executablePath = $identityPath
        executableSha256 = ('a' * 64)
        creationTimeUtc = '2026-11-21T12:00:00.0000000Z'
        ownerSid = 'S-1-5-18'
      }
      exitCode = $null
    }
    inventory = [pscustomobject][ordered]@{
      status = 'available'
      isEmpty = $false
      memberCountBefore = $MemberCount
      memberCountAfter = $MemberCount
      members = $members.ToArray()
    }
  }
}

function New-ControllerOwnOperations {
  $state = [ordered]@{
    starts = 0
    observes = 0
    stops = 0
    disposes = 0
    lastCapsule = $null
    disposeFails = $false
    stopTimesOut = $false
    oversizedObservation = $false
    memberCount = 1
    mismatchOwnerSid = $null
    startMismatchOnce = $false
  }
  $operations = [ordered]@{
    Start = {
      param($descriptor)
      $state.starts++
      if ($state.startMismatchOnce) {
        $state.startMismatchOnce = $false
        $exception = New-ControllerOwnNativeFailure -ErrorId 'Morrow.WindowsNativeProcess.IdentityMismatch' `
          -Stage 'identity-comparison' -Fields @('parentProcessId')
        $exception.Data.Remove('Morrow.WindowsNativeProcess.ErrorId')
        $exception.Data['Morrow.WindowsNativeProcess.Diagnostics']['cleanup'] = [ordered]@{
          attempted = $true; jobEmpty = $true; rootExited = $true; disposeFailed = $false
        }
        throw $exception
      }
      $state.lastCapsule = [pscustomobject]@{ token = [Guid]::NewGuid().ToString('N') }
      return ,$state.lastCapsule
    }.GetNewClosure()
    Observe = {
      param($capsule, $identityAssertion)
      $state.observes++
      if ($null -ne $identityAssertion -and $identityAssertion.ContainsKey('ownerSid') -and
          [string]$identityAssertion['ownerSid'] -ne 'S-1-5-18') {
        throw (New-ControllerOwnNativeFailure -ErrorId 'Morrow.WindowsNativeProcess.IdentityMismatch' -Stage 'identity-assertion-comparison' -Fields @('ownerSid'))
      }
      if ($state.mismatchOwnerSid) {
        throw (New-ControllerOwnNativeFailure -ErrorId 'Morrow.WindowsNativeProcess.IdentityMismatch' -Stage 'identity-assertion-comparison' -Fields @('ownerSid'))
      }
      return (New-ControllerOwnObservation -Oversized:$state.oversizedObservation -MemberCount $state.memberCount)
    }.GetNewClosure()
    Stop = {
      param($capsule, $identityAssertion, $timeoutMilliseconds, $timeoutWasSpecified)
      $state.stops++
      if ($null -ne $identityAssertion -and $identityAssertion.ContainsKey('ownerSid') -and
          [string]$identityAssertion['ownerSid'] -ne 'S-1-5-18') {
        throw (New-ControllerOwnNativeFailure -ErrorId 'Morrow.WindowsNativeProcess.IdentityMismatch' -Stage 'identity-assertion-comparison' -Fields @('ownerSid'))
      }
      if ($state.stopTimesOut) {
        return [pscustomobject][ordered]@{
          completed = $false; timedOut = $true; jobEmpty = $false; rootExited = $false; exitCode = $null
        }
      }
      return [pscustomobject][ordered]@{
        completed = $true; timedOut = $false; jobEmpty = $true; rootExited = $true; exitCode = [uint32]0
      }
    }.GetNewClosure()
    Dispose = {
      param($capsule)
      $state.disposes++
      if ($state.disposeFails) {
        $exception = New-ControllerOwnNativeFailure -ErrorId 'Morrow.WindowsNativeProcess.CleanupIncomplete' -Stage 'cleanup'
        $exception.Data['Morrow.WindowsNativeProcess.Diagnostics']['cleanup'] = [ordered]@{
          jobEmpty = $false; rootExited = $false; disposeFailed = $true
        }
        throw $exception
      }
      return [pscustomobject][ordered]@{ jobEmpty = $true; rootExited = $true; exitCode = [uint32]0 }
    }.GetNewClosure()
  }
  return [pscustomobject]@{ State = $state; Operations = $operations }
}

function New-ControllerOwnDescriptor {
  return [ordered]@{
    executablePath = 'C:\Pilot\pwsh.exe'
    executableSha256 = ('a' * 64)
    argumentList = @()
    workingDirectory = 'C:\Pilot'
    profilePath = 'C:\Pilot\Profile'
    environment = [ordered]@{
      SYSTEMROOT = 'C:\Windows'; WINDIR = 'C:\Windows'; PATH = 'C:\Windows\System32'
      USERPROFILE = 'C:\Pilot\Profile'; APPDATA = 'C:\Pilot\Profile\AppData'
      LOCALAPPDATA = 'C:\Pilot\Profile\LocalAppData'; TEMP = 'C:\Pilot\Profile\Temp'
      TMP = 'C:\Pilot\Profile\Temp'
    }
    expectedParentProcessId = 1
    expectedOwnerSid = 'S-1-5-18'
  }
}

function New-ControllerOwnFrame {
  param(
    [Parameter(Mandatory)][string] $Operation,
    [Parameter(Mandatory)][string] $RequestId,
    [string] $CapsuleId,
    [switch] $WrongAssertion,
    [switch] $TimeoutZero
  )
  $request = [ordered]@{ version = 1; requestId = $RequestId; operation = $Operation }
  switch ($Operation) {
    'start' { $request.descriptor = New-ControllerOwnDescriptor }
    'observe' {
      $request.capsuleId = $CapsuleId
      if ($WrongAssertion) { $request.identityAssertion = [ordered]@{ ownerSid = 'S-1-5-32-544' } }
    }
    'stop' {
      $request.capsuleId = $CapsuleId
      if ($WrongAssertion) { $request.identityAssertion = [ordered]@{ ownerSid = 'S-1-5-32-544' } }
      if ($TimeoutZero) { $request.timeoutMs = 0 }
    }
    default { throw 'Unknown test operation.' }
  }
  return (ConvertTo-Json -InputObject $request -Depth 10 -Compress)
}

function Invoke-ControllerOwnMemoryRun {
  param(
    [Parameter(Mandatory)][AllowEmptyString()][string] $InputText,
    [Parameter(Mandatory)][System.Collections.IDictionary] $Operations,
    [Parameter(Mandatory)][scriptblock] $CapsuleIdFactory,
    [System.IO.Stream] $InputStreamOverride,
    [int] $FrameTimeoutMilliseconds = 120000
  )
  $inputBytes = $script:Utf8.GetBytes($InputText)
  $ownsInputStream = $null -eq $InputStreamOverride
  $inputStream = if ($ownsInputStream) { [IO.MemoryStream]::new($inputBytes, $false) } else { $InputStreamOverride }
  $outputStream = [IO.MemoryStream]::new()
  $diagnosticStream = [IO.MemoryStream]::new()
  try {
    $exitCode = Invoke-PilotWindowsNativeProcessJsonlController `
      -InputStream $inputStream `
      -OutputStream $outputStream `
      -DiagnosticStream $diagnosticStream `
      -FrameTimeoutMilliseconds $FrameTimeoutMilliseconds `
      -TestOperations $Operations `
      -TestCapsuleIdFactory $CapsuleIdFactory
    return [pscustomobject]@{
      ExitCode = [int]$exitCode
      Stdout = $script:Utf8.GetString($outputStream.ToArray())
      Stderr = $script:Utf8.GetString($diagnosticStream.ToArray())
    }
  } finally {
    if ($ownsInputStream) { $inputStream.Dispose() }
    $outputStream.Dispose()
    $diagnosticStream.Dispose()
  }
}

function New-ControllerOwnCapsuleIdFactory {
  param([Parameter(Mandatory)][string[]] $Ids)
  $factoryState = @{ Index = 0; Ids = @($Ids) }
  return {
    if ($factoryState.Index -ge $factoryState.Ids.Count) { throw 'Test capsule ID factory exhausted.' }
    $id = $factoryState.Ids[$factoryState.Index]
    $factoryState.Index++
    return $id
  }.GetNewClosure()
}

function Add-ControllerOwnTimeoutStreamType {
  if ('Morrow.Pilot.ControllerOwn.PartialThenBlockStream' -as [type]) { return }
  $source = @'
using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
namespace Morrow.Pilot.ControllerOwn
{
  public sealed class PartialThenBlockStream : Stream
  {
    private readonly byte[] _bytes;
    private int _position;
    private bool _disposed;
    public PartialThenBlockStream(byte[] bytes) { _bytes = bytes ?? Array.Empty<byte>(); }
    public override bool CanRead => !_disposed;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => _bytes.Length;
    public override long Position { get => _position; set => throw new NotSupportedException(); }
    public override void Flush() { }
    public override int Read(byte[] buffer, int offset, int count) => Copy(buffer, offset, count);
    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken token)
    {
      if (_position < _bytes.Length) return Task.FromResult(Copy(buffer, offset, count));
      return Task.Delay(Timeout.Infinite, token).ContinueWith(
        task => { task.GetAwaiter().GetResult(); return 0; }, CancellationToken.None,
        TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
    }
    private int Copy(byte[] buffer, int offset, int count)
    {
      int copied = Math.Min(count, _bytes.Length - _position);
      if (copied > 0) { Buffer.BlockCopy(_bytes, _position, buffer, offset, copied); _position += copied; }
      return copied;
    }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    protected override void Dispose(bool disposing) { _disposed = true; base.Dispose(disposing); }
  }
}
'@
  Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
}

function ConvertFrom-ControllerOwnResponses {
  param([Parameter(Mandatory)][AllowEmptyString()][string] $Text)
  if ([string]::IsNullOrEmpty($Text)) { return }
  $lines = @($Text -split "`n" | Where-Object { $_.Length -gt 0 })
  foreach ($line in $lines) {
    if ($line.EndsWith("`r")) { throw 'Controller emitted CRLF instead of the required LF protocol line.' }
  }
  $responses = @($lines | ForEach-Object { ConvertFrom-Json -InputObject $_ -AsHashtable -Depth 16 -DateKind String })
  foreach ($response in $responses) { Assert-ControllerOwnWireShape -Response $response }
  return $responses
}

function Test-ControllerOwnExactKeys {
  param([Parameter(Mandatory)][System.Collections.IDictionary] $Map, [Parameter(Mandatory)][string[]] $Expected)
  $actual = @($Map.Keys | ForEach-Object { [string]$_ } | Sort-Object)
  $expected = @($Expected | Sort-Object)
  return ($actual.Count -eq $expected.Count -and -not (Compare-Object -ReferenceObject $expected -DifferenceObject $actual))
}

function New-ControllerOwnEvidenceReservation {
  param(
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string] $RunnerTempPath,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string] $EvidenceRootPath
  )
  if (-not [IO.Directory]::Exists($RunnerTempPath)) { throw 'RUNNER_TEMP is unavailable.' }
  $runnerTempFullPath = [IO.Path]::GetFullPath($RunnerTempPath)
  $evidenceCandidate = [IO.Path]::GetFullPath($EvidenceRootPath)
  $directorySeparator = [string][IO.Path]::DirectorySeparatorChar
  $runnerTempPrefix = $runnerTempFullPath.TrimEnd([char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)) + $directorySeparator
  if (-not $evidenceCandidate.StartsWith($runnerTempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'EvidenceRoot must be a new child of RUNNER_TEMP.'
  }
  if ([IO.Directory]::Exists($evidenceCandidate) -or [IO.File]::Exists($evidenceCandidate)) {
    throw 'EvidenceRoot must be a new dedicated directory.'
  }
  $createdDirectory = [IO.Directory]::CreateDirectory($evidenceCandidate)
  if (-not $createdDirectory.Exists -or @([IO.Directory]::EnumerateFileSystemEntries($evidenceCandidate)).Count -ne 0) {
    throw 'EvidenceRoot was not created as a fresh dedicated directory.'
  }
  $receiptPath = Join-Path $evidenceCandidate 'controller-own.json'
  $receiptStream = [IO.FileStream]::new(
    $receiptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read
  )
  return [pscustomobject]@{ FullPath = $evidenceCandidate; ReceiptPath = $receiptPath; ReceiptStream = $receiptStream }
}

function Assert-ControllerOwnWireShape {
  param([Parameter(Mandatory)][System.Collections.IDictionary] $Response)
  if ($Response['ok'] -isnot [bool]) { throw 'Controller envelope ok is not boolean.' }
  $expectedTopLevel = if ($Response['ok']) { @('version', 'requestId', 'ok', 'result', 'cleanup') } else { @('version', 'requestId', 'ok', 'error', 'cleanup') }
  if (-not (Test-ControllerOwnExactKeys -Map $Response -Expected $expectedTopLevel)) { throw 'Controller envelope has unexpected fields.' }
  if ($Response['version'] -ne 1) { throw 'Controller envelope has an invalid version.' }
  $cleanup = $Response['cleanup']
  if ($cleanup -isnot [System.Collections.IDictionary] -or
      -not (Test-ControllerOwnExactKeys -Map $cleanup -Expected @('state', 'jobEmpty', 'rootExited', 'disposeFailed'))) {
    throw 'Controller cleanup envelope has unexpected fields.'
  }
  foreach ($name in @('jobEmpty', 'rootExited', 'disposeFailed')) {
    if ($null -ne $cleanup[$name] -and $cleanup[$name] -isnot [bool]) { throw 'Controller cleanup signal is not boolean or null.' }
  }
  if ($cleanup['state'] -ceq 'not-required' -and
      ($null -ne $cleanup['jobEmpty'] -or $null -ne $cleanup['rootExited'] -or $null -ne $cleanup['disposeFailed'])) {
    throw 'Controller not-required cleanup signals must be null.'
  }
  if ($cleanup['state'] -ceq 'confirmed' -and
      ($cleanup['jobEmpty'] -ne $true -or $cleanup['rootExited'] -ne $true -or $cleanup['disposeFailed'] -ne $false)) {
    throw 'Controller confirmed cleanup is missing explicit proof.'
  }
  if ($Response['ok']) {
    $result = $Response['result']
    if ($result -isnot [System.Collections.IDictionary]) { throw 'Controller success result is not an object.' }
    if ($result.Contains('root')) {
      if (-not (Test-ControllerOwnExactKeys -Map $result -Expected @('capsuleId', 'root', 'inventory'))) { throw 'Start or Observe result shape changed.' }
      if ($result['root'] -isnot [System.Collections.IDictionary] -or
          -not (Test-ControllerOwnExactKeys -Map $result['root'] -Expected @('state', 'identityStatus', 'identityFresh', 'identity', 'exitCode'))) {
        throw 'Controller root evidence shape changed.'
      }
      if ($result['inventory'] -isnot [System.Collections.IDictionary] -or
          -not (Test-ControllerOwnExactKeys -Map $result['inventory'] -Expected @('status', 'isEmpty', 'memberCountBefore', 'memberCountAfter', 'members')) -or
          $result['inventory']['members'] -isnot [Array]) {
        throw 'Controller inventory evidence shape changed.'
      }
    } else {
      if (-not (Test-ControllerOwnExactKeys -Map $result -Expected @('capsuleId', 'completed', 'timedOut', 'jobEmpty', 'rootExited', 'exitCode'))) {
        throw 'Stop result shape changed.'
      }
    }
  } else {
    if ($Response['error'] -isnot [System.Collections.IDictionary] -or
        -not (Test-ControllerOwnExactKeys -Map $Response['error'] -Expected @('code', 'stage', 'fields')) -or
        $Response['error']['fields'] -isnot [Array]) {
      throw 'Controller error shape changed.'
    }
  }
}

function Assert-ControllerOwnResponse {
  param(
    [Parameter(Mandatory)][System.Collections.IDictionary] $Response,
    [AllowNull()][object] $RequestId,
    [Parameter(Mandatory)][bool] $ExpectedOk
  )
  $requestIdMatches = if ($null -eq $RequestId) {
    $null -eq $Response['requestId']
  } else {
    $Response['requestId'] -is [string] -and $Response['requestId'] -ceq [string]$RequestId
  }
  if ($Response['version'] -ne 1 -or -not $requestIdMatches -or
      $Response['ok'] -isnot [bool] -or [bool]$Response['ok'] -ne $ExpectedOk -or
      $Response['cleanup'] -isnot [System.Collections.IDictionary] -or
      $Response['cleanup']['state'] -notin @('not-required', 'confirmed', 'unconfirmed')) {
    throw 'Controller response envelope did not match the closed contract.'
  }
  if ($ExpectedOk) {
    if (-not $Response.Contains('result') -or $Response.Contains('error')) { throw 'Controller success envelope is malformed.' }
  } else {
    if ($Response['error'] -isnot [System.Collections.IDictionary] -or $Response.Contains('result')) {
      throw 'Controller error envelope is malformed.'
    }
    if ($Response['error']['fields'] -isnot [Array]) { throw 'Controller error fields are not a typed array.' }
  }
}

function Wait-ControllerOwnFile {
  param([Parameter(Mandatory)][string] $Path, [int] $TimeoutMilliseconds = 15000)
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ([IO.File]::Exists($Path)) { return $true }
    Start-Sleep -Milliseconds 50
  }
  return [IO.File]::Exists($Path)
}

function New-ControllerOwnProcessInfo {
  param(
    [Parameter(Mandatory)][string] $ExecutablePath,
    [Parameter(Mandatory)][string[]] $Arguments,
    [Parameter(Mandatory)][bool] $RedirectStandardInput,
    [Parameter(Mandatory)][bool] $RedirectStandardOutput,
    [Parameter(Mandatory)][bool] $RedirectStandardError
  )
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $ExecutablePath
  $info.WorkingDirectory = $script:RuntimeRoot
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $RedirectStandardInput
  $info.RedirectStandardOutput = $RedirectStandardOutput
  $info.RedirectStandardError = $RedirectStandardError
  if ($RedirectStandardInput) { $info.StandardInputEncoding = $script:Utf8 }
  if ($RedirectStandardOutput) { $info.StandardOutputEncoding = $script:Utf8 }
  if ($RedirectStandardError) { $info.StandardErrorEncoding = $script:Utf8 }
  $info.Environment.Clear()
  if ($null -ne $script:EnvironmentMap) {
    foreach ($key in $script:EnvironmentMap.Keys) { $info.Environment[[string]$key] = [string]$script:EnvironmentMap[$key] }
  }
  foreach ($argument in $Arguments) { $info.ArgumentList.Add([string]$argument) }
  return $info
}

function Start-ControllerOwnStderrDrain {
  param([Parameter(Mandatory)][Diagnostics.Process] $Process)
  if (-not $Process.StartInfo.RedirectStandardError) { return }
  if ($null -ne $Process.PSObject.Properties['ControllerOwnStderrDrainTask']) {
    throw 'Synthetic process stderr drain was already started.'
  }
  Add-ControllerOwnStderrDrainType
  $drainTask = [Morrow.Pilot.ControllerOwn.ControllerOwnStderrDrain]::DrainAsync(
    $Process.StandardError.BaseStream, $script:StderrPrefixLimit
  )
  Add-Member -InputObject $Process -NotePropertyName ControllerOwnStderrDrainTask -NotePropertyValue $drainTask
  Add-Member -InputObject $Process -NotePropertyName ControllerOwnStderrDrainState `
    -NotePropertyValue ([pscustomobject]@{
      Collected = $false; Succeeded = $false; ByteCount = [long]0; Truncated = $false
      PrefixBytes = [byte[]]::new(0); DecodedText = $null
    })
}

function Complete-ControllerOwnStderrDrain {
  param(
    [Parameter(Mandatory)][Diagnostics.Process] $Process,
    [ValidateRange(1, 30000)][int] $TimeoutMilliseconds = 1000
  )
  $taskProperty = $Process.PSObject.Properties['ControllerOwnStderrDrainTask']
  if ($null -eq $taskProperty) { return -not $Process.StartInfo.RedirectStandardError }
  $state = $Process.PSObject.Properties['ControllerOwnStderrDrainState'].Value
  if ($state.Collected) { return [bool]$state.Succeeded }
  $drainTask = $taskProperty.Value
  try {
    if (-not $drainTask.Wait([TimeSpan]::FromMilliseconds($TimeoutMilliseconds)) -and -not $drainTask.IsCompleted) {
      return $false
    }
  } catch {
    if (-not $drainTask.IsCompleted) { return $false }
  }
  $state.Collected = $true
  try {
    $drainResult = $drainTask.GetAwaiter().GetResult()
    $state.ByteCount = [long]$drainResult.ByteCount
    $state.Truncated = [bool]$drainResult.Truncated
    $state.PrefixBytes = [byte[]]$drainResult.Prefix
    if (-not $state.Truncated) { $state.DecodedText = $script:Utf8.GetString($state.PrefixBytes) }
    $state.Succeeded = $true
  } catch {
    $state.Succeeded = $false
  }
  return [bool]$state.Succeeded
}

function Test-ControllerOwnStderrDrainState {
  param([Parameter(Mandatory)][Diagnostics.Process] $Process)
  $stateProperty = $Process.PSObject.Properties['ControllerOwnStderrDrainState']
  if ($null -eq $stateProperty) { return $false }
  $state = $stateProperty.Value
  if (-not $state.Collected -or -not $state.Succeeded -or
      $state.PrefixBytes.Length -gt $script:StderrPrefixLimit -or
      $state.ByteCount -lt $state.PrefixBytes.Length) {
    return $false
  }
  if ($state.Truncated) {
    return $state.PrefixBytes.Length -eq $script:StderrPrefixLimit -and $null -eq $state.DecodedText
  }
  return $state.ByteCount -eq $state.PrefixBytes.Length -and $state.DecodedText -is [string]
}

function Add-ControllerOwnStderrDrainType {
  if ('Morrow.Pilot.ControllerOwn.ControllerOwnStderrDrain' -as [type]) { return }
  $source = @'
using System;
using System.IO;
using System.Threading.Tasks;

namespace Morrow.Pilot.ControllerOwn
{
  public sealed class ControllerOwnStderrDrainResult
  {
    public byte[] Prefix { get; private set; }
    public long ByteCount { get; private set; }
    public bool Truncated { get; private set; }

    public ControllerOwnStderrDrainResult(byte[] prefix, long byteCount, bool truncated)
    {
      Prefix = prefix;
      ByteCount = byteCount;
      Truncated = truncated;
    }
  }

  public static class ControllerOwnStderrDrain
  {
    public static Task<ControllerOwnStderrDrainResult> DrainAsync(Stream source, int maximumPrefixBytes)
    {
      if (source == null) throw new ArgumentNullException(nameof(source));
      if (maximumPrefixBytes < 1) throw new ArgumentOutOfRangeException(nameof(maximumPrefixBytes));
      return DrainCoreAsync(source, maximumPrefixBytes);
    }

    private static async Task<ControllerOwnStderrDrainResult> DrainCoreAsync(Stream source, int maximumPrefixBytes)
    {
      byte[] buffer = new byte[4096];
      using (MemoryStream prefix = new MemoryStream(maximumPrefixBytes))
      {
        long total = 0;
        int read;
        while ((read = await source.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) != 0)
        {
          int keep = Math.Min(read, maximumPrefixBytes - (int)prefix.Length);
          if (keep > 0) prefix.Write(buffer, 0, keep);
          total += read;
        }
        return new ControllerOwnStderrDrainResult(prefix.ToArray(), total, total > maximumPrefixBytes);
      }
    }
  }
}
'@
  Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
}

function Start-ControllerOwnWorker {
  param([Parameter(Mandatory)][string] $Role, [Parameter(Mandatory)][string] $ReadyPath, [Parameter(Mandatory)][string] $ChildPidPath, [Parameter(Mandatory)][string] $ChildReadyPath, [Parameter(Mandatory)][string] $StopPath)
  $arguments = @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    $script:WorkerPath, $Role, $ReadyPath, $ChildPidPath, $ChildReadyPath, $StopPath, $script:PwshPath
  )
  $info = New-ControllerOwnProcessInfo -ExecutablePath $script:PwshPath -Arguments $arguments `
    -RedirectStandardInput $false -RedirectStandardOutput $true -RedirectStandardError $true
  $process = [Diagnostics.Process]::Start($info)
  if ($null -eq $process) { throw 'Synthetic worker process did not start.' }
  $script:TrackedProcesses.Add($process)
  Start-ControllerOwnStderrDrain -Process $process
  return $process
}

function Start-ControllerOwnController {
  param([int] $FrameTimeoutMilliseconds = 120000, [bool] $RedirectError = $true)
  $arguments = @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', $script:ControllerPath,
    '-Protocol', 'stdio-v1', '-FrameTimeoutMilliseconds', [string]$FrameTimeoutMilliseconds
  )
  $info = New-ControllerOwnProcessInfo -ExecutablePath $script:ControllerHostPath -Arguments $arguments `
    -RedirectStandardInput $true -RedirectStandardOutput $true -RedirectStandardError $RedirectError
  if ([string]::IsNullOrWhiteSpace($script:RunnerTemp)) { throw 'Validated RUNNER_TEMP is unavailable for controller launch.' }
  $info.Environment['RUNNER_TEMP'] = $script:RunnerTemp
  $process = [Diagnostics.Process]::Start($info)
  if ($null -eq $process) { throw 'Controller subprocess did not start.' }
  $script:TrackedProcesses.Add($process)
  Start-ControllerOwnStderrDrain -Process $process
  return $process
}

function Send-ControllerOwnRequest {
  param([Parameter(Mandatory)][Diagnostics.Process] $Process, [Parameter(Mandatory)][string] $Json)
  $lineTask = $Process.StandardOutput.ReadLineAsync()
  $Process.StandardInput.WriteLine($Json)
  $Process.StandardInput.Flush()
  if (-not $lineTask.Wait([TimeSpan]::FromSeconds(30))) { throw 'Controller did not answer the protocol request within 30 seconds.' }
  $line = $lineTask.GetAwaiter().GetResult()
  if ([string]::IsNullOrEmpty($line)) { throw 'Controller closed stdout without a JSON response.' }
  if ($script:Utf8.GetByteCount($line + "`n") -gt 1048576) { throw 'Controller response exceeded its 1 MiB line limit.' }
  return (ConvertFrom-Json -InputObject $line -AsHashtable -Depth 16 -DateKind String)
}

function New-ControllerOwnExternalDescriptor {
  param([Parameter(Mandatory)][int] $ControllerPid, [Parameter(Mandatory)][string] $WorkerScript, [Parameter(Mandatory)][string] $Role, [Parameter(Mandatory)][string] $ReadyPath, [Parameter(Mandatory)][string] $ChildPidPath, [Parameter(Mandatory)][string] $ChildReadyPath, [Parameter(Mandatory)][string] $StopPath)
  return [ordered]@{
    executablePath = $script:PwshPath
    executableSha256 = $script:PwshHash
    argumentList = @(
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      $WorkerScript, $Role, $ReadyPath, $ChildPidPath, $ChildReadyPath, $StopPath, $script:PwshPath
    )
    workingDirectory = $script:RuntimeRoot
    profilePath = $script:ProfilePath
    environment = $script:EnvironmentMap
    expectedParentProcessId = $ControllerPid
    expectedOwnerSid = $script:OwnerSid
  }
}

function Add-ControllerOwnProcessHandleInterop {
  if ('Morrow.Pilot.ControllerOwn.ControllerOwnProcessHandleInterop' -as [type]) { return }
  $source = @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Morrow.Pilot.ControllerOwn
{
  public sealed class ControllerOwnProcessSafeHandle : SafeHandle
  {
    public ControllerOwnProcessSafeHandle() : base(IntPtr.Zero, true) { }
    public override bool IsInvalid { get { return handle == IntPtr.Zero || handle == new IntPtr(-1); } }
    protected override bool ReleaseHandle() { return CloseHandle(handle); }
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
  }

  public static class ControllerOwnProcessHandleInterop
  {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern ControllerOwnProcessSafeHandle OpenProcess(uint desiredAccess, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(ControllerOwnProcessSafeHandle process, uint milliseconds);
  }
}
'@
  Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
}

function Get-ControllerOwnProcessHandle {
  param([Parameter(Mandatory)][ValidateRange(1, [int]::MaxValue)][int] $ProcessId)
  Add-ControllerOwnProcessHandleInterop
  $handle = [Morrow.Pilot.ControllerOwn.ControllerOwnProcessHandleInterop]::OpenProcess(
    [uint32]0x00101000, $false, $ProcessId
  )
  if ($null -eq $handle -or $handle.IsInvalid -or $handle.IsClosed) {
    if ($null -ne $handle) { $handle.Dispose() }
    throw 'Could not retain an observer handle for a synthetic process.'
  }
  try {
    $waitState = [Morrow.Pilot.ControllerOwn.ControllerOwnProcessHandleInterop]::WaitForSingleObject($handle, [uint32]0)
    if ($waitState -ne [uint32]258) { throw 'Synthetic process was not observed alive when its handle was retained.' }
    $retained = [pscustomobject]@{ ProcessId = $ProcessId; Handle = $handle }
    $script:HeldProcessHandles.Add($retained)
    return $retained
  } catch {
    $handle.Dispose()
    throw
  }
}

function Test-ControllerOwnProcessesExited {
  param([Parameter(Mandatory)][object[]] $Processes, [int] $TimeoutMilliseconds = 10000)
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  foreach ($retainedProcess in $Processes) {
    $handle = $retainedProcess.Handle
    if ($null -eq $handle -or $handle.IsInvalid -or $handle.IsClosed) {
      throw 'Retained synthetic-process observer handle is not usable.'
    }
    while ($true) {
      $waitState = [Morrow.Pilot.ControllerOwn.ControllerOwnProcessHandleInterop]::WaitForSingleObject($handle, [uint32]0)
      if ($waitState -eq [uint32]0) { break }
      if ($waitState -ne [uint32]258) { throw 'Synthetic-process exit query failed.' }
      if ([DateTime]::UtcNow -ge $deadline) { return $false }
      Start-Sleep -Milliseconds 50
    }
  }
  return $true
}

try {
  $runnerTemp = if ($SyntheticOnly) {
    [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  } else {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This acceptance suite requires a real Windows runner.' }
    [Environment]::GetEnvironmentVariable('RUNNER_TEMP', [EnvironmentVariableTarget]::Process)
  }
  if ([string]::IsNullOrWhiteSpace($runnerTemp) -or -not [IO.Directory]::Exists($runnerTemp)) { throw 'RUNNER_TEMP is unavailable.' }
  $runnerTemp = [IO.Path]::GetFullPath($runnerTemp)
  $evidenceReservation = New-ControllerOwnEvidenceReservation -RunnerTempPath $runnerTemp -EvidenceRootPath $EvidenceRoot
  $script:RunnerTemp = $runnerTemp
  $script:EvidenceReceiptStream = $evidenceReservation.ReceiptStream
  $script:EvidenceFullPath = $evidenceReservation.FullPath
  $script:EvidenceWriteReady = $true
  $redirectedInfo = New-ControllerOwnProcessInfo -ExecutablePath 'not-launched' -Arguments @('-synthetic') `
    -RedirectStandardInput $true -RedirectStandardOutput $true -RedirectStandardError $true
  $unredirectedInfo = New-ControllerOwnProcessInfo -ExecutablePath 'not-launched' -Arguments @('-synthetic') `
    -RedirectStandardInput $false -RedirectStandardOutput $false -RedirectStandardError $false
  $strictEncodings = @(
    $redirectedInfo.StandardInputEncoding,
    $redirectedInfo.StandardOutputEncoding,
    $redirectedInfo.StandardErrorEncoding
  ) | Where-Object {
    $_ -is [Text.UTF8Encoding] -and $_.CodePage -eq 65001 -and $_.GetPreamble().Length -eq 0 -and
    $_.EncoderFallback -is [Text.EncoderExceptionFallback] -and $_.DecoderFallback -is [Text.DecoderExceptionFallback]
  }
  Assert-ControllerOwnCheck -Condition (
    $strictEncodings.Count -eq 3 -and
    $null -eq $unredirectedInfo.StandardInputEncoding -and
    $null -eq $unredirectedInfo.StandardOutputEncoding -and
    $null -eq $unredirectedInfo.StandardErrorEncoding
  ) -Name 'redirectedProcessStreamsUseStrictUtf8WithoutBom'
  $syntheticHostName = if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { 'pwsh.exe' } else { 'pwsh' }
  $syntheticHostPath = Join-Path $PSHOME $syntheticHostName
  $stderrMarker = 'MORROW-ISSUE247-STDERR-MARKER|'
  $stderrFixturePadding = 16384 - $script:Utf8.GetByteCount($stderrMarker)
  $stderrFixtureExpected = $stderrMarker + ('e' * $stderrFixturePadding)
  $stderrFixtureCommand = "[Console]::Error.Write(('$stderrMarker' + ('e' * $stderrFixturePadding)))"
  $stderrFixtureInfo = New-ControllerOwnProcessInfo -ExecutablePath $syntheticHostPath -Arguments @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', $stderrFixtureCommand
  ) -RedirectStandardInput $false -RedirectStandardOutput $true -RedirectStandardError $true
  if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
    $fixtureWindowsDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
    $stderrFixtureInfo.Environment['SYSTEMROOT'] = $fixtureWindowsDirectory
    $stderrFixtureInfo.Environment['WINDIR'] = $fixtureWindowsDirectory
  }
  $stderrFixtureProcess = [Diagnostics.Process]::Start($stderrFixtureInfo)
  if ($null -eq $stderrFixtureProcess) { throw 'Synthetic stderr fixture process did not start.' }
  $script:TrackedProcesses.Add($stderrFixtureProcess)
  Start-ControllerOwnStderrDrain -Process $stderrFixtureProcess
  if (-not $stderrFixtureProcess.WaitForExit(10000)) { throw 'Synthetic stderr fixture blocked before exit.' }
  $stderrDrainFirst = Complete-ControllerOwnStderrDrain -Process $stderrFixtureProcess -TimeoutMilliseconds 10000
  $stderrDrainSecond = Complete-ControllerOwnStderrDrain -Process $stderrFixtureProcess -TimeoutMilliseconds 10000
  $stderrDrainState = $stderrFixtureProcess.PSObject.Properties['ControllerOwnStderrDrainState'].Value
  Assert-ControllerOwnCheck -Condition (
    $stderrFixtureProcess.ExitCode -eq 0 -and $stderrDrainFirst -and $stderrDrainSecond -and
    $stderrDrainState.Collected -and $stderrDrainState.Succeeded -and
    $stderrDrainState.ByteCount -eq 16384 -and -not $stderrDrainState.Truncated -and
    $stderrDrainState.PrefixBytes.Length -eq 16384 -and $stderrDrainState.DecodedText -ceq $stderrFixtureExpected -and
    (Test-ControllerOwnStderrDrainState -Process $stderrFixtureProcess)
  ) -Name 'stderrDrainTaskIsAsyncBoundedAndIdempotent'
  $stderrOverflowBytes = $script:StderrPrefixLimit + 8192
  $stderrOverflowInfo = New-ControllerOwnProcessInfo -ExecutablePath $syntheticHostPath -Arguments @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "[Console]::Error.Write(('f' * $stderrOverflowBytes))"
  ) -RedirectStandardInput $false -RedirectStandardOutput $true -RedirectStandardError $true
  if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
    $stderrOverflowInfo.Environment['SYSTEMROOT'] = $fixtureWindowsDirectory
    $stderrOverflowInfo.Environment['WINDIR'] = $fixtureWindowsDirectory
  }
  $stderrOverflowProcess = [Diagnostics.Process]::Start($stderrOverflowInfo)
  if ($null -eq $stderrOverflowProcess) { throw 'Synthetic stderr overflow fixture process did not start.' }
  $script:TrackedProcesses.Add($stderrOverflowProcess)
  Start-ControllerOwnStderrDrain -Process $stderrOverflowProcess
  if (-not $stderrOverflowProcess.WaitForExit(10000)) { throw 'Synthetic stderr overflow fixture blocked at the capture limit.' }
  $stderrOverflowDrained = Complete-ControllerOwnStderrDrain -Process $stderrOverflowProcess -TimeoutMilliseconds 10000
  $stderrOverflowState = $stderrOverflowProcess.PSObject.Properties['ControllerOwnStderrDrainState'].Value
  Assert-ControllerOwnCheck -Condition (
    $stderrOverflowProcess.ExitCode -eq 0 -and $stderrOverflowDrained -and
    $stderrOverflowState.ByteCount -eq $stderrOverflowBytes -and $stderrOverflowState.Truncated -and
    $stderrOverflowState.PrefixBytes.Length -eq $script:StderrPrefixLimit -and
    $null -eq $stderrOverflowState.DecodedText -and
    (Test-ControllerOwnStderrDrainState -Process $stderrOverflowProcess)
  ) -Name 'stderrDrainContinuesPastPrefixLimit'
  $script:PrivateRoot = Join-Path $runnerTemp ('morrow-issue-247-own-' + $script:RunId)
  [void][IO.Directory]::CreateDirectory($script:PrivateRoot)
  $reservationTemp = Join-Path $script:PrivateRoot 'evidence-reservation-temp'
  $existingEvidence = Join-Path $reservationTemp 'already-exists'
  $outsideEvidence = Join-Path $script:PrivateRoot 'outside-evidence'
  [void][IO.Directory]::CreateDirectory($reservationTemp)
  [void][IO.Directory]::CreateDirectory($existingEvidence)
  $existingSentinel = Join-Path $existingEvidence 'sentinel.txt'
  [IO.File]::WriteAllText($existingSentinel, 'preserve', $script:Utf8)
  $existingRejected = $false
  try {
    $unexpectedReservation = New-ControllerOwnEvidenceReservation -RunnerTempPath $reservationTemp -EvidenceRootPath $existingEvidence
    $unexpectedReservation.ReceiptStream.Dispose()
  } catch { $existingRejected = $true }
  $outsideRejected = $false
  try {
    $unexpectedReservation = New-ControllerOwnEvidenceReservation -RunnerTempPath $reservationTemp -EvidenceRootPath $outsideEvidence
    $unexpectedReservation.ReceiptStream.Dispose()
  } catch { $outsideRejected = $true }
  Assert-ControllerOwnCheck -Condition (
    $existingRejected -and $outsideRejected -and
    [IO.File]::ReadAllText($existingSentinel) -ceq 'preserve' -and
    -not [IO.File]::Exists((Join-Path $existingEvidence 'controller-own.json')) -and
    -not [IO.Directory]::Exists($outsideEvidence)
  ) -Name 'evidenceReservationRejectsUntrustedPaths'
  if (-not $SyntheticOnly) {
    $script:RuntimeRoot = Join-Path $script:PrivateRoot 'runtime-controller-雪'
    $script:ProfilePath = Join-Path $script:PrivateRoot 'profile-controller-雪'
    $appDataPath = Join-Path $script:ProfilePath 'AppData\Roaming'
    $localAppDataPath = Join-Path $script:ProfilePath 'AppData\Local'
    $tempPath = Join-Path $localAppDataPath 'Temp'
    foreach ($directory in @($script:RuntimeRoot, $appDataPath, $tempPath)) { [void][IO.Directory]::CreateDirectory($directory) }
    foreach ($item in (Get-ChildItem -LiteralPath $PSHOME -Force -ErrorAction Stop)) {
      Copy-Item -LiteralPath $item.FullName -Destination $script:RuntimeRoot -Recurse -Force -ErrorAction Stop
    }
    $script:PwshPath = Join-Path $script:RuntimeRoot 'pwsh.exe'
    if (-not [IO.File]::Exists($script:PwshPath)) { throw 'Staged PowerShell runtime has no pwsh.exe.' }
    $script:PwshHash = (Get-FileHash -LiteralPath $script:PwshPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    $script:ControllerHostPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
    $script:WindowsDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
    $script:System32 = Join-Path $script:WindowsDirectory 'System32'
    $script:OwnerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $script:EnvironmentMap = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
    $script:EnvironmentMap.Add('SYSTEMROOT', $script:WindowsDirectory)
    $script:EnvironmentMap.Add('WINDIR', $script:WindowsDirectory)
    $script:EnvironmentMap.Add('PATH', ($script:System32 + ';' + $script:RuntimeRoot))
    $script:EnvironmentMap.Add('USERPROFILE', $script:ProfilePath)
    $script:EnvironmentMap.Add('APPDATA', $appDataPath)
    $script:EnvironmentMap.Add('LOCALAPPDATA', $localAppDataPath)
    $script:EnvironmentMap.Add('TEMP', $tempPath)
    $script:EnvironmentMap.Add('TMP', $tempPath)
    $script:EnvironmentMap.Add('HOME', $script:ProfilePath)
    $script:WorkerPath = Join-Path $script:PrivateRoot 'process-worker.ps1'

    $workerSource = @'
param(
  [Parameter(Mandatory)][ValidateSet('owned-live','owned-root-exits','owned-child','outsider')][string] $Role,
  [Parameter(Mandatory)][string] $ReadyPath,
  [Parameter(Mandatory)][string] $ChildPidPath,
  [Parameter(Mandatory)][string] $ChildReadyPath,
  [Parameter(Mandatory)][string] $StopPath,
  [Parameter(Mandatory)][string] $StagedPwsh
)
$utf8 = [Text.UTF8Encoding]::new($false)
[Console]::Error.Write(('e' * 16384))
if ($Role -in @('owned-live', 'owned-root-exits')) {
  $childInfo = [Diagnostics.ProcessStartInfo]::new()
  $childInfo.FileName = $StagedPwsh
  $childInfo.WorkingDirectory = (Get-Location).Path
  $childInfo.UseShellExecute = $false
  $childInfo.CreateNoWindow = $true
  foreach ($argument in @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$PSCommandPath,'owned-child',$ReadyPath,$ChildPidPath,$ChildReadyPath,$StopPath,$StagedPwsh)) {
    $childInfo.ArgumentList.Add([string]$argument)
  }
  $child = [Diagnostics.Process]::Start($childInfo)
  if ($null -eq $child) { exit 91 }
  [IO.File]::WriteAllText($ChildPidPath, [string]$child.Id, $utf8)
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while (-not [IO.File]::Exists($ChildReadyPath) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 20 }
  if (-not [IO.File]::Exists($ChildReadyPath)) { exit 92 }
  [IO.File]::WriteAllText($ReadyPath, [string]$PID, $utf8)
  if ($Role -eq 'owned-root-exits') { exit 0 }
}
elseif ($Role -eq 'owned-child' -or $Role -eq 'outsider') {
  [IO.File]::WriteAllText($ChildReadyPath, [string]$PID, $utf8)
  [IO.File]::WriteAllText($ReadyPath, [string]$PID, $utf8)
}
while (-not [IO.File]::Exists($StopPath)) { Start-Sleep -Milliseconds 50 }
'@
    [IO.File]::WriteAllText($script:WorkerPath, $workerSource, $script:Utf8)
    $script:ExternalPaths.Add($script:WorkerPath)
  }

  $typeBefore = $null -ne ('Morrow.Pilot.WindowsNativeJobSession' -as [type])
  $dotSourceOutput = @(. $script:ControllerPath)
  $typeAfter = $null -ne ('Morrow.Pilot.WindowsNativeJobSession' -as [type])
  Assert-ControllerOwnCheck -Condition (
    $dotSourceOutput.Count -eq 0 -and
    (Get-Command Invoke-PilotWindowsNativeProcessJsonlController -CommandType Function -ErrorAction SilentlyContinue) -and
    (Get-Command Read-PilotWindowsNativeProcessJsonlRequest -CommandType Function -ErrorAction SilentlyContinue) -and
    $typeBefore -eq $typeAfter
  ) -Name 'dotSourceDefinesControllerWithoutNativeSideEffects'
  Add-ControllerOwnProcessHandleInterop
  Assert-ControllerOwnCheck -Condition (
    $null -ne ('Morrow.Pilot.ControllerOwn.ControllerOwnProcessSafeHandle' -as [type]) -and
    $null -ne ('Morrow.Pilot.ControllerOwn.ControllerOwnProcessHandleInterop' -as [type])
  ) -Name 'retainedObserverSafeHandleCompiles'
  if ($SyntheticOnly -and [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    function Get-PilotWindowsNativeProcessDescriptor {
      param([AllowNull()][object] $Descriptor)
      return $Descriptor
    }
    function ConvertTo-PilotWindowsNativeProcessIdentityAssertion {
      param([AllowNull()][object] $IdentityAssertion)
      if ($null -eq $IdentityAssertion) { return ,([ordered]@{}) }
      return ,$IdentityAssertion
    }
  }

  # The accepted command reader suite remains a separate, byte-identical test input.
  $baselineReaderHash = (Get-FileHash -LiteralPath $script:ReaderPath -Algorithm SHA256).Hash
  $baselinePolicyHash = (Get-FileHash -LiteralPath $script:PolicyPath -Algorithm SHA256).Hash
  $baselineHelperHashes = @(
    (Get-FileHash -LiteralPath $script:ProcessHelperPath -Algorithm SHA256).Hash,
    (Get-FileHash -LiteralPath $script:JobHelperPath -Algorithm SHA256).Hash
  )

  $stateOne = New-ControllerOwnOperations
  $idOne = 'A1A11111-1111-4111-8111-111111111111'
  $idTwo = 'a2a22222-2222-4222-8222-222222222222'
  $idThree = 'a3a33333-3333-4333-8333-333333333333'
  $idFour = 'a4a44444-4444-4444-8444-444444444444'
  $idFive = 'a5a55555-5555-4555-8555-555555555555'
  $idSix = 'a6a66666-6666-4666-8666-666666666666'
  $idSeven = 'a7a77777-7777-4777-8777-777777777777'
  $idEight = 'a8a88888-8888-4888-8888-888888888888'
  $capsuleOneId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  $capsuleTwoId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  $sequence = @(
    (New-ControllerOwnFrame -Operation start -RequestId $idOne),
    (New-ControllerOwnFrame -Operation observe -RequestId $idTwo -CapsuleId 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
    (New-ControllerOwnFrame -Operation start -RequestId $idThree),
    (New-ControllerOwnFrame -Operation observe -RequestId $idFour -CapsuleId $capsuleOneId -WrongAssertion),
    (New-ControllerOwnFrame -Operation observe -RequestId $idFive -CapsuleId $capsuleOneId),
    (New-ControllerOwnFrame -Operation stop -RequestId $idSix -CapsuleId $capsuleOneId),
    (New-ControllerOwnFrame -Operation start -RequestId $idSeven),
    (New-ControllerOwnFrame -Operation stop -RequestId $idEight -CapsuleId $capsuleTwoId)
  ) -join "`n"
  $memoryRun = Invoke-ControllerOwnMemoryRun -InputText ($sequence + "`n") -Operations $stateOne.Operations `
    -CapsuleIdFactory (New-ControllerOwnCapsuleIdFactory -Ids @($capsuleOneId, $capsuleTwoId))
  $responses = @(ConvertFrom-ControllerOwnResponses -Text $memoryRun.Stdout)
  $script:Checks.sequentialStartObserveStopIsCorrelated = (
    $memoryRun.ExitCode -eq 0 -and $responses.Count -eq 8 -and
    [string]$responses[0].requestId -ceq $idOne -and [string]$responses[0].result.capsuleId -ceq $capsuleOneId -and
    [string]$responses[5].requestId -ceq $idSix -and [bool]$responses[5].ok -and
    [string]$responses[6].requestId -ceq $idSeven -and [string]$responses[6].result.capsuleId -ceq $capsuleTwoId -and
    [string]$responses[7].requestId -ceq $idEight -and [bool]$responses[7].ok
  )
  Assert-ControllerOwnCheck -Condition $script:Checks.sequentialStartObserveStopIsCorrelated -Name 'sequentialStartObserveStopIsCorrelated'
  Assert-ControllerOwnCheck -Condition (
    $memoryRun.ExitCode -eq 0 -and $responses.Count -eq 8 -and
    [string]$responses[0].requestId -ceq $idOne -and [bool]$responses[0].ok -and
    [string]$responses[0].result.capsuleId -ceq $capsuleOneId -and
    [string]$responses[1].error.code -ceq 'UnknownCapsule' -and
    [string]$responses[2].error.code -ceq 'CapsuleAlreadyActive' -and
    [string]$responses[3].error.code -ceq 'IdentityMismatch' -and
    [string]$responses[4].requestId -ceq $idFive -and [bool]$responses[4].ok -and
    [string]$responses[5].requestId -ceq $idSix -and [bool]$responses[5].ok -and
    [string]$responses[6].result.capsuleId -ceq $capsuleTwoId -and
    [string]$responses[7].requestId -ceq $idEight -and [bool]$responses[7].ok -and
    $stateOne.State.starts -eq 2 -and $stateOne.State.stops -eq 2 -and $stateOne.State.disposes -eq 0 -and
    $memoryRun.Stdout -notmatch 'secret|S-1-5-32-544|C:\\Pilot'
  ) -Name 'wrongCapsuleAndSecondStartAreRecoverable'
  $script:Checks.assertionMismatchPreservesCapsule = (
    [string]$responses[3].error.code -ceq 'IdentityMismatch' -and
    [bool]$responses[4].ok -and [bool]$responses[5].ok
  )
  Assert-ControllerOwnCheck -Condition $script:Checks.assertionMismatchPreservesCapsule -Name 'assertionMismatchPreservesCapsule'

  $stateStartMismatch = New-ControllerOwnOperations
  $stateStartMismatch.State.startMismatchOnce = $true
  $startRetryFrames = @(
    (New-ControllerOwnFrame -Operation start -RequestId '91a11111-1111-4111-8111-111111111111'),
    (New-ControllerOwnFrame -Operation start -RequestId '92a22222-2222-4222-8222-222222222222'),
    (New-ControllerOwnFrame -Operation stop -RequestId '93a33333-3333-4333-8333-333333333333' -CapsuleId $capsuleOneId)
  ) -join "`n"
  $startRetryRun = Invoke-ControllerOwnMemoryRun -InputText ($startRetryFrames + "`n") `
    -Operations $stateStartMismatch.Operations -CapsuleIdFactory (New-ControllerOwnCapsuleIdFactory -Ids @($capsuleOneId))
  $startRetryResponses = @(ConvertFrom-ControllerOwnResponses -Text $startRetryRun.Stdout)
  Assert-ControllerOwnCheck -Condition (
    $startRetryRun.ExitCode -eq 0 -and $startRetryResponses.Count -eq 3 -and
    [string]$startRetryResponses[0].error.code -ceq 'IdentityMismatch' -and
    [string]$startRetryResponses[0].cleanup.state -ceq 'confirmed' -and
    $startRetryResponses[0].cleanup.jobEmpty -eq $true -and $startRetryResponses[0].cleanup.rootExited -eq $true -and
    $startRetryResponses[0].cleanup.disposeFailed -eq $false -and
    [bool]$startRetryResponses[1].ok -and [bool]$startRetryResponses[2].ok -and
    $stateStartMismatch.State.starts -eq 2 -and $stateStartMismatch.State.stops -eq 1
  ) -Name 'startFailureCanRetryOnlyAfterVerifiedCleanup'

  $stateObserveFailure = New-ControllerOwnOperations
  $stateObserveFailure.Operations['Observe'] = {
    param($capsule, $identityAssertion)
    throw (New-ControllerOwnNativeFailure -ErrorId 'Morrow.WindowsNativeProcess.IdentityUnavailable' -Stage 'observe-native-read')
  }
  $observeFailureId = '94a44444-4444-4444-8444-444444444444'
  $observeFailureRun = Invoke-ControllerOwnMemoryRun `
    -InputText ((New-ControllerOwnFrame -Operation start -RequestId $observeFailureId) + "`n" + `
      (New-ControllerOwnFrame -Operation start -RequestId '95a55555-5555-4555-8555-555555555555') + "`n") `
    -Operations $stateObserveFailure.Operations `
    -CapsuleIdFactory (New-ControllerOwnCapsuleIdFactory -Ids @($capsuleOneId))
  $observeFailureResponses = @(ConvertFrom-ControllerOwnResponses -Text $observeFailureRun.Stdout)
  Assert-ControllerOwnCheck -Condition (
    $observeFailureRun.ExitCode -ne 0 -and $observeFailureResponses.Count -eq 1 -and
    [string]$observeFailureResponses[0].error.code -ceq 'IdentityUnavailable' -and
    [string]$observeFailureResponses[0].cleanup.state -ceq 'confirmed' -and
    $observeFailureResponses[0].cleanup.jobEmpty -eq $true -and
    $observeFailureResponses[0].cleanup.rootExited -eq $true -and
    $stateObserveFailure.State.starts -eq 1 -and $stateObserveFailure.State.disposes -eq 1
  ) -Name 'startObservationFailureIsTerminalAfterCleanup'

  $stateDuplicateRequest = New-ControllerOwnOperations
  $duplicateRequestId = '96a66666-6666-4666-8666-666666666666'
  $duplicateInput = (New-ControllerOwnFrame -Operation start -RequestId $duplicateRequestId) + "`n" +
    (New-ControllerOwnFrame -Operation observe -RequestId $duplicateRequestId -CapsuleId $capsuleOneId) + "`n"
  $duplicateRun = Invoke-ControllerOwnMemoryRun -InputText $duplicateInput -Operations $stateDuplicateRequest.Operations `
    -CapsuleIdFactory (New-ControllerOwnCapsuleIdFactory -Ids @($capsuleOneId))
  $duplicateResponses = @(ConvertFrom-ControllerOwnResponses -Text $duplicateRun.Stdout)
  Assert-ControllerOwnCheck -Condition (
    $duplicateRun.ExitCode -ne 0 -and $duplicateResponses.Count -eq 2 -and
    [bool]$duplicateResponses[0].ok -and $null -eq $duplicateResponses[1].requestId -and
    [string]$duplicateResponses[1].error.code -ceq 'DuplicateRequestId' -and
    [string]$duplicateResponses[1].cleanup.state -ceq 'confirmed' -and $stateDuplicateRequest.State.disposes -eq 1
  ) -Name 'duplicateRequestIdCleansOwnCapsule'

  $stateFatal = New-ControllerOwnOperations
  $fatalStartId = 'b1b11111-1111-4111-8111-111111111111'
  $fatalInput = (New-ControllerOwnFrame -Operation start -RequestId $fatalStartId) + "`n{" + "`n"
  $fatalRun = Invoke-ControllerOwnMemoryRun -InputText $fatalInput -Operations $stateFatal.Operations `
    -CapsuleIdFactory (New-ControllerOwnCapsuleIdFactory -Ids @($capsuleOneId))
  $fatalResponses = @(ConvertFrom-ControllerOwnResponses -Text $fatalRun.Stdout)
  Assert-ControllerOwnResponse -Response $fatalResponses[1] -RequestId $null -ExpectedOk $false
  Assert-ControllerOwnCheck -Condition (
    $fatalRun.ExitCode -ne 0 -and $fatalResponses.Count -eq 2 -and
    [bool]$fatalResponses[0].ok -and $null -eq $fatalResponses[1].requestId -and
    [string]$fatalResponses[1].error.code -ceq 'MalformedJson' -and
    [string]$fatalResponses[1].cleanup.state -ceq 'confirmed' -and
    $fatalResponses[1].cleanup.jobEmpty -eq $true -and $fatalResponses[1].cleanup.rootExited -eq $true -and
    $fatalResponses[1].cleanup.disposeFailed -eq $false -and $stateFatal.State.disposes -eq 1 -and
    $fatalRun.Stdout -notmatch 'secret|C:\\Pilot'
  ) -Name 'fatalReaderErrorUsesNullRequestIdAndVerifiedCleanup'

  $stateUnconfirmed = New-ControllerOwnOperations
  $stateUnconfirmed.State.disposeFails = $true
  $unconfirmedRun = Invoke-ControllerOwnMemoryRun -InputText $fatalInput -Operations $stateUnconfirmed.Operations `
    -CapsuleIdFactory (New-ControllerOwnCapsuleIdFactory -Ids @($capsuleOneId))
  $unconfirmedResponses = @(ConvertFrom-ControllerOwnResponses -Text $unconfirmedRun.Stdout)
  Assert-ControllerOwnCheck -Condition (
    $unconfirmedRun.ExitCode -ne 0 -and $unconfirmedResponses.Count -eq 2 -and
    $null -eq $unconfirmedResponses[1].requestId -and
    [string]$unconfirmedResponses[1].cleanup.state -ceq 'unconfirmed' -and
    [bool]$unconfirmedResponses[1].cleanup.disposeFailed -and $stateUnconfirmed.State.disposes -eq 1
  ) -Name 'fatalReaderErrorDoesNotClaimUnconfirmedCleanup'

  Add-ControllerOwnTimeoutStreamType
  $deadlineState = New-ControllerOwnOperations
  $deadlineStartId = 'b2b22222-2222-4222-8222-222222222222'
  $deadlineBytes = $script:Utf8.GetBytes(
    (New-ControllerOwnFrame -Operation start -RequestId $deadlineStartId) + "`n" + '{"version":1,"requestId":"b3b33333'
  )
  $partialThenBlock = [Morrow.Pilot.ControllerOwn.PartialThenBlockStream]::new($deadlineBytes)
  $deadlineRun = Invoke-ControllerOwnMemoryRun -InputText '' -Operations $deadlineState.Operations `
    -CapsuleIdFactory (New-ControllerOwnCapsuleIdFactory -Ids @($capsuleOneId)) `
    -InputStreamOverride $partialThenBlock -FrameTimeoutMilliseconds 100
  $deadlineResponses = @(ConvertFrom-ControllerOwnResponses -Text $deadlineRun.Stdout)
  Assert-ControllerOwnCheck -Condition (
    $deadlineRun.ExitCode -ne 0 -and $deadlineResponses.Count -eq 2 -and
    $null -eq $deadlineResponses[1].requestId -and
    [string]$deadlineResponses[1].error.code -ceq 'DeadlineExceeded' -and
    [string]$deadlineResponses[1].cleanup.state -ceq 'confirmed' -and
    $deadlineState.State.disposes -eq 1 -and $deadlineRun.Stdout -notmatch 'requestId.*b3b33333'
  ) -Name 'partialFrameDeadlineCleansOwnCapsule'
  $partialThenBlock.Dispose()

  $stateEof = New-ControllerOwnOperations
  $eofStartId = 'c1c11111-1111-4111-8111-111111111111'
  $eofRun = Invoke-ControllerOwnMemoryRun -InputText ((New-ControllerOwnFrame -Operation start -RequestId $eofStartId) + "`n") `
    -Operations $stateEof.Operations -CapsuleIdFactory (New-ControllerOwnCapsuleIdFactory -Ids @($capsuleOneId))
  $eofResponses = @(ConvertFrom-ControllerOwnResponses -Text $eofRun.Stdout)
  Assert-ControllerOwnCheck -Condition (
    $eofRun.ExitCode -eq 0 -and $eofResponses.Count -eq 1 -and
    [bool]$eofResponses[0].ok -and $stateEof.State.disposes -eq 1
  ) -Name 'cleanEofRequiresVerifiedCleanupAndHasNoReply'

  $stateEofUnconfirmed = New-ControllerOwnOperations
  $stateEofUnconfirmed.State.disposeFails = $true
  $eofUnconfirmedRun = Invoke-ControllerOwnMemoryRun `
    -InputText ((New-ControllerOwnFrame -Operation start -RequestId $eofStartId) + "`n") `
    -Operations $stateEofUnconfirmed.Operations `
    -CapsuleIdFactory (New-ControllerOwnCapsuleIdFactory -Ids @($capsuleOneId))
  $eofUnconfirmedResponses = @(ConvertFrom-ControllerOwnResponses -Text $eofUnconfirmedRun.Stdout)
  Assert-ControllerOwnCheck -Condition (
    $eofUnconfirmedRun.ExitCode -ne 0 -and $eofUnconfirmedResponses.Count -eq 1 -and
    [bool]$eofUnconfirmedResponses[0].ok -and $stateEofUnconfirmed.State.disposes -eq 1
  ) -Name 'unconfirmedEofIsNonzeroWithoutSyntheticReply'

  $stateTimeout = New-ControllerOwnOperations
  $stateTimeout.State.stopTimesOut = $true
  $stateTimeout.State.disposeFails = $true
  $timeoutStartId = 'd1d11111-1111-4111-8111-111111111111'
  $timeoutStopId = 'd2d22222-2222-4222-8222-222222222222'
  $timeoutFrames = @(
    (New-ControllerOwnFrame -Operation start -RequestId $timeoutStartId),
    (New-ControllerOwnFrame -Operation stop -RequestId $timeoutStopId -CapsuleId 'placeholder' -TimeoutZero)
  )
  $timeoutFrames[1] = New-ControllerOwnFrame -Operation stop -RequestId $timeoutStopId -CapsuleId $capsuleOneId -TimeoutZero
  $timeoutRun = Invoke-ControllerOwnMemoryRun -InputText (($timeoutFrames -join "`n") + "`n") -Operations $stateTimeout.Operations `
    -CapsuleIdFactory (New-ControllerOwnCapsuleIdFactory -Ids @($capsuleOneId))
  $timeoutResponses = @(ConvertFrom-ControllerOwnResponses -Text $timeoutRun.Stdout)
  Assert-ControllerOwnCheck -Condition (
    $timeoutRun.ExitCode -ne 0 -and $timeoutResponses.Count -eq 2 -and
    [string]$timeoutResponses[1].error.code -ceq 'StopTimedOut' -and
    [string]$timeoutResponses[1].cleanup.state -ceq 'unconfirmed' -and
    $timeoutResponses[1].cleanup.disposeFailed -eq $true -and
    $stateTimeout.State.disposes -eq 1
  ) -Name 'stopTimeoutSurvivesDisposeOutcome'

  $oversizedEnvelope = [ordered]@{
    version = 1; requestId = $idSix; ok = $true
    result = [ordered]@{ payload = ('z' * 1100000) }
    cleanup = [ordered]@{ state = 'not-required'; jobEmpty = $null; rootExited = $null; disposeFailed = $null }
  }
  $limitError = $null
  try { $null = ConvertTo-PilotWindowsNativeProcessJsonlResponseBytes -Envelope $oversizedEnvelope } catch { $limitError = $_.Exception }
  Assert-ControllerOwnCheck -Condition (
    $null -ne $limitError -and (Get-ControllerOwnErrorId -Exception $limitError) -ceq 'Morrow.WindowsNativeProcess.Jsonl.ResponseTooLarge'
  ) -Name 'responseLimitRejectsBeforeWriting'

  $stateOversized = New-ControllerOwnOperations
  $stateOversized.State.oversizedObservation = $true
  $oversizedStartId = 'e1e11111-1111-4111-8111-111111111111'
  $oversizedRun = Invoke-ControllerOwnMemoryRun -InputText ((New-ControllerOwnFrame -Operation start -RequestId $oversizedStartId) + "`n") `
    -Operations $stateOversized.Operations -CapsuleIdFactory (New-ControllerOwnCapsuleIdFactory -Ids @($capsuleOneId))
  $oversizedResponses = @(ConvertFrom-ControllerOwnResponses -Text $oversizedRun.Stdout)
  Assert-ControllerOwnCheck -Condition (
    $oversizedRun.ExitCode -ne 0 -and $oversizedResponses.Count -eq 1 -and
    [string]$oversizedResponses[0].requestId -ceq $oversizedStartId -and
    [string]$oversizedResponses[0].error.code -ceq 'ResponseTooLarge' -and
    [string]$oversizedResponses[0].cleanup.state -ceq 'confirmed' -and
    $stateOversized.State.disposes -eq 1 -and
    $script:Utf8.GetByteCount($oversizedRun.Stdout) -le 1048576 -and
    $oversizedRun.Stdout -notmatch 'xxxxxxxxxxxx|C:\\'
  ) -Name 'oversizedResponseCleansOwnCapsuleAndUsesSmallFallback'

  $stateManyMembers = New-ControllerOwnOperations
  $stateManyMembers.State.memberCount = 65
  $boundedInventoryStartId = 'e2e22222-2222-4222-8222-222222222222'
  $boundedInventoryRun = Invoke-ControllerOwnMemoryRun `
    -InputText ((New-ControllerOwnFrame -Operation start -RequestId $boundedInventoryStartId) + "`n") `
    -Operations $stateManyMembers.Operations `
    -CapsuleIdFactory (New-ControllerOwnCapsuleIdFactory -Ids @($capsuleOneId))
  $boundedInventoryResponses = @(ConvertFrom-ControllerOwnResponses -Text $boundedInventoryRun.Stdout)
  Assert-ControllerOwnCheck -Condition (
    $boundedInventoryRun.ExitCode -eq 0 -and $boundedInventoryResponses.Count -eq 1 -and
    [bool]$boundedInventoryResponses[0].ok -and
    [string]$boundedInventoryResponses[0].result.inventory.status -ceq 'partial' -and
    $boundedInventoryResponses[0].result.inventory.memberCountBefore -eq 65 -and
    $boundedInventoryResponses[0].result.inventory.members.Count -eq 64 -and
    $boundedInventoryRun.Stdout -notmatch 'secret'
  ) -Name 'oversizedInventoryIsMarkedPartialAndBounded'

  $unavailableObservation = New-ControllerOwnObservation -MemberCount 65
  $unavailableObservation.inventory.status = 'unavailable'
  $unavailableInventory = ConvertTo-PilotWindowsNativeProcessControllerInventory -Inventory $unavailableObservation.inventory
  Assert-ControllerOwnCheck -Condition (
    [string]$unavailableInventory.status -ceq 'unavailable' -and
    $unavailableInventory.memberCountBefore -eq 65 -and $unavailableInventory.members.Count -eq 64
  ) -Name 'unavailableInventoryStatusIsPreserved'

  if (-not $SyntheticOnly) {
  # Real Windows subprocess transport: PowerShell fixtures only, with a retained external observer.
  $readyPath = Join-Path $script:PrivateRoot 'owned-ready.txt'
  $childPidPath = Join-Path $script:PrivateRoot 'owned-child.pid'
  $childReadyPath = Join-Path $script:PrivateRoot 'owned-child-ready.txt'
  $stopPath = Join-Path $script:PrivateRoot 'owned-stop.txt'
  $outsiderReady = Join-Path $script:PrivateRoot 'outsider-ready.txt'
  $outsiderPid = Join-Path $script:PrivateRoot 'outsider.pid'
  $outsiderChildReady = Join-Path $script:PrivateRoot 'outsider-child-ready.txt'
  $outsiderStop = Join-Path $script:PrivateRoot 'outsider-stop.txt'
  $outsider = Start-ControllerOwnWorker -Role outsider -ReadyPath $outsiderReady -ChildPidPath $outsiderPid -ChildReadyPath $outsiderChildReady -StopPath $outsiderStop
  if (-not (Wait-ControllerOwnFile -Path $outsiderReady)) { throw 'Outsider fixture did not become ready.' }
  $outsiderHandle = Get-ControllerOwnProcessHandle -ProcessId $outsider.Id
  $controller = Start-ControllerOwnController
  $mismatchDescriptor = New-ControllerOwnExternalDescriptor -ControllerPid $controller.Id -WorkerScript $script:WorkerPath `
    -Role 'owned-live' -ReadyPath $readyPath -ChildPidPath $childPidPath -ChildReadyPath $childReadyPath -StopPath $stopPath
  $mismatchDescriptor.expectedParentProcessId = [int]$controller.Id + 1
  $mismatchId = [Guid]::NewGuid().ToString('D')
  $mismatchText = ConvertTo-Json -InputObject ([ordered]@{ version = 1; requestId = $mismatchId; operation = 'start'; descriptor = $mismatchDescriptor }) -Depth 12 -Compress
  $mismatchResponse = Send-ControllerOwnRequest -Process $controller -Json $mismatchText
  Assert-ControllerOwnResponse -Response $mismatchResponse -RequestId $mismatchId -ExpectedOk $false
  $script:Checks.externalStartIdentityMismatchAllowsRetry = (
    [string]$mismatchResponse.error.code -ceq 'IdentityMismatch' -and
    [string]$mismatchResponse.error.stage -ceq 'identity-comparison' -and
    [string]$mismatchResponse.cleanup.state -ceq 'confirmed' -and
    $mismatchResponse.cleanup.jobEmpty -eq $true -and $mismatchResponse.cleanup.rootExited -eq $true -and
    $mismatchResponse.cleanup.disposeFailed -eq $false -and -not [IO.File]::Exists($readyPath)
  )
  Assert-ControllerOwnCheck -Condition $script:Checks.externalStartIdentityMismatchAllowsRetry -Name 'externalStartIdentityMismatchAllowsRetry'
  $startRequestId = [Guid]::NewGuid().ToString('D')
  $startDescriptor = New-ControllerOwnExternalDescriptor -ControllerPid $controller.Id -WorkerScript $script:WorkerPath `
    -Role 'owned-live' -ReadyPath $readyPath -ChildPidPath $childPidPath -ChildReadyPath $childReadyPath -StopPath $stopPath
  $startText = ConvertTo-Json -InputObject ([ordered]@{ version = 1; requestId = $startRequestId; operation = 'start'; descriptor = $startDescriptor }) -Depth 12 -Compress
  if (-not $startText.Contains('雪')) { throw 'Unicode path was escaped or lost before the UTF-8 transport fixture.' }
  $startResponse = Send-ControllerOwnRequest -Process $controller -Json $startText
  Assert-ControllerOwnResponse -Response $startResponse -RequestId $startRequestId -ExpectedOk $true
  if ($startResponse.result.root.identity.creationTimeUtc -isnot [string]) {
    throw 'Wire timestamp was not preserved as its lexical JSON string.'
  }
  $capsuleId = [string]$startResponse.result.capsuleId
  $rootPid = [int]$startResponse.result.root.identity.processId
  if (-not (Wait-ControllerOwnFile -Path $readyPath) -or -not (Wait-ControllerOwnFile -Path $childReadyPath)) {
    throw 'Owned fixture tree did not become ready.'
  }
  $descendantPid = [int][IO.File]::ReadAllText($childPidPath)
  $rootHandle = Get-ControllerOwnProcessHandle -ProcessId $rootPid
  $descendantHandle = Get-ControllerOwnProcessHandle -ProcessId $descendantPid
  $observeId = [Guid]::NewGuid().ToString('D')
  $observeText = ConvertTo-Json -InputObject ([ordered]@{ version = 1; requestId = $observeId; operation = 'observe'; capsuleId = $capsuleId }) -Depth 8 -Compress
  $observeResponse = Send-ControllerOwnRequest -Process $controller -Json $observeText
  Assert-ControllerOwnResponse -Response $observeResponse -RequestId $observeId -ExpectedOk $true
  $observedPids = @($observeResponse.result.inventory.members | ForEach-Object { [int]$_.processId })
  if ($observedPids -notcontains $rootPid -or $observedPids -notcontains $descendantPid) {
    throw 'Controller did not report the synthetic root and descendant as evidence.'
  }
  $stopId = [Guid]::NewGuid().ToString('D')
  $stopText = ConvertTo-Json -InputObject ([ordered]@{ version = 1; requestId = $stopId; operation = 'stop'; capsuleId = $capsuleId }) -Depth 8 -Compress
  $stopResponse = Send-ControllerOwnRequest -Process $controller -Json $stopText
  Assert-ControllerOwnResponse -Response $stopResponse -RequestId $stopId -ExpectedOk $true
  if ([string]$stopResponse.cleanup.state -cne 'confirmed' -or -not [bool]$stopResponse.cleanup.jobEmpty -or -not [bool]$stopResponse.cleanup.rootExited) {
    throw 'Controller Stop did not return verified bounded cleanup.'
  }
  $controller.StandardInput.Close()
  if (-not $controller.WaitForExit(10000) -or $controller.ExitCode -ne 0) {
    throw 'Controller did not complete cleanly after EOF following Stop.'
  }
  $controllerStderrDrained = Complete-ControllerOwnStderrDrain -Process $controller -TimeoutMilliseconds 10000
  $controllerStderrDrainRepeat = Complete-ControllerOwnStderrDrain -Process $controller -TimeoutMilliseconds 10000
  if (-not $controllerStderrDrained -or -not $controllerStderrDrainRepeat) {
    throw 'Controller stderr drain was not completed idempotently after exit.'
  }
  $script:Checks.externalStartObserveStopOwnsOnlySyntheticProcesses = (
    (Test-ControllerOwnProcessesExited -Processes @($rootHandle, $descendantHandle)) -and
    -not (Test-ControllerOwnProcessesExited -Processes @($outsiderHandle) -TimeoutMilliseconds 0)
  )
  Assert-ControllerOwnCheck -Condition $script:Checks.externalStartObserveStopOwnsOnlySyntheticProcesses -Name 'externalStartObserveStopOwnsOnlySyntheticProcesses'

  # Send the partial frame immediately after Start; markers and retained handles are collected within half its deadline.
  $deadlineReady = Join-Path $script:PrivateRoot 'deadline-ready.txt'
  $deadlineChildPidPath = Join-Path $script:PrivateRoot 'deadline-child.pid'
  $deadlineChildReady = Join-Path $script:PrivateRoot 'deadline-child-ready.txt'
  $deadlineStop = Join-Path $script:PrivateRoot 'deadline-stop.txt'
  $deadlineFrameTimeoutMilliseconds = 10000
  $deadlineController = Start-ControllerOwnController -FrameTimeoutMilliseconds $deadlineFrameTimeoutMilliseconds
  $deadlineDescriptor = New-ControllerOwnExternalDescriptor -ControllerPid $deadlineController.Id -WorkerScript $script:WorkerPath `
    -Role 'owned-live' -ReadyPath $deadlineReady -ChildPidPath $deadlineChildPidPath -ChildReadyPath $deadlineChildReady -StopPath $deadlineStop
  $deadlineStartId = [Guid]::NewGuid().ToString('D')
  $deadlineStartText = ConvertTo-Json -InputObject ([ordered]@{ version = 1; requestId = $deadlineStartId; operation = 'start'; descriptor = $deadlineDescriptor }) -Depth 12 -Compress
  $deadlineStartResponse = Send-ControllerOwnRequest -Process $deadlineController -Json $deadlineStartText
  Assert-ControllerOwnResponse -Response $deadlineStartResponse -RequestId $deadlineStartId -ExpectedOk $true
  $deadlineAfterStart = [Diagnostics.Stopwatch]::StartNew()
  $deadlineRootHandle = Get-ControllerOwnProcessHandle -ProcessId ([int]$deadlineStartResponse.result.root.identity.processId)
  $deadlineLineTask = $deadlineController.StandardOutput.ReadLineAsync()
  $deadlineController.StandardInput.Write('{"version":1,"requestId":"f4f44444')
  $deadlineController.StandardInput.Flush()
  $partialSentMilliseconds = $deadlineAfterStart.ElapsedMilliseconds
  if ($partialSentMilliseconds -ge ($deadlineFrameTimeoutMilliseconds / 2)) {
    throw 'Partial frame was sent too late to distinguish its deadline from a timeout that had already elapsed.'
  }
  $markerDeadline = [DateTime]::UtcNow.AddMilliseconds($deadlineFrameTimeoutMilliseconds / 2)
  while ((-not [IO.File]::Exists($deadlineChildPidPath) -or -not [IO.File]::Exists($deadlineChildReady)) -and
      [DateTime]::UtcNow -lt $markerDeadline) {
    Start-Sleep -Milliseconds 20
  }
  if (-not [IO.File]::Exists($deadlineChildPidPath) -or -not [IO.File]::Exists($deadlineChildReady)) {
    throw 'Deadline fixture descendant was not observable before half the frame deadline.'
  }
  $deadlineDescendantHandle = Get-ControllerOwnProcessHandle -ProcessId ([int][IO.File]::ReadAllText($deadlineChildPidPath))
  if ($deadlineAfterStart.ElapsedMilliseconds -ge $deadlineFrameTimeoutMilliseconds) {
    throw 'Synthetic process handles were not retained before the controller frame deadline.'
  }
  if (-not $deadlineLineTask.Wait([TimeSpan]::FromSeconds(25))) { throw 'Controller did not expire the partial frame.' }
  $deadlineLine = $deadlineLineTask.GetAwaiter().GetResult()
  $deadlineResponse = ConvertFrom-Json -InputObject $deadlineLine -AsHashtable -Depth 16 -DateKind String
  Assert-ControllerOwnResponse -Response $deadlineResponse -RequestId $null -ExpectedOk $false
  if (-not $deadlineController.WaitForExit(15000)) { throw 'Controller did not exit after the frame deadline.' }
  $deadlineStderrDrained = Complete-ControllerOwnStderrDrain -Process $deadlineController -TimeoutMilliseconds 10000
  Assert-ControllerOwnCheck -Condition (
    $deadlineStderrDrained -and
    $deadlineResponse['requestId'] -eq $null -and [string]$deadlineResponse['error']['code'] -ceq 'DeadlineExceeded' -and
    [string]$deadlineResponse['cleanup']['state'] -ceq 'confirmed' -and
    $deadlineResponse['cleanup']['jobEmpty'] -eq $true -and $deadlineResponse['cleanup']['rootExited'] -eq $true -and
    $script:Utf8.GetByteCount($deadlineLine + "`n") -le 1048576 -and
    (Test-ControllerOwnProcessesExited -Processes @($deadlineRootHandle, $deadlineDescendantHandle)) -and
    -not (Test-ControllerOwnProcessesExited -Processes @($outsiderHandle) -TimeoutMilliseconds 0) -and
    $deadlineController.ExitCode -ne 0
  ) -Name 'externalDeadlineCleansOwnCapsule'

  # Abrupt controller exit must release only its retained Job; the observer holds exact process handles.
  [IO.File]::Delete($readyPath); [IO.File]::Delete($childPidPath); [IO.File]::Delete($childReadyPath); [IO.File]::Delete($stopPath)
  $abruptController = Start-ControllerOwnController -FrameTimeoutMilliseconds 120000
  $abruptReady = Join-Path $script:PrivateRoot 'abrupt-ready.txt'
  $abruptChildPid = Join-Path $script:PrivateRoot 'abrupt-child.pid'
  $abruptChildReady = Join-Path $script:PrivateRoot 'abrupt-child-ready.txt'
  $abruptStop = Join-Path $script:PrivateRoot 'abrupt-stop.txt'
  $abruptDescriptor = New-ControllerOwnExternalDescriptor -ControllerPid $abruptController.Id -WorkerScript $script:WorkerPath `
    -Role 'owned-live' -ReadyPath $abruptReady -ChildPidPath $abruptChildPid -ChildReadyPath $abruptChildReady -StopPath $abruptStop
  $abruptStartId = [Guid]::NewGuid().ToString('D')
  $abruptStartText = ConvertTo-Json -InputObject ([ordered]@{ version = 1; requestId = $abruptStartId; operation = 'start'; descriptor = $abruptDescriptor }) -Depth 12 -Compress
  $abruptStartResponse = Send-ControllerOwnRequest -Process $abruptController -Json $abruptStartText
  Assert-ControllerOwnResponse -Response $abruptStartResponse -RequestId $abruptStartId -ExpectedOk $true
  if (-not (Wait-ControllerOwnFile -Path $abruptReady) -or -not (Wait-ControllerOwnFile -Path $abruptChildReady)) {
    throw 'Abrupt-exit fixture tree did not become ready.'
  }
  $abruptRootPid = [int]$abruptStartResponse.result.root.identity.processId
  $abruptDescendantPid = [int][IO.File]::ReadAllText($abruptChildPid)
  $abruptRootHandle = Get-ControllerOwnProcessHandle -ProcessId $abruptRootPid
  $abruptDescendantHandle = Get-ControllerOwnProcessHandle -ProcessId $abruptDescendantPid
  $abruptControllerHandle = Get-ControllerOwnProcessHandle -ProcessId $abruptController.Id
  $abruptController.Kill()
  if (-not $abruptController.WaitForExit(10000)) { throw 'Controller process did not exit after the external kill.' }
  $abruptStderrDrained = Complete-ControllerOwnStderrDrain -Process $abruptController -TimeoutMilliseconds 10000
  $script:Checks.externalAbruptExitCleansOwnJobAndPreservesOutsider = (
    $abruptStderrDrained -and
    (Test-ControllerOwnProcessesExited -Processes @($abruptRootHandle, $abruptDescendantHandle)) -and
    (Test-ControllerOwnProcessesExited -Processes @($abruptControllerHandle) -TimeoutMilliseconds 0) -and
    -not (Test-ControllerOwnProcessesExited -Processes @($outsiderHandle) -TimeoutMilliseconds 0)
  )
  Assert-ControllerOwnCheck -Condition $script:Checks.externalAbruptExitCleansOwnJobAndPreservesOutsider -Name 'externalAbruptExitCleansOwnJobAndPreservesOutsider'

  [IO.File]::WriteAllText($outsiderStop, 'finish', $script:Utf8)
  if (-not (Test-ControllerOwnProcessesExited -Processes @($outsiderHandle) -TimeoutMilliseconds 10000)) {
    throw 'Outsider fixture did not stop after its own marker.'
  }
  $outsiderStderrDrained = Complete-ControllerOwnStderrDrain -Process $outsider -TimeoutMilliseconds 10000
  $outsiderStderrDrainRepeat = Complete-ControllerOwnStderrDrain -Process $outsider -TimeoutMilliseconds 10000
  $externalDrainStatesBounded = @(
    (Test-ControllerOwnStderrDrainState -Process $controller),
    (Test-ControllerOwnStderrDrainState -Process $deadlineController),
    (Test-ControllerOwnStderrDrainState -Process $abruptController),
    (Test-ControllerOwnStderrDrainState -Process $outsider)
  ) | Where-Object { $_ }
  $script:Checks.externalStderrDrainsAreRecoveredOnce = (
    $controllerStderrDrained -and $controllerStderrDrainRepeat -and
    $deadlineStderrDrained -and $abruptStderrDrained -and
    $outsiderStderrDrained -and $outsiderStderrDrainRepeat -and $externalDrainStatesBounded.Count -eq 4
  )
  Assert-ControllerOwnCheck -Condition $script:Checks.externalStderrDrainsAreRecoveredOnce -Name 'externalStderrDrainsAreRecoveredOnce'
  $script:Checks.threeRedirectedPipesAreRequired = (
    (Test-PilotWindowsNativeProcessControllerPipeState -InputRedirected $true -OutputRedirected $true -ErrorRedirected $true) -and
    -not (Test-PilotWindowsNativeProcessControllerPipeState -InputRedirected $true -OutputRedirected $true -ErrorRedirected $false) -and
    -not (Test-PilotWindowsNativeProcessControllerPipeState -InputRedirected $true -OutputRedirected $false -ErrorRedirected $true) -and
    -not (Test-PilotWindowsNativeProcessControllerPipeState -InputRedirected $false -OutputRedirected $true -ErrorRedirected $true)
  )
  Assert-ControllerOwnCheck -Condition $script:Checks.threeRedirectedPipesAreRequired -Name 'threeRedirectedPipesAreRequired'
  }

  $evidence = [ordered]@{
    issue = 247
    runId = $script:RunId
    mode = if ($SyntheticOnly) { 'synthetic-only' } else { 'windows' }
    startedUtc = $script:StartedUtc
    completedUtc = [DateTime]::UtcNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    source = [ordered]@{
      controllerSha256 = (Get-FileHash -LiteralPath $script:ControllerPath -Algorithm SHA256).Hash.ToLowerInvariant()
      ownTestSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
      readerSha256 = (Get-FileHash -LiteralPath $script:ReaderPath -Algorithm SHA256).Hash.ToLowerInvariant()
      policySha256 = (Get-FileHash -LiteralPath $script:PolicyPath -Algorithm SHA256).Hash.ToLowerInvariant()
      helperSha256 = $baselineHelperHashes
      stagedPwshSha256 = $script:PwshHash
    }
    checks = $script:Checks
    failures = @($script:Failures)
    noProductDriverOrGuiStarted = $true
  }
  $evidencePath = Join-Path $script:EvidenceFullPath 'controller-own.json'
  if (-not $script:EvidenceWriteReady -or $null -eq $script:EvidenceReceiptStream -or -not $script:EvidenceReceiptStream.CanWrite) {
    throw 'Evidence receipt was not exclusively reserved.'
  }
  $evidenceBytes = $script:Utf8.GetBytes((ConvertTo-Json -InputObject $evidence -Depth 16))
  $script:EvidenceReceiptStream.Write($evidenceBytes, 0, $evidenceBytes.Length)
  $script:EvidenceReceiptStream.Flush()
  $script:EvidenceReceiptStream.Dispose()
  $script:EvidenceReceiptStream = $null
  if ($script:Failures.Count -gt 0) { throw 'One or more acceptance checks failed.' }
  Write-Output ('PASS issue=247 ownChecks=' + @($script:Checks.Keys | Where-Object { $script:Checks[$_] }).Count + ' evidence=' + $evidencePath)
} catch {
  $script:Failures.Add($_.Exception.GetType().Name)
  $failure = [ordered]@{
    issue = 247
    runId = $script:RunId
    startedUtc = $script:StartedUtc
    failedUtc = [DateTime]::UtcNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    failureType = $_.Exception.GetType().FullName
    checks = $script:Checks
    failures = @($script:Failures)
  }
  if ($script:EvidenceWriteReady -and $null -ne $script:EvidenceFullPath -and [IO.Directory]::Exists($script:EvidenceFullPath)) {
    try {
      if ($null -ne $script:EvidenceReceiptStream) {
        $script:EvidenceReceiptStream.Dispose()
        $script:EvidenceReceiptStream = $null
      }
      $failurePath = Join-Path $script:EvidenceFullPath 'controller-own-failure.json'
      $failureStream = [IO.FileStream]::new(
        $failurePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read
      )
      try {
        $failureBytes = $script:Utf8.GetBytes((ConvertTo-Json -InputObject $failure -Depth 12))
        $failureStream.Write($failureBytes, 0, $failureBytes.Length)
        $failureStream.Flush()
      } finally { $failureStream.Dispose() }
    } catch { }
  }
  throw
} finally {
  if ($null -ne $script:EvidenceReceiptStream) { try { $script:EvidenceReceiptStream.Dispose() } catch { } }
  foreach ($process in $script:TrackedProcesses) {
    try {
      if (-not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(10000) }
    } catch { }
    try { $null = Complete-ControllerOwnStderrDrain -Process $process -TimeoutMilliseconds 1000 } catch { }
    try { $process.Dispose() } catch { }
  }
  foreach ($retainedProcess in $script:HeldProcessHandles) { try { $retainedProcess.Handle.Dispose() } catch { } }
  if ($null -ne $script:PrivateRoot -and [IO.Directory]::Exists($script:PrivateRoot)) {
    try { Remove-Item -LiteralPath $script:PrivateRoot -Recurse -Force -ErrorAction Stop } catch { }
  }
}
