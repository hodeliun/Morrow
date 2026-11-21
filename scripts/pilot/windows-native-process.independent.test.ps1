[CmdletBinding()]
param(
  [Parameter(Mandatory)][string] $EvidenceRoot,
  [string] $ReaderPath = (Join-Path $PSScriptRoot 'windows-native-process.ps1')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:CaseResults = [Collections.Generic.List[object]]::new()
$script:CaseFailures = [Collections.Generic.List[string]]::new()
$script:ReaderImportOutput = @()
$script:ReaderSha256 = $null
$script:EvidenceFullPath = $null
$script:EvidenceCreated = $false
$script:ResolvedReaderPath = $null
$script:StartedUtc = [DateTime]::UtcNow
$script:Clock = [Diagnostics.Stopwatch]::StartNew()
$script:ErrorIdKey = 'Morrow.WindowsNativeProcess.Jsonl.ErrorId'
$script:DiagnosticsKey = 'Morrow.WindowsNativeProcess.Jsonl.Diagnostics'
$script:ErrorPrefix = 'Morrow.WindowsNativeProcess.Jsonl.'
$script:Utf8Strict = [System.Text.UTF8Encoding]::new($false, $true)
$script:Lf = [string][char]10
$script:CrLf = [string][char]13 + [string][char]10

function Add-JsonlTestStreamType {
  if ('Morrow.Pilot.JsonlIndependent.ChunkedStream' -as [type]) { return }

  $typeDefinition = @'
using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace Morrow.Pilot.JsonlIndependent
{
    public sealed class ChunkedStream : Stream
    {
        private readonly byte[] _source;
        private readonly int _maxChunkBytes;
        private readonly int _delayPerReadMilliseconds;
        private readonly int _failAfterRead;
        private readonly string _failureMessage;
        private int _position;
        private int _readCalls;
        private int _asyncReadCalls;
        private int _syncReadCalls;
        private int _bytesServed;
        private bool _disposed;

        public ChunkedStream(byte[] source, int maxChunkBytes, int delayPerReadMilliseconds, int failAfterRead, string failureMessage)
        {
            _source = source ?? Array.Empty<byte>();
            _maxChunkBytes = maxChunkBytes <= 0 ? Int32.MaxValue : maxChunkBytes;
            _delayPerReadMilliseconds = Math.Max(0, delayPerReadMilliseconds);
            _failAfterRead = failAfterRead;
            _failureMessage = failureMessage ?? "synthetic read failure";
        }

        public int ReadCalls => Volatile.Read(ref _readCalls);
        public int AsyncReadCalls => Volatile.Read(ref _asyncReadCalls);
        public int SyncReadCalls => Volatile.Read(ref _syncReadCalls);
        public int BytesServed => Volatile.Read(ref _bytesServed);

        public override bool CanRead => !_disposed;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => _source.Length;
        public override long Position
        {
            get => _position;
            set => throw new NotSupportedException();
        }

        public override void Flush() { }

        public override int Read(byte[] buffer, int offset, int count)
        {
            Interlocked.Increment(ref _syncReadCalls);
            int readCount = Interlocked.Increment(ref _readCalls);
            return CopyBytes(buffer, offset, count, readCount);
        }

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            return ReadAsyncCore(buffer, offset, count, cancellationToken);
        }

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            return new ValueTask<int>(ReadAsyncMemoryCore(buffer, cancellationToken));
        }

        private async Task<int> ReadAsyncCore(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _asyncReadCalls);
            int readCount = Interlocked.Increment(ref _readCalls);
            if (_failAfterRead >= 0 && readCount > _failAfterRead)
            {
                throw new IOException(_failureMessage);
            }
            if (_delayPerReadMilliseconds > 0)
            {
                await Task.Delay(_delayPerReadMilliseconds, cancellationToken).ConfigureAwait(false);
            }
            cancellationToken.ThrowIfCancellationRequested();
            return CopyBytes(buffer, offset, count, 0);
        }

        private async Task<int> ReadAsyncMemoryCore(Memory<byte> buffer, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _asyncReadCalls);
            int readCount = Interlocked.Increment(ref _readCalls);
            if (_failAfterRead >= 0 && readCount > _failAfterRead)
            {
                throw new IOException(_failureMessage);
            }
            if (_delayPerReadMilliseconds > 0)
            {
                await Task.Delay(_delayPerReadMilliseconds, cancellationToken).ConfigureAwait(false);
            }
            cancellationToken.ThrowIfCancellationRequested();

            int available = Math.Max(0, _source.Length - _position);
            int count = Math.Min(Math.Min(buffer.Length, _maxChunkBytes), available);
            if (count > 0)
            {
                _source.AsMemory(_position, count).CopyTo(buffer);
                _position += count;
                Interlocked.Add(ref _bytesServed, count);
            }
            return count;
        }

        private int CopyBytes(byte[] buffer, int offset, int count, int readCount)
        {
            if (_disposed) throw new ObjectDisposedException(nameof(ChunkedStream));
            if (readCount > 0 && _failAfterRead >= 0 && readCount > _failAfterRead)
            {
                throw new IOException(_failureMessage);
            }
            int available = Math.Max(0, _source.Length - _position);
            int copied = Math.Min(Math.Min(count, _maxChunkBytes), available);
            if (copied > 0)
            {
                Buffer.BlockCopy(_source, _position, buffer, offset, copied);
                _position += copied;
                Interlocked.Add(ref _bytesServed, copied);
            }
            return copied;
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            _disposed = true;
            base.Dispose(disposing);
        }
    }
}
'@

  $null = Add-Type -TypeDefinition $typeDefinition -Language CSharp -ErrorAction Stop
}

function Assert-TestCondition {
  param(
    [Parameter(Mandatory)][bool] $Condition,
    [Parameter(Mandatory)][string] $Name
  )
  if (-not $Condition) { throw [InvalidOperationException]::new("Assertion:$Name") }
}

function Get-ErrorIdFromRecord {
  param([AllowNull()][object] $Record)

  $exception = if ($null -ne $Record -and $Record.PSObject.Properties['Exception']) {
    $Record.Exception
  } else {
    $Record
  }
  while ($null -ne $exception) {
    try {
      if ($null -ne $exception.Data -and $exception.Data.Contains($script:ErrorIdKey)) {
        return [string]$exception.Data[$script:ErrorIdKey]
      }
    } catch { }
    $exception = $exception.InnerException
  }
  return $null
}

function Get-ErrorDiagnosticsFromRecord {
  param([AllowNull()][object] $Record)

  $exception = if ($null -ne $Record -and $Record.PSObject.Properties['Exception']) {
    $Record.Exception
  } else {
    $Record
  }
  while ($null -ne $exception) {
    try {
      if ($null -ne $exception.Data -and $exception.Data.Contains($script:DiagnosticsKey)) {
        return ,$exception.Data[$script:DiagnosticsKey]
      }
    } catch { }
    $exception = $exception.InnerException
  }
  return $null
}

function Get-ObjectPropertyNames {
  param([AllowNull()][object] $Value)

  if ($null -eq $Value) { return @() }
  if ($Value -is [System.Collections.IDictionary]) { return @($Value.Keys | ForEach-Object { [string]$_ }) }
  return @($Value.PSObject.Properties | ForEach-Object { [string]$_.Name })
}

function Get-ObjectPropertyValue {
  param(
    [AllowNull()][object] $Value,
    [Parameter(Mandatory)][string] $Name
  )

  if ($null -eq $Value) { return $null }
  if ($Value -is [System.Collections.IDictionary]) {
    if ($Value.Contains($Name)) { return ,$Value[$Name] }
    return $null
  }
  $property = $Value.PSObject.Properties[$Name]
  if ($null -ne $property) { return ,$property.Value }
  return $null
}

function Get-ErrorCodeSuffix {
  param([AllowNull()][object] $Record)
  $errorId = Get-ErrorIdFromRecord -Record $Record
  if ([string]::IsNullOrEmpty($errorId)) { return 'HarnessAssertion' }
  if (-not $errorId.StartsWith($script:ErrorPrefix, [StringComparison]::Ordinal)) { return 'UnexpectedErrorId' }
  return $errorId.Substring($script:ErrorPrefix.Length)
}

function Assert-ExpectedReaderError {
  param(
    [Parameter(Mandatory)][object] $ReaderContext,
    [Parameter(Mandatory)][string] $ExpectedSuffix,
    [AllowNull()][string] $Canary
  )

  $caught = $null
  $capturedOutput = @()
  try {
    $capturedOutput = @(Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $ReaderContext 3>&1 4>&1 5>&1 6>&1)
  } catch {
    $caught = $_
  }
  Assert-TestCondition -Condition ($capturedOutput.Count -eq 0) -Name "UnexpectedOutputOnError:$ExpectedSuffix"
  Assert-TestCondition -Condition ($null -ne $caught) -Name "ExpectedError:$ExpectedSuffix"
  $errorId = Get-ErrorIdFromRecord -Record $caught
  Assert-TestCondition -Condition ($errorId -ceq ($script:ErrorPrefix + $ExpectedSuffix)) -Name "ErrorCode:$ExpectedSuffix"

  $exception = $caught.Exception
  $diagnostics = Get-ErrorDiagnosticsFromRecord -Record $caught
  Assert-TestCondition -Condition ($null -ne $diagnostics) -Name "DiagnosticsPresent:$ExpectedSuffix"
  $diagnosticNames = @(Get-ObjectPropertyNames -Value $diagnostics | Sort-Object)
  Assert-TestCondition -Condition ([string]::Join('|', $diagnosticNames) -ceq 'fields|stage') -Name "DiagnosticsShape:$ExpectedSuffix"

  $stage = Get-ObjectPropertyValue -Value $diagnostics -Name 'stage'
  $fields = Get-ObjectPropertyValue -Value $diagnostics -Name 'fields'
  Assert-TestCondition -Condition ($stage -is [string] -and $stage -cmatch '\A[A-Za-z0-9-]{1,64}\z') -Name "DiagnosticsStage:$ExpectedSuffix"
  foreach ($field in $fields) {
    Assert-TestCondition -Condition ($field -is [string] -and $field -cmatch '\A[A-Za-z][A-Za-z0-9]{0,63}\z') -Name "DiagnosticsField:$ExpectedSuffix"
  }

  $dataNames = @($exception.Data.Keys | ForEach-Object { [string]$_ } | Sort-Object)
  $allowedDataNames = @($script:DiagnosticsKey, $script:ErrorIdKey) | Sort-Object
  Assert-TestCondition -Condition ([string]::Join('|', $dataNames) -ceq [string]::Join('|', $allowedDataNames)) -Name "ExceptionDataKeys:$ExpectedSuffix"

  if (-not [string]::IsNullOrEmpty($Canary)) {
    $safeText = [string]::Concat(
      $errorId,
      [string]$exception.Message,
      (ConvertTo-Json -InputObject $diagnostics -Depth 8 -Compress),
      [string]$caught.TargetObject,
      [string]$caught.ErrorDetails
    )
    Assert-TestCondition -Condition (-not $safeText.Contains($Canary, [StringComparison]::Ordinal)) -Name "NoRawCanary:$ExpectedSuffix"
  }
  return $caught
}

function New-TestHarness {
  param(
    [Parameter(Mandatory)][AllowEmptyCollection()][byte[]] $Bytes,
    [int] $MaxChunkBytes = 4096,
    [int] $DelayPerReadMilliseconds = 0,
    [int] $FailAfterRead = -1,
    [string] $FailureMessage = 'synthetic read failure',
    [int] $FrameTimeoutMilliseconds = 120000
  )

  $stream = [Morrow.Pilot.JsonlIndependent.ChunkedStream]::new($Bytes, $MaxChunkBytes, $DelayPerReadMilliseconds, $FailAfterRead, $FailureMessage)
  $context = New-PilotWindowsNativeProcessJsonlReaderContext -Stream $stream -FrameTimeoutMilliseconds $FrameTimeoutMilliseconds
  return [pscustomobject]@{ Stream = $stream; Context = $context }
}

function Get-FrameBytes {
  param(
    [Parameter(Mandatory)][string] $Text,
    [string] $Terminator = ([string][char]10)
  )
  $body = $script:Utf8Strict.GetBytes($Text)
  $ending = $script:Utf8Strict.GetBytes($Terminator)
  $bytes = [byte[]]::new($body.Length + $ending.Length)
  if ($body.Length -gt 0) { [Array]::Copy($body, 0, $bytes, 0, $body.Length) }
  if ($ending.Length -gt 0) { [Array]::Copy($ending, 0, $bytes, $body.Length, $ending.Length) }
  return ,$bytes
}

function Get-CombinedFrameBytes {
  param([Parameter(Mandatory)][string[]] $Frames)
  return ,$script:Utf8Strict.GetBytes([string]::Join('', $Frames))
}

function New-ValidDescriptor {
  param([string] $PathValue = 'PATH-SENTINEL-246')

  return [ordered]@{
    executablePath = 'C:\synthetic\pilot.exe'
    executableSha256 = ('A' * 64)
    argumentList = @('synthetic-arg', 'unicode-☃-🧪')
    workingDirectory = 'C:\synthetic\work'
    profilePath = 'C:\synthetic\profile'
    environment = [ordered]@{
      SYSTEMROOT = 'C:\Windows'
      WINDIR = 'C:\Windows'
      PATH = $PathValue
      USERPROFILE = 'C:\synthetic\user'
      APPDATA = 'C:\synthetic\appdata'
      LOCALAPPDATA = 'C:\synthetic\localappdata'
      TEMP = 'C:\synthetic\temp'
      TMP = 'C:\synthetic\tmp'
    }
    expectedParentProcessId = [long]4321
    expectedOwnerSid = 'S-1-5-18'
  }
}

function New-RequestJson {
  param(
    [Parameter(Mandatory)][ValidateSet('start', 'observe', 'stop')][string] $Operation,
    [Parameter(Mandatory)][string] $RequestId,
    [switch] $IncludeAssertion,
    [switch] $IncludeTimeout,
    [long] $TimeoutMilliseconds = 0,
    [string] $CapsuleId = 'EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE'
  )

  $request = [ordered]@{
    version = [long]1
    requestId = $RequestId
    operation = $Operation
  }
  if ($Operation -ceq 'start') {
    $request.descriptor = New-ValidDescriptor
  } else {
    $request.capsuleId = $CapsuleId
    if ($IncludeAssertion) {
      $request.identityAssertion = [ordered]@{
        processId = [long]123
        ownerSid = 'S-1-5-18'
      }
    }
    if ($Operation -ceq 'stop' -and $IncludeTimeout) { $request.timeoutMs = $TimeoutMilliseconds }
  }
  return [string](ConvertTo-Json -InputObject $request -Depth 16 -Compress)
}

function Read-OneRequest {
  param([Parameter(Mandatory)][object] $ReaderContext)
  $request = Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $ReaderContext
  Assert-TestCondition -Condition ($null -ne $request) -Name 'UnexpectedCleanEof'
  Assert-TestCondition -Condition ($request -is [System.Collections.IDictionary]) -Name 'RequestIsNotDictionary'
  return ,$request
}

function Assert-RequestBasics {
  param(
    [Parameter(Mandatory)][System.Collections.IDictionary] $Request,
    [Parameter(Mandatory)][string] $RequestId,
    [Parameter(Mandatory)][string] $Operation
  )
  Assert-TestCondition -Condition ($Request.ContainsKey('version')) -Name 'VersionMissing'
  Assert-TestCondition -Condition ($Request['version'] -is [long] -and [long]$Request['version'] -eq 1) -Name 'VersionNotInt64One'
  Assert-TestCondition -Condition ($Request.ContainsKey('requestId') -and [string]$Request['requestId'] -ceq $RequestId) -Name 'OriginalRequestIdNotPreserved'
  Assert-TestCondition -Condition ($Request.ContainsKey('operation') -and [string]$Request['operation'] -ceq $Operation) -Name 'OperationNotPreserved'
  Assert-TestCondition -Condition (-not $Request.ContainsKey('RequestId') -and -not $Request.ContainsKey('Version')) -Name 'RootDictionaryNotOrdinal'
}

function Invoke-TestCase {
  param(
    [Parameter(Mandatory)][string] $Name,
    [Parameter(Mandatory)][scriptblock] $Action
  )

  try {
    & $Action | Out-Null
    [void]$script:CaseResults.Add([ordered]@{ name = $Name; status = 'passed'; code = $null })
  } catch {
    $suffix = Get-ErrorCodeSuffix -Record $_
    [void]$script:CaseFailures.Add($Name)
    [void]$script:CaseResults.Add([ordered]@{ name = $Name; status = 'failed'; code = $suffix })
  }
}

function New-RawObserveJson {
  param(
    [Parameter(Mandatory)][string] $RequestId,
    [string] $CapsuleJson = '"EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE"'
  )
  return '{"version":1,"requestId":"' + $RequestId + '","operation":"observe","capsuleId":' + $CapsuleJson + '}'
}

function Assert-JsonlReaderCase {
  param(
    [Parameter(Mandatory)][string] $Name,
    [Parameter(Mandatory)][string] $Json,
    [Parameter(Mandatory)][string] $ExpectedSuffix,
    [string] $Terminator = ([string][char]10),
    [int] $MaxChunkBytes = 4096,
    [string] $Canary = ''
  )

  $harness = New-TestHarness -Bytes (Get-FrameBytes -Text $Json -Terminator $Terminator) -MaxChunkBytes $MaxChunkBytes
  try {
    $null = Assert-ExpectedReaderError -ReaderContext $harness.Context -ExpectedSuffix $ExpectedSuffix -Canary $Canary
  } finally {
    $harness.Stream.Dispose()
  }
}

function Invoke-ReaderCases {
  $guidA = [Guid]::ParseExact('A1111111-2222-3333-4444-555555555555', 'D').ToString('D').ToUpperInvariant()
  $guidB = 'b2222222-3333-4444-5555-666666666666'
  $guidC = 'c3333333-4444-5555-6666-777777777777'

  Invoke-TestCase -Name 'pure-dot-source-and-static-no-native-calls' -Action {
    Assert-TestCondition -Condition ($script:ReaderImportOutput.Count -eq 0) -Name 'DotSourceWroteOutput'
    foreach ($functionName in @(
        'New-PilotWindowsNativeProcessJsonlReaderContext',
        'Read-PilotWindowsNativeProcessJsonlRequest'
      )) {
      Assert-TestCondition -Condition ($null -ne (Get-Command $functionName -ErrorAction SilentlyContinue)) -Name "FunctionMissing:$functionName"
    }

    $tokens = $null
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($script:ResolvedReaderPath, [ref]$tokens, [ref]$parseErrors)
    Assert-TestCondition -Condition (@($parseErrors).Count -eq 0) -Name 'ReaderAstHasParseErrors'
    $forbiddenCommands = @(
      'Start-WindowsNativeProcess', 'Observe-WindowsNativeProcess', 'Stop-WindowsNativeProcess',
      'CreateAtomicSuspendedRoot', 'Get-CimInstance', 'Invoke-CimMethod', 'Start-Process'
    )
    $commandNodes = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] }, $true))
    foreach ($node in $commandNodes) {
      $commandName = $node.GetCommandName()
      Assert-TestCondition -Condition ($commandName -notin $forbiddenCommands) -Name "ForbiddenCommand:$commandName"
    }
  }

  Invoke-TestCase -Name 'valid-start-preserves-structured-values-with-one-byte-reads' -Action {
    $id = $guidA
    $json = New-RequestJson -Operation start -RequestId $id
    Assert-TestCondition -Condition ($json.Contains('☃') -and $json.Contains('🧪')) -Name 'UnicodeFixtureNotEncodedAsMultibyte'
    $harness = New-TestHarness -Bytes (Get-FrameBytes -Text $json -Terminator $script:CrLf) -MaxChunkBytes 1
    try {
      $request = Read-OneRequest -ReaderContext $harness.Context
      Assert-RequestBasics -Request $request -RequestId $id -Operation 'start'
      Assert-TestCondition -Condition ($request['descriptor'] -is [System.Collections.IDictionary]) -Name 'DescriptorNotDictionary'
      Assert-TestCondition -Condition ($request['descriptor'].ContainsKey('environment')) -Name 'EnvironmentMissing'
      $descriptor = $request['descriptor']
      Assert-TestCondition -Condition ($descriptor['environment'] -is [System.Collections.IDictionary]) -Name 'EnvironmentNotDictionary'
      Assert-TestCondition -Condition ($descriptor['argumentList'] -is [object[]]) -Name 'ArgumentListNotObjectArray'
      Assert-TestCondition -Condition ([string]$descriptor['environment']['PATH'] -ceq 'PATH-SENTINEL-246') -Name 'ValidatorMutatedStructuredEnvironment'
      Assert-TestCondition -Condition ([string]$descriptor['executableSha256'] -ceq ('A' * 64)) -Name 'ValidatorMutatedOriginalHashCase'
      Assert-TestCondition -Condition ($descriptor['expectedParentProcessId'] -is [long]) -Name 'ExpectedParentPidNotInt64'
      Assert-TestCondition -Condition ([string]$descriptor['argumentList'][1] -ceq 'unicode-☃-🧪') -Name 'SplitMultibyteTextChanged'
      Assert-TestCondition -Condition ($harness.Stream.SyncReadCalls -eq 0 -and $harness.Stream.AsyncReadCalls -gt 0) -Name 'ReaderDidNotUseAsyncStream'
      Assert-TestCondition -Condition ($null -eq (Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $harness.Context)) -Name 'EofAfterValidFrameNotNull'
    } finally {
      $harness.Stream.Dispose()
    }
  }

  Invoke-TestCase -Name 'one-read-remainder-and-following-crlf-frame-preserved' -Action {
    $firstId = $guidB
    $secondId = $guidC.ToUpperInvariant()
    $first = (New-RequestJson -Operation observe -RequestId $firstId) + $script:Lf
    $second = (New-RequestJson -Operation stop -RequestId $secondId -IncludeAssertion -IncludeTimeout -TimeoutMilliseconds 120000) + $script:CrLf
    $harness = New-TestHarness -Bytes (Get-CombinedFrameBytes -Frames @($first, $second)) -MaxChunkBytes 4096
    try {
      $one = Read-OneRequest -ReaderContext $harness.Context
      $two = Read-OneRequest -ReaderContext $harness.Context
      Assert-RequestBasics -Request $one -RequestId $firstId -Operation 'observe'
      Assert-RequestBasics -Request $two -RequestId $secondId -Operation 'stop'
      Assert-TestCondition -Condition ($two['timeoutMs'] -is [long] -and [long]$two['timeoutMs'] -eq 120000) -Name 'TimeoutNotInt64Max'
      Assert-TestCondition -Condition ([string]$two['capsuleId'] -ceq 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee') -Name 'OpaqueCapsuleIdChanged'
      Assert-TestCondition -Condition ($two['identityAssertion'] -is [System.Collections.IDictionary]) -Name 'AssertionNotDictionary'
      Assert-TestCondition -Condition ($null -eq (Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $harness.Context)) -Name 'BufferedFramesDidNotReachCleanEof'
    } finally {
      $harness.Stream.Dispose()
    }
  }

  Invoke-TestCase -Name 'empty-stream-eof-is-null-and-repeatable' -Action {
    $harness = New-TestHarness -Bytes ([byte[]]@())
    try {
      Assert-TestCondition -Condition ($null -eq (Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $harness.Context)) -Name 'EmptyEofWasNotNull'
      Assert-TestCondition -Condition ($null -eq (Read-PilotWindowsNativeProcessJsonlRequest -ReaderContext $harness.Context)) -Name 'RepeatEofWasNotNull'
      Assert-TestCondition -Condition ([bool]$harness.Context.Eof) -Name 'ContextDidNotRecordEof'
    } finally {
      $harness.Stream.Dispose()
    }
  }

  Invoke-TestCase -Name 'at-limit-line-content-excludes-lf-and-crlf' -Action {
    $baseJson = New-RawObserveJson -RequestId $guidA
    $baseLength = $script:Utf8Strict.GetByteCount($baseJson)
    $limit = 262144
    $padding = [string]::new([char]32, $limit - $baseLength)
    $exactJson = $baseJson + $padding

    foreach ($terminator in @($script:Lf, $script:CrLf)) {
      Assert-TestCondition -Condition ($script:Utf8Strict.GetByteCount($exactJson) -eq $limit) -Name 'BoundaryFixtureWrongContentLength'
      $harness = New-TestHarness -Bytes (Get-FrameBytes -Text $exactJson -Terminator $terminator)
      try {
        $request = Read-OneRequest -ReaderContext $harness.Context
        Assert-RequestBasics -Request $request -RequestId $guidA -Operation 'observe'
      } finally {
        $harness.Stream.Dispose()
      }
    }
  }

  Invoke-TestCase -Name 'one-byte-over-content-cap-is-rejected' -Action {
    $canary = 'private-oversize-frame-246-' + [Guid]::NewGuid().ToString('N')
    $baseJson = '{"version":1,"requestId":"' + $guidA + '","operation":"observe","capsuleId":"EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE","unknown":"' + $canary + '"}'
    $limit = 262144
    $padding = [string]::new([char]32, $limit + 1 - $script:Utf8Strict.GetByteCount($baseJson))
    $harness = New-TestHarness -Bytes (Get-FrameBytes -Text ($baseJson + $padding) -Terminator $script:Lf)
    try {
      $null = Assert-ExpectedReaderError -ReaderContext $harness.Context -ExpectedSuffix 'FrameTooLarge' -Canary $canary
    } finally {
      $harness.Stream.Dispose()
    }
  }

  Invoke-TestCase -Name 'bom-invalid-utf8-and-malformed-json-have-safe-tags' -Action {
    $valid = Get-FrameBytes -Text (New-RawObserveJson -RequestId $guidA)
    $bom = [byte[]]@(239, 187, 191) + $valid
    $harnessBom = New-TestHarness -Bytes $bom
    try { $null = Assert-ExpectedReaderError -ReaderContext $harnessBom.Context -ExpectedSuffix 'BomNotAllowed' } finally { $harnessBom.Stream.Dispose() }

    $invalidPrefix = $script:Utf8Strict.GetBytes('{"version":1,"requestId":"' + $guidA + '","operation":"observe","capsuleId":"')
    $invalidSuffix = $script:Utf8Strict.GetBytes('"}' + $script:Lf)
    $invalidUtf8 = [byte[]]::new($invalidPrefix.Length + 2 + $invalidSuffix.Length)
    [Array]::Copy($invalidPrefix, 0, $invalidUtf8, 0, $invalidPrefix.Length)
    $invalidUtf8[$invalidPrefix.Length] = [byte]0xC3
    $invalidUtf8[$invalidPrefix.Length + 1] = [byte]0x28
    [Array]::Copy($invalidSuffix, 0, $invalidUtf8, $invalidPrefix.Length + 2, $invalidSuffix.Length)
    $harnessEncoding = New-TestHarness -Bytes $invalidUtf8 -MaxChunkBytes 1
    try { $null = Assert-ExpectedReaderError -ReaderContext $harnessEncoding.Context -ExpectedSuffix 'InvalidEncoding' } finally { $harnessEncoding.Stream.Dispose() }

    $harnessMalformed = New-TestHarness -Bytes (Get-FrameBytes -Text '{"version":1,' -Terminator $script:Lf)
    try { $null = Assert-ExpectedReaderError -ReaderContext $harnessMalformed.Context -ExpectedSuffix 'MalformedJson' } finally { $harnessMalformed.Stream.Dispose() }
  }

  Invoke-TestCase -Name 'partial-eof-and-invalid-line-ending-are-distinct' -Action {
    $partial = $script:Utf8Strict.GetBytes('{"version":1,"requestId":"' + $guidA + '"}')
    $harnessPartial = New-TestHarness -Bytes $partial
    try { $null = Assert-ExpectedReaderError -ReaderContext $harnessPartial.Context -ExpectedSuffix 'UnexpectedPartialEof' } finally { $harnessPartial.Stream.Dispose() }

    $badEnding = (New-RawObserveJson -RequestId $guidB) + [string][char]13 + ' ' + [string][char]10
    $harnessEnding = New-TestHarness -Bytes (Get-FrameBytes -Text $badEnding -Terminator '')
    try { $null = Assert-ExpectedReaderError -ReaderContext $harnessEnding.Context -ExpectedSuffix 'InvalidLineEnding' } finally { $harnessEnding.Stream.Dispose() }
  }

  Invoke-TestCase -Name 'duplicate-properties-decoded-case-and-recursive-before-schema' -Action {
    $rawExact = '{"version":1,"requestId":"' + $guidA + '","requestId":"' + $guidB + '","operation":"observe","capsuleId":"EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE"}'
    Assert-JsonlReaderCase -Name 'duplicate-exact' -Json $rawExact -ExpectedSuffix 'DuplicateProperty'

    $rawEscaped = '{"version":1,"requestId":"' + $guidA + '","req\u0075estId":"' + $guidB + '","operation":"observe","capsuleId":"EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE"}'
    Assert-JsonlReaderCase -Name 'duplicate-escaped' -Json $rawEscaped -ExpectedSuffix 'DuplicateProperty'

    $rawCase = '{"version":1,"requestId":"' + $guidA + '","RequestId":"' + $guidB + '","operation":"observe","capsuleId":"EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE"}'
    Assert-JsonlReaderCase -Name 'duplicate-case' -Json $rawCase -ExpectedSuffix 'DuplicateProperty'

    $rawArrayNested = '{"version":1,"requestId":"' + $guidA + '","operation":"observe","capsuleId":"EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE","unknown":[{"inner":1,"Inner":2}]}'
    Assert-JsonlReaderCase -Name 'duplicate-in-array-before-unknown-schema' -Json $rawArrayNested -ExpectedSuffix 'DuplicateProperty'

    $validStart = New-RequestJson -Operation start -RequestId $guidA
    $oldEnvironment = '"PATH":"PATH-SENTINEL-246"'
    $duplicateEnvironment = '"PATH":"PATH-SENTINEL-246","P\u0041TH":"other"'
    $nestedDuplicate = $validStart.Replace($oldEnvironment, $duplicateEnvironment)
    Assert-JsonlReaderCase -Name 'duplicate-nested-escaped-case' -Json $nestedDuplicate -ExpectedSuffix 'DuplicateProperty'

    $assertionDuplicate = '{"version":1,"requestId":"' + $guidA + '","operation":"observe","capsuleId":"EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE","identityAssertion":{"processId":123,"ProcessId":124}}'
    Assert-JsonlReaderCase -Name 'duplicate-identity-assertion' -Json $assertionDuplicate -ExpectedSuffix 'DuplicateProperty'
  }

  Invoke-TestCase -Name 'version-operation-fields-guid-and-capsule-shapes' -Action {
    $wrongCaseRoot = '{"Version":1,"requestId":"' + $guidA + '","operation":"observe","capsuleId":"EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE"}'
    Assert-JsonlReaderCase -Name 'root-case-is-exact' -Json $wrongCaseRoot -ExpectedSuffix 'InvalidRequest'

    $wrongVersion = '{"version":2,"requestId":"' + $guidA + '","operation":"observe","capsuleId":"EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE"}'
    Assert-JsonlReaderCase -Name 'version-not-one' -Json $wrongVersion -ExpectedSuffix 'InvalidRequest'

    $wrongVersionType = '{"version":"1","requestId":"' + $guidA + '","operation":"observe","capsuleId":"EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE"}'
    Assert-JsonlReaderCase -Name 'version-string' -Json $wrongVersionType -ExpectedSuffix 'InvalidRequest'

    $unknownOperation = '{"version":1,"requestId":"' + $guidA + '","operation":"restart","capsuleId":"EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE"}'
    Assert-JsonlReaderCase -Name 'unknown-operation' -Json $unknownOperation -ExpectedSuffix 'InvalidRequest'

    $badGuid = '{"version":1,"requestId":"{' + $guidA + '}","operation":"observe","capsuleId":"EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE"}'
    Assert-JsonlReaderCase -Name 'guid-braces-rejected' -Json $badGuid -ExpectedSuffix 'InvalidRequest'

    $observeExtraField = '{"version":1,"requestId":"' + $guidA + '","operation":"observe","capsuleId":"EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE","descriptor":{}}'
    Assert-JsonlReaderCase -Name 'operation-specific-observe-fields' -Json $observeExtraField -ExpectedSuffix 'InvalidRequest'

    $startMissingDescriptor = '{"version":1,"requestId":"' + $guidA + '","operation":"start"}'
    Assert-JsonlReaderCase -Name 'start-requires-descriptor' -Json $startMissingDescriptor -ExpectedSuffix 'InvalidRequest'

    $emptyCapsule = New-RawObserveJson -RequestId $guidA -CapsuleJson '""'
    Assert-JsonlReaderCase -Name 'capsule-must-be-nonempty' -Json $emptyCapsule -ExpectedSuffix 'InvalidRequest'

    $upperCapsule = 'EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE'
    $lowerCapsule = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
    $validCapsule = New-RawObserveJson -RequestId $guidA -CapsuleJson ('"' + $upperCapsule + '"')
    $harnessCapsule = New-TestHarness -Bytes (Get-FrameBytes -Text $validCapsule)
    try {
      $request = Read-OneRequest -ReaderContext $harnessCapsule.Context
      Assert-TestCondition -Condition ([string]$request['capsuleId'] -ceq $lowerCapsule) -Name 'CapsuleGuidWasNotCanonicalized'
    } finally {
      $harnessCapsule.Stream.Dispose()
    }

    foreach ($badCapsuleJson in @(
        '"x"',
        '"   "',
        '"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"',
        '" eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee "'
      )) {
      $json = New-RawObserveJson -RequestId $guidA -CapsuleJson $badCapsuleJson
      Assert-JsonlReaderCase -Name 'invalid-capsule-guid-shape' -Json $json -ExpectedSuffix 'InvalidRequest'
    }

    $nullAssertion = '{"version":1,"requestId":"' + $guidA + '","operation":"observe","capsuleId":"EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE","identityAssertion":null}'
    Assert-JsonlReaderCase -Name 'null-identity-assertion-rejected' -Json $nullAssertion -ExpectedSuffix 'InvalidIdentityAssertion'
  }

  Invoke-TestCase -Name 'lexical-integers-and-timeout-bounds' -Action {
    foreach ($rawVersion in @('1.0', '1e0')) {
      $json = '{"version":' + $rawVersion + ',"requestId":"' + $guidA + '","operation":"observe","capsuleId":"EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE"}'
      Assert-JsonlReaderCase -Name "version-lexical-$rawVersion" -Json $json -ExpectedSuffix 'InvalidRequest'
    }

    foreach ($rawTimeout in @('1.0', '1e3', '-1', '120001', '"1"', '9223372036854775808')) {
      $json = '{"version":1,"requestId":"' + $guidA + '","operation":"stop","capsuleId":"EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE","timeoutMs":' + $rawTimeout + '}'
      Assert-JsonlReaderCase -Name "timeout-lexical-$rawTimeout" -Json $json -ExpectedSuffix 'InvalidTimeout'
    }

    foreach ($validTimeout in @(0, 120000)) {
      $id = if ($validTimeout -eq 0) { $guidB } else { $guidC }
      $json = '{"version":1,"requestId":"' + $id + '","operation":"stop","capsuleId":"EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE","timeoutMs":' + $validTimeout + '}'
      $harness = New-TestHarness -Bytes (Get-FrameBytes -Text $json)
      try {
        $request = Read-OneRequest -ReaderContext $harness.Context
        Assert-TestCondition -Condition ($request['timeoutMs'] -is [long] -and [long]$request['timeoutMs'] -eq [long]$validTimeout) -Name "ValidTimeout:$validTimeout"
      } finally {
        $harness.Stream.Dispose()
      }
    }
  }

  Invoke-TestCase -Name 'depth-12-accepted-through-parse-and-depth-13-rejected' -Action {
    $baseJson = New-RequestJson -Operation start -RequestId $guidA
    $argumentMatch = [regex]::Match($baseJson, '"argumentList":\[[^\]]*\]')
    Assert-TestCondition -Condition $argumentMatch.Success -Name 'DepthFixtureArgumentListMissing'
    foreach ($nestedCount in @(10, 11)) {
      $nested = [string]::Concat([string]::new([char]91, $nestedCount), [string]::new([char]93, $nestedCount))
      $replacement = '"argumentList":' + $nested
      $json = $baseJson.Substring(0, $argumentMatch.Index) + $replacement + $baseJson.Substring($argumentMatch.Index + $argumentMatch.Length)
      $expected = if ($nestedCount -eq 10) { 'InvalidDescriptor' } else { 'DepthExceeded' }
      Assert-JsonlReaderCase -Name "depth-$($nestedCount + 2)" -Json $json -ExpectedSuffix $expected
    }
  }

  Invoke-TestCase -Name 'request-id-d-format-normalization-and-replay-across-operations' -Action {
    $upper = $guidA
    $lower = $guidA.ToLowerInvariant()
    $sequence = @(
      (New-RequestJson -Operation start -RequestId $upper),
      (New-RequestJson -Operation stop -RequestId $guidB),
      (New-RequestJson -Operation start -RequestId $guidC),
      (New-RequestJson -Operation observe -RequestId $lower)
    )
    $frames = @($sequence | ForEach-Object { $_ + $script:Lf })
    $harness = New-TestHarness -Bytes (Get-CombinedFrameBytes -Frames $frames)
    try {
      foreach ($expectedId in @($upper, $guidB, $guidC)) {
        $request = Read-OneRequest -ReaderContext $harness.Context
        Assert-TestCondition -Condition ([string]$request['requestId'] -ceq $expectedId) -Name 'SequenceRequestIdChanged'
      }
      $null = Assert-ExpectedReaderError -ReaderContext $harness.Context -ExpectedSuffix 'DuplicateRequestId'
      Assert-TestCondition -Condition ([bool]$harness.Context.Terminated) -Name 'ReplayDidNotTerminateContext'
    } finally {
      $harness.Stream.Dispose()
    }

    $invalidGuid = 'A1111111222233334444555555555555'
    $invalid = '{"version":1,"requestId":"' + $invalidGuid + '","operation":"observe","capsuleId":"EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE"}'
    Assert-JsonlReaderCase -Name 'guid-without-dashes' -Json $invalid -ExpectedSuffix 'InvalidRequest'
  }

  Invoke-TestCase -Name '4096-distinct-id-cap-is-inclusive' -Action {
    $builder = [Text.StringBuilder]::new()
    for ($index = 1; $index -le 4097; $index++) {
      $id = '00000000-0000-0000-0000-{0:x12}' -f $index
      [void]$builder.Append('{"version":1,"requestId":"')
      [void]$builder.Append($id)
      [void]$builder.Append('","operation":"observe","capsuleId":"EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE"}')
      [void]$builder.Append($script:Lf)
    }

    $harness = New-TestHarness -Bytes ($script:Utf8Strict.GetBytes($builder.ToString())) -MaxChunkBytes 4096
    try {
      for ($index = 1; $index -le 4096; $index++) {
        $request = Read-OneRequest -ReaderContext $harness.Context
        Assert-TestCondition -Condition ($request['requestId'] -is [string]) -Name 'RequestIdNotString'
      }
      $null = Assert-ExpectedReaderError -ReaderContext $harness.Context -ExpectedSuffix 'RequestIdCapacityExceeded'
    } finally {
      $harness.Stream.Dispose()
    }
  }

  Invoke-TestCase -Name 'whole-frame-monotonic-deadline-does-not-reset-on-drip' -Action {
    $padding = [string]::new([char]32, 360)
    $json = New-RawObserveJson -RequestId $guidA
    $bytes = Get-FrameBytes -Text ($json + $padding) -Terminator $script:Lf
    $harness = New-TestHarness -Bytes $bytes -MaxChunkBytes 100 -DelayPerReadMilliseconds 800 -FrameTimeoutMilliseconds 2000
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
      $null = Assert-ExpectedReaderError -ReaderContext $harness.Context -ExpectedSuffix 'DeadlineExceeded'
      $watch.Stop()
      Assert-TestCondition -Condition ($harness.Stream.AsyncReadCalls -ge 2) -Name 'DripDidNotDeliverMultipleChunks'
      Assert-TestCondition -Condition ($harness.Stream.SyncReadCalls -eq 0) -Name 'DeadlineTestDidNotUseAsyncReads'
      Assert-TestCondition -Condition ($harness.Stream.BytesServed -gt 0 -and $harness.Stream.BytesServed -lt $bytes.Length) -Name 'DeadlineReturnedAfterWholeFrame'
      Assert-TestCondition -Condition ($watch.ElapsedMilliseconds -lt 7000) -Name 'FrameDeadlineWasNotBounded'
      Assert-TestCondition -Condition ([bool]$harness.Context.Terminated) -Name 'TimeoutDidNotTerminateContext'
      $callsAfterTimeout = $harness.Stream.ReadCalls
      $null = Assert-ExpectedReaderError -ReaderContext $harness.Context -ExpectedSuffix 'ReaderTerminated'
      Assert-TestCondition -Condition ($harness.Stream.ReadCalls -eq $callsAfterTimeout) -Name 'TerminatedReaderReusedPendingStream'
    } finally {
      $watch.Stop()
      $harness.Stream.Dispose()
    }
  }

  Invoke-TestCase -Name 'read-failure-is-sanitized-and-context-terminal' -Action {
    $canary = 'private-read-cause-246-' + [Guid]::NewGuid().ToString('N')
    $frame = Get-FrameBytes -Text (New-RawObserveJson -RequestId $guidA)
    $harness = New-TestHarness -Bytes $frame -MaxChunkBytes 1 -FailAfterRead 1 -FailureMessage $canary
    try {
      $null = Assert-ExpectedReaderError -ReaderContext $harness.Context -ExpectedSuffix 'ReadFailed' -Canary $canary
      Assert-TestCondition -Condition ([bool]$harness.Context.Terminated) -Name 'ReadFailureDidNotTerminateContext'
    } finally {
      $harness.Stream.Dispose()
    }
  }

  Invoke-TestCase -Name 'identity-descriptor-and-timeout-errors-remain-allowlisted' -Action {
    $canary = 'private-field-value-246-' + [Guid]::NewGuid().ToString('N')
    $badAssertion = '{"version":1,"requestId":"' + $guidA + '","operation":"observe","capsuleId":"EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE","identityAssertion":{"unknown":"' + $canary + '"}}'
    Assert-JsonlReaderCase -Name 'identity-error-safe' -Json $badAssertion -ExpectedSuffix 'InvalidIdentityAssertion' -Canary $canary

    $badDescriptor = New-RequestJson -Operation start -RequestId $guidB
    $badDescriptor = $badDescriptor.Replace('"expectedOwnerSid":"S-1-5-18"', '"expectedOwnerSid":"' + $canary + '"')
    Assert-JsonlReaderCase -Name 'descriptor-error-safe' -Json $badDescriptor -ExpectedSuffix 'InvalidDescriptor' -Canary $canary

    $badTimeout = '{"version":1,"requestId":"' + $guidC + '","operation":"stop","capsuleId":"EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE","timeoutMs":"' + $canary + '"}'
    Assert-JsonlReaderCase -Name 'timeout-error-safe' -Json $badTimeout -ExpectedSuffix 'InvalidTimeout' -Canary $canary
  }
}

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw [InvalidOperationException]::new('Harness:WindowsRequired')
  }

  $readerFullPath = [IO.Path]::GetFullPath($ReaderPath)
  if (-not [IO.File]::Exists($readerFullPath)) { throw [InvalidOperationException]::new('Harness:ReaderMissing') }
  $script:ResolvedReaderPath = $readerFullPath

  $runTempValue = [Environment]::GetEnvironmentVariable('RUNNER_TEMP', [EnvironmentVariableTarget]::Process)
  if ([string]::IsNullOrWhiteSpace($runTempValue)) { throw [InvalidOperationException]::new('Harness:RunnerTempMissing') }
  $runTempFullPath = [IO.Path]::GetFullPath($runTempValue).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $evidenceFullPath = [IO.Path]::GetFullPath($EvidenceRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $relativeEvidence = [IO.Path]::GetRelativePath($runTempFullPath, $evidenceFullPath)
  if ([IO.Path]::IsPathRooted($relativeEvidence) -or
      [string]::IsNullOrWhiteSpace($relativeEvidence) -or
      $relativeEvidence -eq '.' -or
      $relativeEvidence -eq '..' -or
      $relativeEvidence.StartsWith('..' + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
      $relativeEvidence.StartsWith('..' + [IO.Path]::AltDirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw [InvalidOperationException]::new('Harness:EvidenceOutsideRunnerTemp')
  }
  if ([IO.File]::Exists($evidenceFullPath) -or [IO.Directory]::Exists($evidenceFullPath)) {
    throw [InvalidOperationException]::new('Harness:EvidenceRootNotFresh')
  }
  $reportPath = Join-Path $evidenceFullPath 'validator-report.json'
  if ([IO.File]::Exists($reportPath) -or [IO.Directory]::Exists($reportPath)) {
    throw [InvalidOperationException]::new('Harness:EvidenceRootNotFresh')
  }
  [void][IO.Directory]::CreateDirectory($evidenceFullPath)
  if (-not [IO.Directory]::Exists($evidenceFullPath) -or [IO.File]::Exists($evidenceFullPath)) {
    throw [InvalidOperationException]::new('Harness:EvidenceRootCreateFailed')
  }
  $script:EvidenceFullPath = $evidenceFullPath
  $script:EvidenceCreated = $true

  $readerBytes = [IO.File]::ReadAllBytes($readerFullPath)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $script:ReaderSha256 = ([BitConverter]::ToString($sha.ComputeHash($readerBytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }

  Add-JsonlTestStreamType
  $script:ReaderImportOutput = @(. $readerFullPath *>&1)
  Invoke-ReaderCases
} catch {
  $failureCode = Get-ErrorCodeSuffix -Record $_
  [void]$script:CaseFailures.Add('harness')
  [void]$script:CaseResults.Add([ordered]@{ name = 'harness'; status = 'failed'; code = $failureCode })
}

$script:Clock.Stop()
$overallStatus = if ($script:CaseFailures.Count -eq 0 -and $script:CaseResults.Count -gt 0) { 'passed' } else { 'failed' }
$report = [ordered]@{
  schemaVersion = 1
  issue = 246
  status = $overallStatus
  startedUtc = $script:StartedUtc.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
  durationMilliseconds = [long]$script:Clock.ElapsedMilliseconds
  readerSha256 = $script:ReaderSha256
  powershellMajor = [int]$PSVersionTable.PSVersion.Major
  osPlatform = [string][Environment]::OSVersion.Platform
  cases = @($script:CaseResults.ToArray())
  nativeFacadeInvoked = $false
  processesLaunched = 0
  applicationDriverOrGuiLaunched = $false
}

try {
  if ($script:EvidenceCreated -and $null -ne $script:EvidenceFullPath) {
    $jsonReport = ConvertTo-Json -InputObject $report -Depth 12 -Compress
    $reportBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($jsonReport)
    $reportStream = [IO.File]::Open(
      (Join-Path $script:EvidenceFullPath 'validator-report.json'),
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write,
      [IO.FileShare]::None
    )
    try {
      $reportStream.Write($reportBytes, 0, $reportBytes.Length)
    } finally {
      $reportStream.Dispose()
    }
  }
} catch {
  $overallStatus = 'failed'
}

$shortHash = if ($script:ReaderSha256) { $script:ReaderSha256.Substring(0, 12) } else { 'unavailable' }
[Console]::Out.WriteLine("issue246-independent status=$overallStatus cases=$($script:CaseResults.Count) failed=$($script:CaseFailures.Count) readerSha256=$shortHash")
if ($overallStatus -ne 'passed') { exit 1 }
