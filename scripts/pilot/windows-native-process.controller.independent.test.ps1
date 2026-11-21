[CmdletBinding()]
param(
  [Parameter(Mandatory)][string] $EvidenceRoot,
  [string] $ControllerPath = (Join-Path $PSScriptRoot 'windows-native-process.controller.ps1')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:CaseResults = [Collections.Generic.List[object]]::new()
$script:CaseFailures = [Collections.Generic.List[string]]::new()
$script:CleanupFailures = [Collections.Generic.List[string]]::new()
$script:CurrentCaseOutcome = $null
$script:FixtureHandles = [Collections.Generic.List[System.Diagnostics.Process]]::new()
$script:Sessions = [Collections.Generic.List[object]]::new()
$script:EvidenceFullPath = $null
$script:EvidenceCreated = $false
$script:RunnerTempPath = $null
$script:ScratchFullPath = $null
$script:ScratchCreated = $false
$script:ScratchIdentityPath = $null
$script:ScratchIdentityToken = $null
$script:TrackedProcessesExited = $false
$script:ControllerFullPath = $null
$script:ControllerSha256 = $null
$script:RuntimeDirectory = $null
$script:RuntimeExePath = $null
$script:RuntimeSha256 = $null
$script:WideUtf8FixturePathVerified = $false
$script:FixtureScriptPath = $null
$script:Outsider = $null
$script:StartedUtc = [DateTime]::UtcNow
$script:Clock = [Diagnostics.Stopwatch]::StartNew()
$script:Utf8NoBom = [System.Text.UTF8Encoding]::new($false, $true)
$script:MaxReplyBytes = 1048576
$script:CurrentOwnerSid = $null
$script:SystemRootPath = $null
$script:WindowsDirectory = $null

function Assert-Condition {
  param([Parameter(Mandatory)][bool]$Condition,[Parameter(Mandatory)][string]$Name)
  if (-not $Condition) { throw [InvalidOperationException]::new("Assertion:$Name") }
}

function Get-AssertionCode {
  param([AllowNull()][object]$Record)
  if ($null -ne $Record -and [string]$Record.Exception.Message -match '\AAssertion:([A-Za-z0-9_.-]{1,80})\z') { return $Matches[1] }
  return 'HarnessFailure'
}

function Get-FixtureFailureTag {
  param([AllowNull()][object]$Record)
  $assertion=Get-AssertionCode $Record
  if ($assertion -in @('FixtureManifestIdentity','FixtureManifestPid','FixtureHandleIdentity','FixtureManifestImagePathMismatch','FixtureManifestImagePathUnicodeMissing','FixtureImagePathMismatch','FixtureImagePathUnicodeMissing','FixtureStartTimeMismatch')) {
    if ($assertion.Length -le 32) { return $assertion }
    return 'AssertionFailed'
  }
  if ($null -ne $Record -and $null -ne $Record.Exception -and $Record.Exception.GetType().Name -match '\A[A-Za-z][A-Za-z0-9]{0,39}\z') {
    $typeName=$Record.Exception.GetType().Name
    if ($typeName.Length -le 32) { return $typeName }
    return $typeName.Substring(0,32)
  }
  return 'FixtureException'
}

function New-FixtureHandshakeFailure {
  param(
    [Parameter(Mandatory)][ValidateSet('root','descendant','outsider')][string]$Role,
    [Parameter(Mandatory)][ValidatePattern('\A[A-Za-z0-9-]{1,24}\z')][string]$Phase,
    [Parameter(Mandatory)][ValidatePattern('\A[A-Za-z0-9_.-]{1,32}\z')][string]$Reason
  )
  return [InvalidOperationException]::new("Assertion:FixtureHandshake.$Role.$Phase.$Reason")
}

function Add-CleanupFailure {
  param(
    [Parameter(Mandatory)][ValidatePattern('\A[A-Za-z0-9-]{1,24}\z')][string]$Phase,
    [Parameter(Mandatory)][ValidatePattern('\A[A-Za-z0-9-]{1,32}\z')][string]$Code
  )
  $entry=$Phase+'.'+$Code
  if (-not $script:CleanupFailures.Contains($entry)) { [void]$script:CleanupFailures.Add($entry) }
  $caseName='cleanup-'+$entry
  if (-not $script:CaseFailures.Contains($caseName)) { [void]$script:CaseFailures.Add($caseName) }
  $alreadyRecorded=$false
  foreach ($result in $script:CaseResults) { if ([string]$result['name'] -ceq $caseName) { $alreadyRecorded=$true; break } }
  if (-not $alreadyRecorded) { [void]$script:CaseResults.Add([ordered]@{ name=$caseName; status='failed'; code=$Code }) }
}

function Invoke-TestCase {
  param([Parameter(Mandatory)][string]$Name,[Parameter(Mandatory)][scriptblock]$Action)
  $script:CurrentCaseOutcome=$null
  try {
    & $Action | Out-Null
    $entry=[ordered]@{ name=$Name; status='passed'; code=$null }
    if ($null -ne $script:CurrentCaseOutcome) { $entry['outcome']=$script:CurrentCaseOutcome }
    [void]$script:CaseResults.Add($entry)
  } catch {
    [void]$script:CaseFailures.Add($Name)
    $entry=[ordered]@{ name=$Name; status='failed'; code=(Get-AssertionCode $_) }
    if ($null -ne $script:CurrentCaseOutcome) { $entry['outcome']=$script:CurrentCaseOutcome }
    [void]$script:CaseResults.Add($entry)
  } finally {
    $script:CurrentCaseOutcome=$null
  }
}

function Get-Names {
  param([Parameter(Mandatory)][System.Collections.IDictionary]$Dictionary)
  return ,([string[]]@($Dictionary.Keys | ForEach-Object { [string]$_ }))
}

function Assert-ExactNames {
  param([Parameter(Mandatory)][System.Collections.IDictionary]$Dictionary,[Parameter(Mandatory)][string[]]$Expected,[Parameter(Mandatory)][string]$Name)
  $actual = Get-Names -Dictionary $Dictionary
  [Array]::Sort($actual, [StringComparer]::Ordinal)
  $expectedNames = [string[]]$Expected.Clone()
  [Array]::Sort($expectedNames, [StringComparer]::Ordinal)
  Assert-Condition -Condition ([string]::Join('|',$actual) -ceq [string]::Join('|',$expectedNames)) -Name $Name
}

function Test-IntegerValue {
  param([AllowNull()][object]$Value)
  return ($Value -is [int] -or $Value -is [long] -or $Value -is [short])
}

function Assert-IntegerValue {
  param([AllowNull()][object]$Value,[Parameter(Mandatory)][long]$Minimum,[Parameter(Mandatory)][long]$Maximum,[Parameter(Mandatory)][string]$Name)
  $valid = (Test-IntegerValue $Value) -and ([long]$Value -ge $Minimum) -and ([long]$Value -le $Maximum)
  Assert-Condition -Condition $valid -Name $Name
}

function Add-IndependentPipeType {
  if ('Morrow.G15.ControllerIndependent.AsyncBytePipeCapture' -as [type]) { return }
  $source = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
namespace Morrow.G15.ControllerIndependent
{
    public sealed class AsyncBytePipeCapture : IDisposable
    {
        private readonly Stream _stream;
        private readonly int _maximumStoredBytes;
        private readonly object _sync = new object();
        private readonly Queue<byte[]> _chunks = new Queue<byte[]>();
        private readonly List<byte> _pending = new List<byte>();
        private readonly AutoResetEvent _available = new AutoResetEvent(false);
        private bool _ended;
        private bool _overflowed;
        private Exception _failure;
        private long _totalReceived;
        private int _storedBytes;
        private bool _disposed;
        public AsyncBytePipeCapture(Stream stream, int maximumStoredBytes)
        {
            _stream = stream ?? throw new ArgumentNullException(nameof(stream));
            _maximumStoredBytes = maximumStoredBytes <= 0 ? 4194304 : maximumStoredBytes;
            Task.Run(PumpAsync);
        }
        public bool Overflowed { get { lock (_sync) return _overflowed; } }
        public long TotalReceived { get { lock (_sync) return _totalReceived; } }
        public bool Ended { get { lock (_sync) return _ended; } }
        private async Task PumpAsync()
        {
            byte[] buffer = new byte[8192];
            try
            {
                while (true)
                {
                    int count = await _stream.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
                    if (count <= 0) break;
                    lock (_sync)
                    {
                        _totalReceived += count;
                        int available = Math.Max(0, _maximumStoredBytes - _storedBytes);
                        int keep = Math.Min(count, available);
                        if (keep > 0)
                        {
                            byte[] copy = new byte[keep];
                            Buffer.BlockCopy(buffer, 0, copy, 0, keep);
                            _chunks.Enqueue(copy);
                            _storedBytes += keep;
                        }
                        if (keep < count) _overflowed = true;
                    }
                    _available.Set();
                }
            }
            catch (Exception error) { lock (_sync) _failure = error; }
            finally { lock (_sync) _ended = true; _available.Set(); }
        }
        private void MoveQueuedBytesToPending()
        {
            while (_chunks.Count > 0) _pending.AddRange(_chunks.Dequeue());
        }
        public byte[] ReadLine(int timeoutMilliseconds, int maximumLineBytes)
        {
            if (timeoutMilliseconds < 1) throw new ArgumentOutOfRangeException(nameof(timeoutMilliseconds));
            var clock = System.Diagnostics.Stopwatch.StartNew();
            while (true)
            {
                lock (_sync)
                {
                    MoveQueuedBytesToPending();
                    int lf = _pending.IndexOf((byte)10);
                    if (lf >= 0)
                    {
                        int length = lf + 1;
                        if (length > maximumLineBytes) throw new InvalidDataException("ResponseLineTooLarge");
                        byte[] result = _pending.GetRange(0, length).ToArray();
                        _pending.RemoveRange(0, length);
                        return result;
                    }
                    if (_pending.Count > maximumLineBytes) throw new InvalidDataException("ResponseLineTooLarge");
                    if (_ended)
                    {
                        if (_failure != null) throw new IOException("ResponsePipeReadFailed", _failure);
                        if (_pending.Count > 0) throw new EndOfStreamException("PartialResponseLine");
                        return null;
                    }
                }
                int remaining = timeoutMilliseconds - (int)clock.ElapsedMilliseconds;
                if (remaining <= 0) throw new TimeoutException("ResponseLineDeadlineExceeded");
                _available.WaitOne(remaining);
            }
        }
        public bool WaitForEnd(int timeoutMilliseconds)
        {
            var clock = System.Diagnostics.Stopwatch.StartNew();
            while (true)
            {
                lock (_sync) { if (_ended) return true; }
                int remaining = timeoutMilliseconds - (int)clock.ElapsedMilliseconds;
                if (remaining <= 0) return false;
                _available.WaitOne(remaining);
            }
        }
        public byte[] TakeRemainingBytes()
        {
            lock (_sync)
            {
                MoveQueuedBytesToPending();
                byte[] result = _pending.ToArray();
                _pending.Clear();
                return result;
            }
        }
        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            _available.Dispose();
        }
    }
}
'@
  $null = Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
}

function Write-Utf8File {
  param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][AllowEmptyString()][string]$Text)
  [IO.File]::WriteAllText($Path, $Text, $script:Utf8NoBom)
}

function Initialize-EvidenceRoot {
  param([Parameter(Mandatory)][string]$RequestedPath)
  $runTempValue = [Environment]::GetEnvironmentVariable('RUNNER_TEMP', [EnvironmentVariableTarget]::Process)
  if ([string]::IsNullOrWhiteSpace($runTempValue)) { throw [InvalidOperationException]::new('Harness:RunnerTempMissing') }
  $runTemp = [IO.Path]::GetFullPath($runTempValue).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)
  if (-not [IO.Directory]::Exists($runTemp)) { throw [InvalidOperationException]::new('Harness:RunnerTempDirectoryMissing') }
  $script:RunnerTempPath = $runTemp
  $full = [IO.Path]::GetFullPath($RequestedPath).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)
  $relative = [IO.Path]::GetRelativePath($runTemp,$full)
  if ([IO.Path]::IsPathRooted($relative) -or [string]::IsNullOrWhiteSpace($relative) -or $relative -eq '.' -or $relative -eq '..' -or
      $relative.StartsWith('..' + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or
      $relative.StartsWith('..' + [IO.Path]::AltDirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) {
    throw [InvalidOperationException]::new('Harness:EvidenceRootOutsideRunnerTemp')
  }
  if ([IO.File]::Exists($full) -or [IO.Directory]::Exists($full)) { throw [InvalidOperationException]::new('Harness:EvidenceRootNotFresh') }
  [void][IO.Directory]::CreateDirectory($full)
  if (-not [IO.Directory]::Exists($full) -or [IO.File]::Exists($full)) { throw [InvalidOperationException]::new('Harness:EvidenceRootCreateFailed') }
  $script:EvidenceFullPath = $full
  $script:EvidenceCreated = $true
}

function Initialize-ScratchRoot {
  $runTemp=$script:RunnerTempPath
  if ([string]::IsNullOrWhiteSpace($runTemp) -or -not [IO.Directory]::Exists($runTemp)) { throw [InvalidOperationException]::new('Harness:ScratchRunnerTempUnavailable') }
  $nonce=[Guid]::NewGuid().ToString('N')
  $path=[IO.Path]::GetFullPath((Join-Path $runTemp ('m247-i-'+$nonce)))
  $parent=[IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($path)).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)
  if (-not [string]::Equals($parent,$runTemp,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($path) -notmatch '\Am247-i-[0-9a-f]{32}\z') {
    throw [InvalidOperationException]::new('Harness:ScratchRootOutsideRunnerTemp')
  }
  if ([IO.File]::Exists($path) -or [IO.Directory]::Exists($path)) { throw [InvalidOperationException]::new('Harness:ScratchRootNotFresh') }
  [void][IO.Directory]::CreateDirectory($path)
  if (-not [IO.Directory]::Exists($path)) { throw [InvalidOperationException]::new('Harness:ScratchRootCreateFailed') }
  $script:ScratchFullPath = $path
  $script:ScratchCreated = $true
  $rootAttributes=[IO.File]::GetAttributes($path)
  if (($rootAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [InvalidOperationException]::new('Harness:ScratchRootIsReparsePoint') }
  $script:ScratchIdentityPath=Join-Path $path '.morrow-owner'
  $script:ScratchIdentityToken=[Guid]::NewGuid().ToString('N')
  $identityBytes=$script:Utf8NoBom.GetBytes($script:ScratchIdentityToken)
  $identityStream=[IO.File]::Open($script:ScratchIdentityPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $identityStream.Write($identityBytes,0,$identityBytes.Length); $identityStream.Flush($true) } finally { $identityStream.Dispose() }
  $identityCheck=$script:Utf8NoBom.GetString([IO.File]::ReadAllBytes($script:ScratchIdentityPath))
  if ($identityCheck -cne $script:ScratchIdentityToken) { throw [InvalidOperationException]::new('Harness:ScratchIdentityNotConfirmed') }
}

function Copy-DirectoryWithoutReparsePoints {
  param([Parameter(Mandatory)][string]$SourceRoot,[Parameter(Mandatory)][string]$DestinationRoot)
  $source = [IO.Path]::GetFullPath($SourceRoot)
  $destination = [IO.Path]::GetFullPath($DestinationRoot)
  if ([IO.File]::Exists($destination) -or [IO.Directory]::Exists($destination)) { throw [InvalidOperationException]::new('Harness:RuntimeCopyNotFresh') }
  [void][IO.Directory]::CreateDirectory($destination)
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($source)
  while ($pending.Count -gt 0) {
    $current = $pending.Pop()
    $relative = [IO.Path]::GetRelativePath($source,$current)
    $targetDirectory = if ($relative -eq '.') { $destination } else { Join-Path $destination $relative }
    if (-not [IO.Directory]::Exists($targetDirectory)) { [void][IO.Directory]::CreateDirectory($targetDirectory) }
    foreach ($file in [IO.Directory]::GetFiles($current)) {
      if (([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [InvalidOperationException]::new('Harness:RuntimeReparsePointRejected') }
      [IO.File]::Copy($file,(Join-Path $targetDirectory ([IO.Path]::GetFileName($file))),$false)
    }
    foreach ($directory in [IO.Directory]::GetDirectories($current)) {
      if (([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [InvalidOperationException]::new('Harness:RuntimeReparsePointRejected') }
      $pending.Push($directory)
    }
  }
}

function New-CaseDirectory {
  param([Parameter(Mandatory)][string]$ShortName)
  $path = Join-Path $script:ScratchFullPath $ShortName
  if ([IO.File]::Exists($path) -or [IO.Directory]::Exists($path)) { throw [InvalidOperationException]::new('Harness:CaseRootNotFresh') }
  [void][IO.Directory]::CreateDirectory($path)
  foreach ($leaf in @('o','p','w','t')) { [void][IO.Directory]::CreateDirectory((Join-Path $path $leaf)) }
  return [pscustomobject]@{
    Root=$path; Observer=(Join-Path $path 'o'); Profile=(Join-Path $path 'p')
    Working=(Join-Path $path 'w'); Temp=(Join-Path $path 't')
    Nonce=[Guid]::NewGuid().ToString('N')
    RootAck=(Join-Path $path 'o\root.ack'); DescendantAck=(Join-Path $path 'o\descendant.ack')
    OutsiderAck=(Join-Path $path 'o\outsider.ack'); RootAction=(Join-Path $path 'o\root.exit')
    DescendantReady=(Join-Path $path 'o\descendant.ready'); OutsiderStop=(Join-Path $path 'o\outsider.stop')
  }
}

function Get-MinimalEnvironment {
  param([Parameter(Mandatory)][string]$ProfilePath,[Parameter(Mandatory)][string]$TempPath,[Parameter(Mandatory)][string]$RuntimePath)
  $roaming = Join-Path $ProfilePath 'roaming'
  $local = Join-Path $ProfilePath 'local'
  foreach ($directory in @($ProfilePath,$roaming,$local,$TempPath)) { if (-not [IO.Directory]::Exists($directory)) { [void][IO.Directory]::CreateDirectory($directory) } }
  return [ordered]@{
    SYSTEMROOT=$script:SystemRootPath; WINDIR=$script:WindowsDirectory
    PATH=[string]::Join(';',@($RuntimePath,(Join-Path $script:SystemRootPath 'System32')))
    USERPROFILE=$ProfilePath; APPDATA=$roaming; LOCALAPPDATA=$local
    TEMP=$TempPath; TMP=$TempPath
  }
}

function Set-ProcessEnvironment {
  param([Parameter(Mandatory)][System.Diagnostics.ProcessStartInfo]$StartInfo,[Parameter(Mandatory)][System.Collections.IDictionary]$Environment)
  $StartInfo.Environment.Clear()
  foreach ($key in $Environment.Keys) { $StartInfo.Environment[[string]$key]=[string]$Environment[$key] }
}

function New-ProcessStartInfo {
  param(
    [Parameter(Mandatory)][string]$ExecutablePath,[Parameter(Mandatory)][string[]]$Arguments,
    [Parameter(Mandatory)][string]$WorkingDirectory,[Parameter(Mandatory)][System.Collections.IDictionary]$Environment,
    [switch]$RedirectStandardStreams
  )
  $info = [System.Diagnostics.ProcessStartInfo]::new($ExecutablePath)
  $info.UseShellExecute=$false
  $info.CreateNoWindow=$true
  $info.WorkingDirectory=$WorkingDirectory
  if ($RedirectStandardStreams) {
    $info.RedirectStandardInput=$true; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
    $info.StandardOutputEncoding=$script:Utf8NoBom; $info.StandardErrorEncoding=$script:Utf8NoBom
  }
  Set-ProcessEnvironment -StartInfo $info -Environment $Environment
  foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
  return $info
}

function New-FixtureArguments {
  param([Parameter(Mandatory)][string]$Role,[Parameter(Mandatory)][string]$Mode,[Parameter(Mandatory)][object]$Case)
  return [string[]]@(
    '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$script:FixtureScriptPath,
    '-Role',$Role,'-Mode',$Mode,'-ObserverDirectory',$Case.Observer,'-Nonce',$Case.Nonce,
    '-AckPath',(Join-Path $Case.Observer ($Role + '.ack')),'-ActionPath',$Case.RootAction,
    '-ReadyPath',$Case.DescendantReady,'-RuntimeExePath',$script:RuntimeExePath,
    '-FixtureScriptPath',$script:FixtureScriptPath,'-WorkingDirectory',$Case.Working,
    '-DescendantAckPath',$Case.DescendantAck
  )
}

function Write-FixtureScript {
  $body = @'
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('root','descendant','outsider')][string]$Role,
  [Parameter(Mandatory)][ValidateSet('wait','root-exits-first')][string]$Mode,
  [Parameter(Mandatory)][string]$ObserverDirectory,[Parameter(Mandatory)][string]$Nonce,
  [Parameter(Mandatory)][string]$AckPath,[Parameter(Mandatory)][string]$ActionPath,
  [Parameter(Mandatory)][string]$ReadyPath,[Parameter(Mandatory)][string]$RuntimeExePath,
  [Parameter(Mandatory)][string]$FixtureScriptPath,[Parameter(Mandatory)][string]$WorkingDirectory,
  [Parameter(Mandatory)][string]$DescendantAckPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$current=[Diagnostics.Process]::GetCurrentProcess()
$manifest=[ordered]@{
  nonce=$Nonce; role=$Role; processId=[long]$PID
  createdUtc=$current.StartTime.ToUniversalTime().ToString('o',[Globalization.CultureInfo]::InvariantCulture)
  imagePath=$current.MainModule.FileName
}
$name=$Role+'-'+$PID+'-'+$Nonce+'.json'
$manifestPath=Join-Path $ObserverDirectory $name
$tempPath=$manifestPath+'.tmp'
[IO.File]::WriteAllText($tempPath,(ConvertTo-Json -InputObject $manifest -Depth 4 -Compress),[Text.UTF8Encoding]::new($false))
[IO.File]::Move($tempPath,$manifestPath)
while (-not [IO.File]::Exists($AckPath)) { Start-Sleep -Milliseconds 10 }
if ($Role -eq 'outsider') {
  $null=[IO.File]::WriteAllText($ReadyPath,'ready',[Text.UTF8Encoding]::new($false))
  $stopPath=Join-Path $ObserverDirectory 'outsider.stop'
  while (-not [IO.File]::Exists($stopPath)) { Start-Sleep -Milliseconds 10 }
  exit 0
}
if ($Role -eq 'descendant') {
  $null=[IO.File]::WriteAllText($ReadyPath,'ready',[Text.UTF8Encoding]::new($false))
  while ($true) { Start-Sleep -Seconds 1 }
}
if ($Mode -eq 'root-exits-first') {
  while (-not [IO.File]::Exists($ActionPath)) { Start-Sleep -Milliseconds 10 }
  $arguments=@(
    '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$FixtureScriptPath,
    '-Role','descendant','-Mode','wait','-ObserverDirectory',$ObserverDirectory,
    '-Nonce',$Nonce,'-AckPath',$DescendantAckPath,'-ActionPath',$ActionPath,
    '-ReadyPath',$ReadyPath,'-RuntimeExePath',$RuntimeExePath,
    '-FixtureScriptPath',$FixtureScriptPath,'-WorkingDirectory',$WorkingDirectory,
    '-DescendantAckPath',$DescendantAckPath
  )
  $child=[Diagnostics.ProcessStartInfo]::new($RuntimeExePath)
  $child.UseShellExecute=$false
  $child.WorkingDirectory=$WorkingDirectory
  foreach ($argument in $arguments) { $child.ArgumentList.Add($argument) }
  $childProcess=[Diagnostics.Process]::Start($child)
  if ($null -eq $childProcess) { throw [InvalidOperationException]::new('Fixture:DescendantStartFailed') }
  $readyDeadline=[Diagnostics.Stopwatch]::StartNew()
  while (-not [IO.File]::Exists($ReadyPath)) {
    if ($readyDeadline.ElapsedMilliseconds -gt 30000) { throw [TimeoutException]::new('Fixture:DescendantHandshakeTimeout') }
    Start-Sleep -Milliseconds 10
  }
  exit 0
}
while ($true) { Start-Sleep -Seconds 1 }
'@
  $script:FixtureScriptPath=Join-Path $script:ScratchFullPath 'f.ps1'
  Write-Utf8File -Path $script:FixtureScriptPath -Text $body
}

function New-ControllerSession {
  param([Parameter(Mandatory)][string]$ShortName,[int]$FrameTimeoutMilliseconds=0)
  $case=New-CaseDirectory -ShortName $ShortName
  $environment=Get-MinimalEnvironment -ProfilePath $case.Profile -TempPath $case.Temp -RuntimePath $script:RuntimeDirectory
  if ([string]::IsNullOrWhiteSpace($script:RunnerTempPath) -or -not [IO.Directory]::Exists($script:RunnerTempPath)) { throw [InvalidOperationException]::new('Harness:RunnerTempNotVerified') }
  $environment['RUNNER_TEMP']=$script:RunnerTempPath
  $arguments=[Collections.Generic.List[string]]::new()
  foreach ($item in @('-NoLogo','-NoProfile','-NonInteractive','-File',$script:ControllerFullPath,'-Protocol','stdio-v1')) { $arguments.Add($item) }
  if ($FrameTimeoutMilliseconds -gt 0) { $arguments.Add('-FrameTimeoutMilliseconds'); $arguments.Add([string]$FrameTimeoutMilliseconds) }
  $info=New-ProcessStartInfo -ExecutablePath (Join-Path $PSHOME 'pwsh.exe') -Arguments ([string[]]$arguments.ToArray()) -WorkingDirectory $case.Working -Environment $environment -RedirectStandardStreams
  $process=[System.Diagnostics.Process]::new()
  $process.StartInfo=$info
  if (-not $process.Start()) { throw [InvalidOperationException]::new('Harness:ControllerStartFailed') }
  $session=[pscustomobject]@{
    Case=$case; Process=$process
    Stdout=[Morrow.G15.ControllerIndependent.AsyncBytePipeCapture]::new($process.StandardOutput.BaseStream,4194304)
    Stderr=[Morrow.G15.ControllerIndependent.AsyncBytePipeCapture]::new($process.StandardError.BaseStream,4194304)
    Disposed=$false; ResponseCount=0; CanaryValues=[Collections.Generic.List[string]]::new()
  }
  [void]$script:Sessions.Add($session)
  return $session
}

function New-Descriptor {
  param([Parameter(Mandatory)][object]$Case,[Parameter(Mandatory)][long]$ExpectedParentProcessId,[ValidateSet('wait','root-exits-first')][string]$Mode='wait')
  $roaming=Join-Path $Case.Profile 'roaming'
  $local=Join-Path $Case.Profile 'local'
  $profileTemp=Join-Path $Case.Profile 'temp'
  foreach ($directory in @($Case.Profile,$roaming,$local,$profileTemp)) {
    if (-not [IO.Directory]::Exists($directory)) { [void][IO.Directory]::CreateDirectory($directory) }
  }
  $environment=[ordered]@{
    SYSTEMROOT=$script:SystemRootPath; WINDIR=$script:WindowsDirectory
    PATH=[string]::Join(';',@((Join-Path $script:SystemRootPath 'System32'),$script:RuntimeDirectory))
    USERPROFILE=$Case.Profile; APPDATA=$roaming; LOCALAPPDATA=$local
    TEMP=$profileTemp; TMP=$profileTemp
  }
  $arguments=[string[]]@(
    '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$script:FixtureScriptPath,
    '-Role','root','-Mode',$Mode,'-ObserverDirectory',$Case.Observer,'-Nonce',$Case.Nonce,
    '-AckPath',$Case.RootAck,'-ActionPath',$Case.RootAction,'-ReadyPath',$Case.DescendantReady,
    '-RuntimeExePath',$script:RuntimeExePath,'-FixtureScriptPath',$script:FixtureScriptPath,
    '-WorkingDirectory',$Case.Working,'-DescendantAckPath',$Case.DescendantAck
  )
  return [ordered]@{
    executablePath=$script:RuntimeExePath; executableSha256=$script:RuntimeSha256
    argumentList=$arguments; workingDirectory=$Case.Working; profilePath=$Case.Profile
    environment=$environment; expectedParentProcessId=$ExpectedParentProcessId; expectedOwnerSid=$script:CurrentOwnerSid
  }
}

function New-RequestJson {
  param(
    [Parameter(Mandatory)][ValidateSet('start','observe','stop')][string]$Operation,
    [Parameter(Mandatory)][string]$RequestId,[AllowNull()][string]$CapsuleId,
    [AllowNull()][System.Collections.IDictionary]$Descriptor,
    [AllowNull()][System.Collections.IDictionary]$IdentityAssertion,[AllowNull()][object]$TimeoutMs
  )
  $request=[ordered]@{ version=[long]1; requestId=$RequestId; operation=$Operation }
  if ($Operation -eq 'start') { $request.descriptor=$Descriptor }
  else {
    $request.capsuleId=$CapsuleId
    if ($null -ne $IdentityAssertion) { $request.identityAssertion=$IdentityAssertion }
    if ($Operation -eq 'stop' -and $null -ne $TimeoutMs) { $request.timeoutMs=$TimeoutMs }
  }
  return [string](ConvertTo-Json -InputObject $request -Depth 24 -Compress)
}

function Send-RawBytes {
  param([Parameter(Mandatory)][object]$Session,[Parameter(Mandatory)][AllowEmptyCollection()][byte[]]$Bytes)
  $stream=$Session.Process.StandardInput.BaseStream
  $stream.Write($Bytes,0,$Bytes.Length)
  $stream.Flush()
}

function Send-Request {
  param([Parameter(Mandatory)][object]$Session,[Parameter(Mandatory)][AllowEmptyString()][string]$Json)
  $bytes=$script:Utf8NoBom.GetBytes($Json + [string][char]10)
  Send-RawBytes -Session $Session -Bytes $bytes
}

function Read-Response {
  param([Parameter(Mandatory)][object]$Session,[int]$TimeoutMilliseconds=15000)
  $line=[byte[]]$Session.Stdout.ReadLine($TimeoutMilliseconds,$script:MaxReplyBytes)
  Assert-Condition -Condition ($null -ne $line) -Name 'UnexpectedResponseEof'
  Assert-Condition -Condition ($line.Length -le $script:MaxReplyBytes -and $line[$line.Length-1] -eq 10) -Name 'ResponseLineLimitOrLf'
  Assert-Condition -Condition ($line.Length -lt 3 -or -not ($line[0]-eq 239 -and $line[1]-eq 187 -and $line[2]-eq 191)) -Name 'ResponseHasUtf8Bom'
  $length=$line.Length-1
  if ($length -gt 0 -and $line[$length-1] -eq 13) { $length-- }
  $text=$script:Utf8NoBom.GetString($line,0,$length)
  try { $envelope=ConvertFrom-Json -InputObject $text -AsHashtable -DateKind String -ErrorAction Stop } catch { throw [InvalidOperationException]::new('Assertion:ResponseNotJson') }
  Assert-Condition -Condition ($envelope -is [System.Collections.IDictionary]) -Name 'ResponseNotObject'
  [void]$Session.CanaryValues.Add($text)
  $Session.ResponseCount++
  return [pscustomobject]@{ Envelope=$envelope; Text=$text; Bytes=$line }
}

function Assert-CleanupShape {
  param([Parameter(Mandatory)][System.Collections.IDictionary]$Cleanup,[Parameter(Mandatory)][ValidateSet('not-required','confirmed','unconfirmed')][string]$ExpectedState)
  Assert-ExactNames -Dictionary $Cleanup -Expected @('state','jobEmpty','rootExited','disposeFailed') -Name 'CleanupFields'
  Assert-Condition -Condition ($Cleanup['state'] -is [string] -and $Cleanup['state'] -ceq $ExpectedState) -Name 'CleanupState'
  if ($ExpectedState -eq 'not-required') {
    Assert-Condition -Condition ($null -eq $Cleanup['jobEmpty'] -and $null -eq $Cleanup['rootExited'] -and $null -eq $Cleanup['disposeFailed']) -Name 'NotRequiredSignalsNotNull'
  } elseif ($ExpectedState -eq 'confirmed') {
    Assert-Condition -Condition ($Cleanup['jobEmpty'] -is [bool] -and $Cleanup['jobEmpty'] -and $Cleanup['rootExited'] -is [bool] -and $Cleanup['rootExited'] -and $Cleanup['disposeFailed'] -is [bool] -and -not $Cleanup['disposeFailed']) -Name 'CleanupNotConfirmed'
  } else {
    foreach ($field in @('jobEmpty','rootExited','disposeFailed')) { Assert-Condition -Condition ($null -eq $Cleanup[$field] -or $Cleanup[$field] -is [bool]) -Name 'UnconfirmedSignalType' }
  }
}

function Assert-ErrorShape {
  param([Parameter(Mandatory)][System.Collections.IDictionary]$ErrorObject,[AllowNull()][string]$ExpectedCode)
  Assert-ExactNames -Dictionary $ErrorObject -Expected @('code','stage','fields') -Name 'ErrorFields'
  Assert-Condition -Condition ($ErrorObject['code'] -is [string] -and $ErrorObject['code'] -cmatch '\A[A-Za-z][A-Za-z0-9]{0,63}\z') -Name 'ErrorCodeShape'
  Assert-Condition -Condition ($ErrorObject['stage'] -is [string] -and $ErrorObject['stage'] -cmatch '\A[A-Za-z0-9-]{1,64}\z') -Name 'ErrorStageShape'
  Assert-Condition -Condition ($ErrorObject['fields'] -is [Array]) -Name 'ErrorFieldsNotArray'
  foreach ($field in $ErrorObject['fields']) { Assert-Condition -Condition ($field -is [string] -and $field -cmatch '\A[A-Za-z][A-Za-z0-9]{0,63}\z') -Name 'ErrorFieldNameShape' }
  if (-not [string]::IsNullOrEmpty($ExpectedCode)) { Assert-Condition -Condition ([string]$ErrorObject['code'] -ceq $ExpectedCode) -Name "ErrorCode:$ExpectedCode" }
}

function Assert-Envelope {
  param(
    [Parameter(Mandatory)][object]$Response,[Parameter(Mandatory)][bool]$ExpectedOk,
    [AllowNull()][object]$ExpectedRequestId,[Parameter(Mandatory)][ValidateSet('not-required','confirmed','unconfirmed')][string]$CleanupState,
    [AllowNull()][string]$ExpectedCode
  )
  $envelope=$Response.Envelope
  $expectedNames=if ($ExpectedOk) { @('version','requestId','ok','result','cleanup') } else { @('version','requestId','ok','error','cleanup') }
  Assert-ExactNames -Dictionary $envelope -Expected $expectedNames -Name 'EnvelopeFields'
  Assert-Condition -Condition ((Test-IntegerValue $envelope['version']) -and [long]$envelope['version'] -eq 1) -Name 'ResponseVersion'
  Assert-Condition -Condition ($envelope['ok'] -is [bool] -and [bool]$envelope['ok'] -eq $ExpectedOk) -Name 'ResponseOk'
  if ($null -eq $ExpectedRequestId) { Assert-Condition -Condition ($null -eq $envelope['requestId']) -Name 'ResponseRequestIdNull' }
  else {
    Assert-Condition -Condition ($ExpectedRequestId -is [string] -and $ExpectedRequestId -cmatch '\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\z') -Name 'ExpectedRequestIdNotGuidD'
    Assert-Condition -Condition ($envelope['requestId'] -is [string] -and [string]$envelope['requestId'] -cmatch '\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\z' -and [string]$envelope['requestId'] -ceq $ExpectedRequestId) -Name 'ResponseRequestIdCorrelation'
  }
  Assert-Condition -Condition ($envelope['cleanup'] -is [System.Collections.IDictionary]) -Name 'CleanupNotObject'
  Assert-CleanupShape -Cleanup $envelope['cleanup'] -ExpectedState $CleanupState
  if ($ExpectedOk) { Assert-Condition -Condition ($envelope['result'] -is [System.Collections.IDictionary]) -Name 'SuccessResultNotObject' }
  else { Assert-Condition -Condition ($envelope['error'] -is [System.Collections.IDictionary]) -Name 'ErrorNotObject'; Assert-ErrorShape -ErrorObject $envelope['error'] -ExpectedCode $ExpectedCode }
  Assert-Condition -Condition ($Response.Bytes.Length -le $script:MaxReplyBytes) -Name 'ResponseLineExceedsMiBIncludingLf'
  return $envelope
}

function Assert-StartOrObserveResult {
  param(
    [Parameter(Mandatory)][System.Collections.IDictionary]$Result,[Parameter(Mandatory)][string]$ExpectedCapsuleId,
    [Parameter(Mandatory)][long]$ExpectedRootPid,[Parameter(Mandatory)][long]$ExpectedParentPid,
    [Parameter(Mandatory)][bool]$ExpectedRootFresh
  )
  Assert-ExactNames -Dictionary $Result -Expected @('capsuleId','root','inventory') -Name 'LifecycleResultFields'
  $capsuleId=[string]$Result['capsuleId']
  Assert-Condition -Condition ($capsuleId -cmatch '\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z' -and $capsuleId -ceq $ExpectedCapsuleId) -Name 'CapsuleIdNotCanonicalGuidD'
  $root=$Result['root']
  Assert-Condition -Condition ($root -is [System.Collections.IDictionary]) -Name 'RootResultNotObject'
  Assert-ExactNames -Dictionary $root -Expected @('state','identityStatus','identityFresh','identity','exitCode') -Name 'RootResultFields'
  Assert-Condition -Condition ($root['state'] -is [string] -and -not [string]::IsNullOrWhiteSpace([string]$root['state'])) -Name 'RootStateEmpty'
  Assert-Condition -Condition ($root['identityStatus'] -is [string] -and -not [string]::IsNullOrWhiteSpace([string]$root['identityStatus'])) -Name 'RootIdentityStatusEmpty'
  Assert-Condition -Condition ($root['identityFresh'] -is [bool] -and [bool]$root['identityFresh'] -eq $ExpectedRootFresh) -Name 'RootIdentityFresh'
  Assert-Condition -Condition ($root['identity'] -is [System.Collections.IDictionary]) -Name 'RootSnapshotMissing'
  $identity=$root['identity']
  Assert-ExactNames -Dictionary $identity -Expected @('processId','parentProcessId','executablePath','executableSha256','creationTimeUtc','ownerSid') -Name 'RootIdentityFields'
  Assert-IntegerValue -Value $identity['processId'] -Minimum 1 -Maximum ([long]::MaxValue) -Name 'RootProcessId'
  Assert-IntegerValue -Value $identity['parentProcessId'] -Minimum 1 -Maximum ([long]::MaxValue) -Name 'RootParentProcessId'
  Assert-Condition -Condition ([long]$identity['processId'] -eq $ExpectedRootPid) -Name 'ObservedRootPidMismatch'
  Assert-Condition -Condition ([long]$identity['parentProcessId'] -eq $ExpectedParentPid) -Name 'ObservedParentPidMismatch'
  Assert-Condition -Condition ($identity['executablePath'] -is [string] -and [string]::Equals([IO.Path]::GetFullPath([string]$identity['executablePath']),$script:RuntimeExePath,[StringComparison]::OrdinalIgnoreCase)) -Name 'ObservedImagePathMismatch'
  Assert-Condition -Condition ($identity['executableSha256'] -is [string] -and [string]$identity['executableSha256'] -ceq $script:RuntimeSha256) -Name 'ObservedExecutableHashMismatch'
  Assert-Condition -Condition ($identity['ownerSid'] -is [string] -and [string]$identity['ownerSid'] -ceq $script:CurrentOwnerSid) -Name 'ObservedOwnerSidMismatch'
  Assert-Condition -Condition ($identity['creationTimeUtc'] -is [string]) -Name 'ObservedCreationTimeMissing'
  $creation=[DateTimeOffset]::MinValue
  $parsed=[DateTimeOffset]::TryParse([string]$identity['creationTimeUtc'],[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind,[ref]$creation)
  Assert-Condition -Condition $parsed -Name 'ObservedCreationTimeMalformed'
  if (-not $ExpectedRootFresh) { Assert-Condition -Condition ($null -ne $root['exitCode']) -Name 'ExitedRootCodeNotObserved' }

  $inventory=$Result['inventory']
  Assert-Condition -Condition ($inventory -is [System.Collections.IDictionary]) -Name 'InventoryNotObject'
  Assert-ExactNames -Dictionary $inventory -Expected @('status','isEmpty','memberCountBefore','memberCountAfter','members') -Name 'InventoryFields'
  Assert-Condition -Condition ($inventory['status'] -is [string] -and -not [string]::IsNullOrWhiteSpace([string]$inventory['status'])) -Name 'InventoryStatusEmpty'
  Assert-IntegerValue -Value $inventory['memberCountBefore'] -Minimum 0 -Maximum ([long]::MaxValue) -Name 'InventoryBeforeCount'
  Assert-IntegerValue -Value $inventory['memberCountAfter'] -Minimum 0 -Maximum ([long]::MaxValue) -Name 'InventoryAfterCount'
  Assert-Condition -Condition ($inventory['isEmpty'] -is [bool]) -Name 'InventoryIsEmptyNotBool'
  Assert-Condition -Condition ($inventory['members'] -is [Array]) -Name 'InventoryMembersNotArray'
  return $Result
}

function Assert-StopResult {
  param([Parameter(Mandatory)][System.Collections.IDictionary]$Result,[Parameter(Mandatory)][string]$ExpectedCapsuleId)
  Assert-ExactNames -Dictionary $Result -Expected @('capsuleId','completed','timedOut','jobEmpty','rootExited','exitCode') -Name 'StopResultFields'
  Assert-Condition -Condition ([string]$Result['capsuleId'] -ceq $ExpectedCapsuleId) -Name 'StopResultCapsule'
  Assert-Condition -Condition ($Result['completed'] -is [bool] -and $Result['completed']) -Name 'StopNotCompleted'
  Assert-Condition -Condition ($Result['timedOut'] -is [bool] -and -not $Result['timedOut']) -Name 'StopUnexpectedlyTimedOut'
  Assert-Condition -Condition ($Result['jobEmpty'] -is [bool] -and $Result['jobEmpty']) -Name 'StopDidNotConfirmJobEmpty'
  Assert-Condition -Condition ($Result['rootExited'] -is [bool] -and $Result['rootExited']) -Name 'StopDidNotConfirmRootExit'
  Assert-Condition -Condition ($null -eq $Result['exitCode'] -or (Test-IntegerValue $Result['exitCode'])) -Name 'StopExitCodeNotObservedInteger'
}


function New-RequestId {
  param([switch]$Uppercase)
  $id=[Guid]::NewGuid().ToString('D')
  if ($Uppercase) { return $id.ToUpperInvariant() }
  return $id
}

function New-StartJson {
  param([Parameter(Mandatory)][object]$Session,[Parameter(Mandatory)][object]$Case,[Parameter(Mandatory)][string]$RequestId,[long]$ExpectedParentPid=0,[ValidateSet('wait','root-exits-first')][string]$Mode='wait')
  if ($ExpectedParentPid -eq 0) { $ExpectedParentPid=[long]$Session.Process.Id }
  $descriptor=New-Descriptor -Case $Case -ExpectedParentProcessId $ExpectedParentPid -Mode $Mode
  return New-RequestJson -Operation start -RequestId $RequestId -Descriptor $descriptor -CapsuleId $null -IdentityAssertion $null -TimeoutMs $null
}

function New-ObserveJson {
  param([string]$RequestId,[string]$CapsuleId,[AllowNull()][System.Collections.IDictionary]$IdentityAssertion)
  return New-RequestJson -Operation observe -RequestId $RequestId -CapsuleId $CapsuleId -Descriptor $null -IdentityAssertion $IdentityAssertion -TimeoutMs $null
}

function New-StopJson {
  param([string]$RequestId,[string]$CapsuleId,[AllowNull()][object]$TimeoutMs)
  return New-RequestJson -Operation stop -RequestId $RequestId -CapsuleId $CapsuleId -Descriptor $null -IdentityAssertion $null -TimeoutMs $TimeoutMs
}

function Send-And-ReadOk {
  param([Parameter(Mandatory)][object]$Session,[Parameter(Mandatory)][string]$Json,[Parameter(Mandatory)][string]$RequestId,[Parameter(Mandatory)][ValidateSet('not-required','confirmed','unconfirmed')][string]$CleanupState)
  Send-Request -Session $Session -Json $Json
  $response=Read-Response -Session $Session
  return Assert-Envelope -Response $response -ExpectedOk $true -ExpectedRequestId $RequestId -CleanupState $CleanupState -ExpectedCode $null
}

function Read-And-AssertError {
  param(
    [Parameter(Mandatory)][object]$Session,[AllowNull()][object]$RequestId,[AllowNull()][string]$ExpectedCode,
    [Parameter(Mandatory)][ValidateSet('not-required','confirmed','unconfirmed')][string]$CleanupState,[int]$ReadTimeoutMilliseconds=15000
  )
  $response=Read-Response -Session $Session -TimeoutMilliseconds $ReadTimeoutMilliseconds
  return Assert-Envelope -Response $response -ExpectedOk $false -ExpectedRequestId $RequestId -CleanupState $CleanupState -ExpectedCode $ExpectedCode
}

function Send-And-ReadError {
  param(
    [Parameter(Mandatory)][object]$Session,[Parameter(Mandatory)][string]$Json,[AllowNull()][object]$RequestId,
    [AllowNull()][string]$ExpectedCode,[Parameter(Mandatory)][ValidateSet('not-required','confirmed','unconfirmed')][string]$CleanupState
  )
  Send-Request -Session $Session -Json $Json
  return Read-And-AssertError -Session $Session -RequestId $RequestId -ExpectedCode $ExpectedCode -CleanupState $CleanupState
}

function Wait-ForFixtureHandle {
  param(
    [Parameter(Mandatory)][object]$Case,[Parameter(Mandatory)][ValidateSet('root','descendant','outsider')][string]$Role,
    [int]$TimeoutMilliseconds=15000,[AllowNull()][System.Diagnostics.Process]$AlreadyOwnedProcess,[AllowNull()][object]$OwnerSession
  )
  $clock=[Diagnostics.Stopwatch]::StartNew()
  $lastPhase='manifest-discovery'
  $lastReason='no-manifest'
  $process=$AlreadyOwnedProcess
  while ($clock.ElapsedMilliseconds -lt $TimeoutMilliseconds) {
    $phase='manifest-discovery'
    $files=@()
    try {
      $files=@(Get-ChildItem -LiteralPath $Case.Observer -Filter ($Role+'-*-'+$Case.Nonce+'.json') -File -ErrorAction Stop)
    } catch {
      $lastPhase=$phase
      $lastReason=Get-FixtureFailureTag $_
    }
    if ($files.Count -gt 0) {
      $provisionalProcess=$null
      try {
        $phase='manifest-parse'
        $manifest=ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($files[0].FullName,$script:Utf8NoBom)) -AsHashtable -DateKind String -ErrorAction Stop
        $phase='manifest-identity'
        Assert-Condition -Condition ([string]$manifest['role'] -ceq $Role -and [string]$manifest['nonce'] -ceq $Case.Nonce) -Name 'FixtureManifestIdentity'
        Assert-IntegerValue -Value $manifest['processId'] -Minimum 1 -Maximum ([long]::MaxValue) -Name 'FixtureManifestPid'
        $phase='process-handle'
        if ($null -eq $process) {
          # Hold a manifest-selected observer handle provisionally until its full OS identity is verified.
          $provisionalProcess=[Diagnostics.Process]::GetProcessById([int]$manifest['processId'])
          $process=$provisionalProcess
        }
        $phase='process-identity'
        $null=$process.Handle
        Assert-Condition -Condition (-not $process.HasExited -and [long]$process.Id -eq [long]$manifest['processId']) -Name 'FixtureHandleIdentity'
        $phase='image-path'
        $imagePath=$process.MainModule.FileName
        Assert-Condition -Condition ([string]::Equals([IO.Path]::GetFullPath($imagePath),$script:RuntimeExePath,[StringComparison]::OrdinalIgnoreCase)) -Name 'FixtureImagePathMismatch'
        $manifestImagePath=[string]$manifest['imagePath']
        Assert-Condition -Condition ([string]::Equals([IO.Path]::GetFullPath($manifestImagePath),$script:RuntimeExePath,[StringComparison]::OrdinalIgnoreCase)) -Name 'FixtureManifestImagePathMismatch'
        Assert-Condition -Condition ($imagePath.Contains('☃') -and $manifestImagePath.Contains('☃')) -Name 'FixtureImagePathUnicodeMissing'
        $phase='creation-time'
        $manifestStart=[DateTimeOffset]::Parse([string]$manifest['createdUtc'],[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind)
        $handleStart=[DateTimeOffset]$process.StartTime.ToUniversalTime()
        Assert-Condition -Condition ([Math]::Abs(($handleStart-$manifestStart).TotalSeconds) -lt 5) -Name 'FixtureStartTimeMismatch'
        if ($null -ne $provisionalProcess) {
          $existingTrackedProcess=$null
          foreach ($trackedProcess in $script:FixtureHandles) {
            try {
              if ([long]$trackedProcess.Id -eq [long]$process.Id -and $trackedProcess.StartTime.ToUniversalTime().Ticks -eq $handleStart.UtcDateTime.Ticks) {
                $existingTrackedProcess=$trackedProcess
                break
              }
            } catch { }
          }
          if ($null -ne $existingTrackedProcess) {
            $duplicateProcess=$provisionalProcess
            $provisionalProcess=$null
            $process=$existingTrackedProcess
            try { $duplicateProcess.Dispose() } catch { }
          } else {
            [void]$script:FixtureHandles.Add($provisionalProcess)
            $provisionalProcess=$null
          }
        }
        $script:WideUtf8FixturePathVerified=$true
        $phase='acknowledgment'
        $ackPath=switch ($Role) {
          'root' { $Case.RootAck }
          'descendant' { $Case.DescendantAck }
          'outsider' { $Case.OutsiderAck }
        }
        if (-not [IO.File]::Exists($ackPath)) {
          $ack=[IO.File]::Open($ackPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
          try { $bytes=$script:Utf8NoBom.GetBytes('ack'); $ack.Write($bytes,0,$bytes.Length) } finally { $ack.Dispose() }
        }
        return [pscustomobject]@{ Process=$process; Manifest=$manifest; Path=$files[0].FullName }
      } catch {
        $lastPhase=$phase
        $lastReason=Get-FixtureFailureTag $_
        if ($null -ne $provisionalProcess) {
          $process=$null
        }
        if ($phase -eq 'process-handle' -and $null -eq $AlreadyOwnedProcess) {
          throw (New-FixtureHandshakeFailure -Role $Role -Phase 'process-handle' -Reason $lastReason)
        }
      } finally {
        if ($null -ne $provisionalProcess) {
          try { $provisionalProcess.Dispose() } catch { }
          $provisionalProcess=$null
        }
      }
    }
    $hasExited=$false
    if ($null -ne $process) {
      try { $hasExited=$process.HasExited } catch { }
    }
    if ($hasExited) {
      throw (New-FixtureHandshakeFailure -Role $Role -Phase 'process-exit' -Reason 'exited-before-handshake')
    }
    if ($null -ne $OwnerSession) {
      $controllerExited=$false
      try { $controllerExited=$OwnerSession.Process.HasExited } catch { }
      if ($controllerExited) {
        throw (New-FixtureHandshakeFailure -Role $Role -Phase 'controller-exit' -Reason 'exited-before-fixture')
      }
    }
    Start-Sleep -Milliseconds 15
  }
  throw [TimeoutException]::new("Assertion:FixtureHandshake.$Role.$lastPhase.$lastReason")
}

function Start-Outsider {
  $case=New-CaseDirectory -ShortName 'out'
  $environment=Get-MinimalEnvironment -ProfilePath $case.Profile -TempPath $case.Temp -RuntimePath $script:RuntimeDirectory
  $arguments=New-FixtureArguments -Role outsider -Mode wait -Case $case
  $info=New-ProcessStartInfo -ExecutablePath $script:RuntimeExePath -Arguments $arguments -WorkingDirectory $case.Working -Environment $environment
  $process=[System.Diagnostics.Process]::new()
  $process.StartInfo=$info
  if (-not $process.Start()) { throw [InvalidOperationException]::new('Harness:OutsiderStartFailed') }
  $script:Outsider=[pscustomobject]@{ Case=$case; Process=$process; HandshakeComplete=$false }
  [void]$script:FixtureHandles.Add($process)
  $null=Wait-ForFixtureHandle -Case $case -Role outsider -AlreadyOwnedProcess $process
  $script:Outsider.HandshakeComplete=$true
}

function Assert-FixtureAlive {
  param([Parameter(Mandatory)][System.Diagnostics.Process]$Process,[Parameter(Mandatory)][string]$Name)
  Assert-Condition -Condition (-not $Process.HasExited) -Name "FixtureNotAlive:$Name"
}

function Wait-FixtureExit {
  param([Parameter(Mandatory)][System.Diagnostics.Process]$Process,[Parameter(Mandatory)][string]$Name,[int]$TimeoutMilliseconds=15000)
  Assert-Condition -Condition ($Process.WaitForExit($TimeoutMilliseconds)) -Name "FixtureExitDeadline:$Name"
  Assert-Condition -Condition $Process.HasExited -Name "FixtureExitUnobserved:$Name"
}

function Write-ActionFile {
  param([Parameter(Mandatory)][string]$Path)
  $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try { $bytes=$script:Utf8NoBom.GetBytes('go'); $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
}

function Send-StartAndCapture {
  param(
    [Parameter(Mandatory)][object]$Session,[Parameter(Mandatory)][object]$Case,[Parameter(Mandatory)][string]$RequestId,
    [switch]$PrebufferPartial,[string]$PartialFrame='',[ValidateSet('wait','root-exits-first')][string]$Mode='wait'
  )
  $json=New-StartJson -Session $Session -Case $Case -RequestId $RequestId -Mode $Mode
  if ($PrebufferPartial) {
    $complete=$script:Utf8NoBom.GetBytes($json+[string][char]10)
    $partial=$script:Utf8NoBom.GetBytes($PartialFrame)
    $combined=[byte[]]::new($complete.Length+$partial.Length)
    [Array]::Copy($complete,0,$combined,0,$complete.Length)
    [Array]::Copy($partial,0,$combined,$complete.Length,$partial.Length)
    Send-RawBytes -Session $Session -Bytes $combined
  } else { Send-Request -Session $Session -Json $json }

  $fixture=Wait-ForFixtureHandle -Case $Case -Role root -OwnerSession $Session
  $response=Read-Response -Session $Session
  $envelope=Assert-Envelope -Response $response -ExpectedOk $true -ExpectedRequestId $RequestId -CleanupState not-required -ExpectedCode $null
  $capsuleId=[string]$envelope['result']['capsuleId']
  Assert-StartOrObserveResult -Result $envelope['result'] -ExpectedCapsuleId $capsuleId -ExpectedRootPid ([long]$fixture.Manifest['processId']) -ExpectedParentPid ([long]$Session.Process.Id) -ExpectedRootFresh $true | Out-Null
  return [pscustomobject]@{ CapsuleId=$capsuleId; Response=$response; Envelope=$envelope; Fixture=$fixture; Case=$Case }
}

function Assert-StopResultAndExitedRoot {
  param([Parameter(Mandatory)][object]$Session,[Parameter(Mandatory)][string]$RequestId,[Parameter(Mandatory)][object]$Started)
  $stopJson=New-StopJson -RequestId $RequestId -CapsuleId $Started.CapsuleId -TimeoutMs $null
  $response=Send-And-ReadOk -Session $Session -Json $stopJson -RequestId $RequestId -CleanupState confirmed
  Assert-StopResult -Result $response['result'] -ExpectedCapsuleId $Started.CapsuleId
  Wait-FixtureExit -Process $Started.Fixture.Process -Name 'root-after-stop'
  Assert-FixtureAlive -Process $script:Outsider.Process -Name 'outsider-after-stop'
}

function Assert-SafeSessionOutput {
  param([Parameter(Mandatory)][object]$Session)
  Assert-Condition -Condition (-not $Session.Stdout.Overflowed -and -not $Session.Stderr.Overflowed) -Name 'PipeCaptureOverflow'
  $remaining=[byte[]]$Session.Stdout.TakeRemainingBytes()
  Assert-Condition -Condition ($remaining.Length -eq 0) -Name 'UnexpectedExtraStdout'
  $stderrBytes=[byte[]]$Session.Stderr.TakeRemainingBytes()
  try { $stderr=$script:Utf8NoBom.GetString($stderrBytes) } catch { throw [InvalidOperationException]::new('Assertion:StderrNotUtf8') }
  Assert-Condition -Condition ($stderrBytes.Length -le 65536) -Name 'StderrTooLarge'
  foreach ($value in $Session.CanaryValues) {
    if ($value.Length -gt 24) { Assert-Condition -Condition (-not $stderr.Contains($value,[StringComparison]::Ordinal)) -Name 'RawResponseInStderr' }
  }
  if ($script:ScratchFullPath) { Assert-Condition -Condition (-not $stderr.Contains($script:ScratchFullPath,[StringComparison]::OrdinalIgnoreCase)) -Name 'ScratchPathLeakedToStderr' }
}

function Complete-Controller {
  param(
    [Parameter(Mandatory)][object]$Session,[switch]$CloseInput,[switch]$KillOnlyController,[int]$TimeoutMilliseconds=15000
  )
  if ($Session.Disposed) { return $null }
  $process=$Session.Process
  if ($CloseInput) { try { $process.StandardInput.Close() } catch { } }
  if ($KillOnlyController -and -not $process.HasExited) { $process.Kill() }
  if (-not $process.HasExited) { Assert-Condition -Condition ($process.WaitForExit($TimeoutMilliseconds)) -Name 'ControllerExitDeadline' }
  Assert-Condition -Condition ($Session.Stdout.WaitForEnd(5000)) -Name 'ControllerStdoutDidNotClose'
  Assert-Condition -Condition ($Session.Stderr.WaitForEnd(5000)) -Name 'ControllerStderrDidNotClose'
  Assert-SafeSessionOutput -Session $Session
  $exitCode=[int]$process.ExitCode
  $Session.Disposed=$true
  $Session.Stdout.Dispose()
  $Session.Stderr.Dispose()
  $process.Dispose()
  return $exitCode
}

function Assert-ExitCode {
  param([Parameter(Mandatory)][int]$Actual,[Parameter(Mandatory)][ValidateSet('zero','nonzero')][string]$Expected,[Parameter(Mandatory)][string]$Name)
  if ($Expected -eq 'zero') { Assert-Condition -Condition ($Actual -eq 0) -Name $Name }
  else { Assert-Condition -Condition ($Actual -ne 0) -Name $Name }
}

function Invoke-HappyStateAndSequence {
  $session=New-ControllerSession -ShortName 'h1'
  try {
    $caseA=New-CaseDirectory -ShortName 'h1a'
    $startId=New-RequestId -Uppercase
    $startedA=Send-StartAndCapture -Session $session -Case $caseA -RequestId $startId
    Assert-Condition -Condition ([string]$startedA.Envelope['result']['root']['identity']['executablePath'] -match '☃') -Name 'Utf8PathMarkerWasNotPresent'

    $activeCase=New-CaseDirectory -ShortName 'h1i'
    $activeId=New-RequestId
    $activeJson=New-StartJson -Session $session -Case $activeCase -RequestId $activeId
    $null=Send-And-ReadError -Session $session -Json $activeJson -RequestId $activeId -ExpectedCode 'CapsuleAlreadyActive' -CleanupState not-required
    Assert-FixtureAlive -Process $startedA.Fixture.Process -Name 'active-start-refusal'

    $unknownId=New-RequestId
    $unknownCapsule=[Guid]::NewGuid().ToString('D')
    $unknownJson=New-ObserveJson -RequestId $unknownId -CapsuleId $unknownCapsule -IdentityAssertion $null
    $null=Send-And-ReadError -Session $session -Json $unknownJson -RequestId $unknownId -ExpectedCode 'UnknownCapsule' -CleanupState not-required
    Assert-FixtureAlive -Process $startedA.Fixture.Process -Name 'unknown-capsule-refusal'

    $wrongSid=if ($script:CurrentOwnerSid -ceq 'S-1-5-18') { 'S-1-5-19' } else { 'S-1-5-18' }
    $assertionId=New-RequestId
    $badAssertion=[ordered]@{ ownerSid=$wrongSid }
    $assertionJson=New-ObserveJson -RequestId $assertionId -CapsuleId $startedA.CapsuleId -IdentityAssertion $badAssertion
    $null=Send-And-ReadError -Session $session -Json $assertionJson -RequestId $assertionId -ExpectedCode 'IdentityMismatch' -CleanupState not-required
    Assert-FixtureAlive -Process $startedA.Fixture.Process -Name 'assertion-mismatch-destroyed-capsule'

    $observeId=New-RequestId
    $observeJson=New-ObserveJson -RequestId $observeId -CapsuleId $startedA.CapsuleId -IdentityAssertion $null
    $observe=Send-And-ReadOk -Session $session -Json $observeJson -RequestId $observeId -CleanupState not-required
    Assert-StartOrObserveResult -Result $observe['result'] -ExpectedCapsuleId $startedA.CapsuleId -ExpectedRootPid ([long]$startedA.Fixture.Manifest['processId']) -ExpectedParentPid ([long]$session.Process.Id) -ExpectedRootFresh $true | Out-Null

    Assert-StopResultAndExitedRoot -Session $session -RequestId (New-RequestId) -Started $startedA

    $caseB=New-CaseDirectory -ShortName 'h1b'
    $startedB=Send-StartAndCapture -Session $session -Case $caseB -RequestId (New-RequestId)
    Assert-StopResultAndExitedRoot -Session $session -RequestId (New-RequestId) -Started $startedB

    $exitCode=Complete-Controller -Session $session -CloseInput
    Assert-ExitCode -Actual $exitCode -Expected zero -Name 'HappyControllerDidNotExitZero'
    Assert-FixtureAlive -Process $script:Outsider.Process -Name 'outsider-after-sequential-stops'
  } finally {
    if (-not $session.Disposed) { $null=Complete-Controller -Session $session -CloseInput -KillOnlyController -TimeoutMilliseconds 5000 }
  }
}

function Invoke-RootExitsFirst {
  $session=New-ControllerSession -ShortName 'r1'
  try {
    $case=New-CaseDirectory -ShortName 'r1a'
    $started=Send-StartAndCapture -Session $session -Case $case -RequestId (New-RequestId) -Mode root-exits-first
    Write-ActionFile -Path $case.RootAction
    $descendant=Wait-ForFixtureHandle -Case $case -Role descendant -OwnerSession $session
    Assert-FixtureAlive -Process $descendant.Process -Name 'descendant-after-root-start'
    Wait-FixtureExit -Process $started.Fixture.Process -Name 'root-exited-first'

    $observeId=New-RequestId
    $observeJson=New-ObserveJson -RequestId $observeId -CapsuleId $started.CapsuleId -IdentityAssertion $null
    $observed=Send-And-ReadOk -Session $session -Json $observeJson -RequestId $observeId -CleanupState not-required
    Assert-StartOrObserveResult -Result $observed['result'] -ExpectedCapsuleId $started.CapsuleId -ExpectedRootPid ([long]$started.Fixture.Manifest['processId']) -ExpectedParentPid ([long]$session.Process.Id) -ExpectedRootFresh $false | Out-Null
    $found=$false
    foreach ($member in $observed['result']['inventory']['members']) {
      if ($member -is [System.Collections.IDictionary] -and $member.Contains('processId') -and (Test-IntegerValue $member['processId']) -and [long]$member['processId'] -eq [long]$descendant.Manifest['processId']) { $found=$true }
    }
    Assert-Condition -Condition $found -Name 'ExitedRootSnapshotLostLiveDescendant'

    $stopId=New-RequestId
    $stopJson=New-StopJson -RequestId $stopId -CapsuleId $started.CapsuleId -TimeoutMs $null
    $stop=Send-And-ReadOk -Session $session -Json $stopJson -RequestId $stopId -CleanupState confirmed
    Assert-StopResult -Result $stop['result'] -ExpectedCapsuleId $started.CapsuleId
    Wait-FixtureExit -Process $descendant.Process -Name 'descendant-after-stop'
    Assert-FixtureAlive -Process $script:Outsider.Process -Name 'outsider-after-descendant-stop'

    $exitCode=Complete-Controller -Session $session -CloseInput
    Assert-ExitCode -Actual $exitCode -Expected zero -Name 'RootFirstControllerDidNotExitZero'
  } finally {
    if (-not $session.Disposed) { $null=Complete-Controller -Session $session -CloseInput -KillOnlyController -TimeoutMilliseconds 5000 }
  }
}

function Invoke-CleanEofCleanup {
  $session=New-ControllerSession -ShortName 'e1'
  try {
    $case=New-CaseDirectory -ShortName 'e1a'
    $started=Send-StartAndCapture -Session $session -Case $case -RequestId (New-RequestId)
    $exitCode=Complete-Controller -Session $session -CloseInput
    Assert-ExitCode -Actual $exitCode -Expected zero -Name 'CleanEofDidNotExitZeroAfterCleanup'
    Wait-FixtureExit -Process $started.Fixture.Process -Name 'CleanEofRootNotCleaned'
    Assert-FixtureAlive -Process $script:Outsider.Process -Name 'CleanEofKilledOutsider'
  } finally {
    if (-not $session.Disposed) { $null=Complete-Controller -Session $session -CloseInput -KillOnlyController -TimeoutMilliseconds 5000 }
  }
}

function Invoke-ZeroTimeoutStopRace {
  $session=New-ControllerSession -ShortName 't1'
  try {
    $case=New-CaseDirectory -ShortName 't1a'
    $started=Send-StartAndCapture -Session $session -Case $case -RequestId (New-RequestId)
    $stopId=New-RequestId
    $stopJson=New-StopJson -RequestId $stopId -CapsuleId $started.CapsuleId -TimeoutMs ([long]0)
    Send-Request -Session $session -Json $stopJson
    $response=Read-Response -Session $session
    $envelope=$response.Envelope
    Assert-Condition -Condition ($envelope['ok'] -is [bool]) -Name 'ZeroTimeoutResponseOkNotBool'
    if ([bool]$envelope['ok']) {
      $completed=Assert-Envelope -Response $response -ExpectedOk $true -ExpectedRequestId $stopId -CleanupState confirmed -ExpectedCode $null
      Assert-StopResult -Result $completed['result'] -ExpectedCapsuleId $started.CapsuleId
      Wait-FixtureExit -Process $started.Fixture.Process -Name 'ZeroTimeoutCompletedRootNotExited'
      Assert-FixtureAlive -Process $script:Outsider.Process -Name 'ZeroTimeoutCompletedKilledOutsider'
      $exitCode=Complete-Controller -Session $session -CloseInput
      Assert-ExitCode -Actual $exitCode -Expected zero -Name 'ZeroTimeoutCompletedEofNotZero'
      $script:CurrentCaseOutcome='zero-timeout-completed-immediately-cleanup-confirmed-eof-zero'
    } else {
      $failure=Assert-Envelope -Response $response -ExpectedOk $false -ExpectedRequestId $stopId -CleanupState confirmed -ExpectedCode 'StopTimedOut'
      Assert-Condition -Condition ($failure['error']['code'] -ceq 'StopTimedOut') -Name 'StopTimeoutWasConvertedToSuccess'
      $exitCode=Complete-Controller -Session $session
      Assert-ExitCode -Actual $exitCode -Expected nonzero -Name 'StopTimeoutWasNotFatal'
      Wait-FixtureExit -Process $started.Fixture.Process -Name 'StopTimeoutTerminalCleanupMissing'
      Assert-FixtureAlive -Process $script:Outsider.Process -Name 'StopTimeoutKilledOutsider'
      $script:CurrentCaseOutcome='zero-timeout-stop-timed-out-cleanup-confirmed-exit-nonzero'
    }
  } finally {
    if (-not $session.Disposed) { $null=Complete-Controller -Session $session -CloseInput -KillOnlyController -TimeoutMilliseconds 5000 }
  }
}

function Invoke-PartialEofCleanup {
  $session=New-ControllerSession -ShortName 'p1'
  try {
    $case=New-CaseDirectory -ShortName 'p1a'
    $started=Send-StartAndCapture -Session $session -Case $case -RequestId (New-RequestId)
    $partial=$script:Utf8NoBom.GetBytes('{"version":1,"requestId":"'+(New-RequestId)+'","operation":"observe"')
    Send-RawBytes -Session $session -Bytes $partial
    $session.Process.StandardInput.Close()
    $null=Read-And-AssertError -Session $session -RequestId $null -ExpectedCode 'UnexpectedPartialEof' -CleanupState confirmed
    $exitCode=Complete-Controller -Session $session
    Assert-ExitCode -Actual $exitCode -Expected nonzero -Name 'PartialEofNotFatal'
    Wait-FixtureExit -Process $started.Fixture.Process -Name 'PartialEofDidNotCleanRoot'
    Assert-FixtureAlive -Process $script:Outsider.Process -Name 'PartialEofKilledOutsider'
  } finally {
    if (-not $session.Disposed) { $null=Complete-Controller -Session $session -CloseInput -KillOnlyController -TimeoutMilliseconds 5000 }
  }
}

function Invoke-DeadlineCleanup {
  $session=New-ControllerSession -ShortName 'd1' -FrameTimeoutMilliseconds 7000
  try {
    $case=New-CaseDirectory -ShortName 'd1a'
    $startId=New-RequestId
    $partial='{"version":1,"requestId":"'+(New-RequestId)+'","operation":"observe","capsuleId":"'
    $started=Send-StartAndCapture -Session $session -Case $case -RequestId $startId -PrebufferPartial -PartialFrame $partial
    $null=Read-And-AssertError -Session $session -RequestId $null -ExpectedCode 'DeadlineExceeded' -CleanupState confirmed -ReadTimeoutMilliseconds 20000
    $exitCode=Complete-Controller -Session $session
    Assert-ExitCode -Actual $exitCode -Expected nonzero -Name 'DeadlineWasNotFatal'
    Wait-FixtureExit -Process $started.Fixture.Process -Name 'DeadlineDidNotCleanRoot'
    Assert-FixtureAlive -Process $script:Outsider.Process -Name 'DeadlineKilledOutsider'
  } finally {
    if (-not $session.Disposed) { $null=Complete-Controller -Session $session -CloseInput -KillOnlyController -TimeoutMilliseconds 5000 }
  }
}

function Invoke-ReplayCleanup {
  $session=New-ControllerSession -ShortName 'q1'
  try {
    $case=New-CaseDirectory -ShortName 'q1a'
    $replayedId=New-RequestId -Uppercase
    $started=Send-StartAndCapture -Session $session -Case $case -RequestId $replayedId
    $duplicate=New-ObserveJson -RequestId $replayedId.ToLowerInvariant() -CapsuleId $started.CapsuleId -IdentityAssertion $null
    $null=Send-And-ReadError -Session $session -Json $duplicate -RequestId $null -ExpectedCode 'DuplicateRequestId' -CleanupState confirmed
    $exitCode=Complete-Controller -Session $session
    Assert-ExitCode -Actual $exitCode -Expected nonzero -Name 'ReplayWasNotFatal'
    Wait-FixtureExit -Process $started.Fixture.Process -Name 'ReplayDidNotCleanRoot'
    Assert-FixtureAlive -Process $script:Outsider.Process -Name 'ReplayKilledOutsider'
  } finally {
    if (-not $session.Disposed) { $null=Complete-Controller -Session $session -CloseInput -KillOnlyController -TimeoutMilliseconds 5000 }
  }
}

function Invoke-MalformedInputCleanup {
  $session=New-ControllerSession -ShortName 'm1'
  try {
    $case=New-CaseDirectory -ShortName 'm1a'
    $started=Send-StartAndCapture -Session $session -Case $case -RequestId (New-RequestId)
    $canary='private-controller-input-'+[Guid]::NewGuid().ToString('N')
    [void]$session.CanaryValues.Add($canary)
    $bad='{"version":1,"requestId":"'+(New-RequestId)+'","operation":"observe","capsuleId":"x","unknown":"'+$canary+'","bad":}'
    [void]$session.CanaryValues.Add($bad)
    Send-Request -Session $session -Json $bad
    $null=Read-And-AssertError -Session $session -RequestId $null -ExpectedCode 'MalformedJson' -CleanupState confirmed
    $exitCode=Complete-Controller -Session $session
    Assert-ExitCode -Actual $exitCode -Expected nonzero -Name 'MalformedJsonWasNotFatal'
    Wait-FixtureExit -Process $started.Fixture.Process -Name 'MalformedJsonDidNotCleanRoot'
    Assert-FixtureAlive -Process $script:Outsider.Process -Name 'MalformedJsonKilledOutsider'
  } finally {
    if (-not $session.Disposed) { $null=Complete-Controller -Session $session -CloseInput -KillOnlyController -TimeoutMilliseconds 5000 }
  }
}

function Invoke-StartProofFailureRetry {
  $session=New-ControllerSession -ShortName 's1'
  try {
    $badCase=New-CaseDirectory -ShortName 's1b'
    $badId=New-RequestId
    $badJson=New-StartJson -Session $session -Case $badCase -RequestId $badId -ExpectedParentPid 1
    Send-Request -Session $session -Json $badJson
    $failure=Read-Response -Session $session
    $failedStart=Assert-Envelope -Response $failure -ExpectedOk $false -ExpectedRequestId $badId -CleanupState confirmed -ExpectedCode 'IdentityMismatch'
    Assert-Condition -Condition ($failedStart['error']['code'] -is [string]) -Name 'StartProofFailureHasNoCode'
    Assert-Condition -Condition ([string]$failedStart['error']['stage'] -ceq 'identity-comparison') -Name 'StartProofFailureStage'
    Assert-Condition -Condition (@($failedStart['error']['fields']) -contains 'parentProcessId') -Name 'StartProofFailureField'
    $badManifests=@(Get-ChildItem -LiteralPath $badCase.Observer -Filter ('root-*-'+$badCase.Nonce+'.json') -File -ErrorAction SilentlyContinue)
    Assert-Condition -Condition ($badManifests.Count -eq 0) -Name 'InvalidParentProofRanFixture'

    $goodCase=New-CaseDirectory -ShortName 's1g'
    $started=Send-StartAndCapture -Session $session -Case $goodCase -RequestId (New-RequestId)
    Assert-StopResultAndExitedRoot -Session $session -RequestId (New-RequestId) -Started $started
    $exitCode=Complete-Controller -Session $session -CloseInput
    Assert-ExitCode -Actual $exitCode -Expected zero -Name 'RetryAfterConfirmedStartCleanupFailed'
  } finally {
    if (-not $session.Disposed) { $null=Complete-Controller -Session $session -CloseInput -KillOnlyController -TimeoutMilliseconds 5000 }
  }
}

function Invoke-ControllerLossExternalObserver {
  $session=New-ControllerSession -ShortName 'l1'
  try {
    $case=New-CaseDirectory -ShortName 'l1a'
    $started=Send-StartAndCapture -Session $session -Case $case -RequestId (New-RequestId)
    Assert-FixtureAlive -Process $started.Fixture.Process -Name 'FixtureNotRunningBeforeControllerLoss'
    # Kill only this controller Process handle. The outer validator independently waits on the child fixture handle.
    $exitCode=Complete-Controller -Session $session -KillOnlyController
    Assert-ExitCode -Actual $exitCode -Expected nonzero -Name 'ControllerLossExitWasZero'
    Wait-FixtureExit -Process $started.Fixture.Process -Name 'OuterObserverDidNotConfirmJobCloseCleanup'
    Assert-FixtureAlive -Process $script:Outsider.Process -Name 'ControllerLossKilledOutsider'
  } finally {
    if (-not $session.Disposed) { $null=Complete-Controller -Session $session -KillOnlyController -TimeoutMilliseconds 5000 }
  }
}

function Invoke-ControllerCases {
  Start-Outsider
  Invoke-TestCase -Name 'start-observe-stop-state-refusals-and-sequential-restart' -Action { Invoke-HappyStateAndSequence }
  Invoke-TestCase -Name 'root-exits-first-descendant-is-observed-and-stopped' -Action { Invoke-RootExitsFirst }
  Invoke-TestCase -Name 'clean-eof-cleans-active-capsule-before-zero-exit-without-reply' -Action { Invoke-CleanEofCleanup }
  Invoke-TestCase -Name 'stop-zero-timeout-roundtrip-covers-real-race-outcomes' -Action { Invoke-ZeroTimeoutStopRace }
  Invoke-TestCase -Name 'partial-eof-is-fatal-and-cleans-active-capsule' -Action { Invoke-PartialEofCleanup }
  Invoke-TestCase -Name 'prebuffered-partial-frame-deadline-is-fatal-and-cleans' -Action { Invoke-DeadlineCleanup }
  Invoke-TestCase -Name 'normalized-request-id-replay-is-fatal-and-cleans' -Action { Invoke-ReplayCleanup }
  Invoke-TestCase -Name 'malformed-json-is-fatal-sanitized-and-cleans' -Action { Invoke-MalformedInputCleanup }
  Invoke-TestCase -Name 'start-proof-failure-cleans-before-retry' -Action { Invoke-StartProofFailureRetry }
  Invoke-TestCase -Name 'controller-loss-is-verified-by-outer-process-handle' -Action { Invoke-ControllerLossExternalObserver }
}

function Stop-TrackedTestProcesses {
  $allExited=$true
  foreach ($session in $script:Sessions) {
    if ($session.Disposed) { continue }
    try {
      if (-not $session.Process.HasExited) {
        try { $session.Process.StandardInput.Close() } catch { }
        if (-not $session.Process.HasExited) { $session.Process.Kill(); $null=$session.Process.WaitForExit(10000) }
      }
      if (-not $session.Process.HasExited) {
        $allExited=$false
        Add-CleanupFailure -Phase 'controller-process' -Code 'exit-not-confirmed'
        continue
      }
    } catch {
      $allExited=$false
      Add-CleanupFailure -Phase 'controller-process' -Code 'control-failed'
      continue
    }
    try {
      if (-not $session.Stdout.WaitForEnd(5000) -or -not $session.Stderr.WaitForEnd(5000)) {
        $allExited=$false
        Add-CleanupFailure -Phase 'controller-pipes' -Code 'close-not-confirmed'
        continue
      }
      $null=$session.Stdout.TakeRemainingBytes()
      $null=$session.Stderr.TakeRemainingBytes()
      $session.Stdout.Dispose()
      $session.Stderr.Dispose()
      $session.Process.Dispose()
      $session.Disposed=$true
    } catch {
      $allExited=$false
      Add-CleanupFailure -Phase 'controller-pipes' -Code 'drain-failed'
    }
  }

  if ($null -ne $script:Outsider) {
    $outsiderProcess=$script:Outsider.Process
    try {
      if (-not $outsiderProcess.HasExited -and $script:Outsider.HandshakeComplete) {
        Write-ActionFile -Path $script:Outsider.Case.OutsiderStop
        $null=$outsiderProcess.WaitForExit(5000)
      }
    } catch { }
    try {
      if (-not $outsiderProcess.HasExited) {
        $outsiderProcess.Kill()
        $null=$outsiderProcess.WaitForExit(10000)
      }
      if (-not $outsiderProcess.HasExited) {
        $allExited=$false
        Add-CleanupFailure -Phase 'outsider-process' -Code 'exit-not-confirmed'
      }
    } catch {
      $allExited=$false
      Add-CleanupFailure -Phase 'outsider-process' -Code 'control-failed'
    }
  }

  foreach ($process in $script:FixtureHandles) {
    $isOutsider=$null -ne $script:Outsider -and [object]::ReferenceEquals($process,$script:Outsider.Process)
    try {
      if (-not $isOutsider -and -not $process.HasExited) {
        $process.Kill()
        $null=$process.WaitForExit(10000)
      }
      if (-not $process.HasExited) {
        $allExited=$false
        Add-CleanupFailure -Phase 'fixture-process' -Code 'exit-not-confirmed'
        continue
      }
    } catch {
      $allExited=$false
      Add-CleanupFailure -Phase 'fixture-process' -Code 'control-failed'
      continue
    }
    try { $process.Dispose() } catch { $allExited=$false; Add-CleanupFailure -Phase 'fixture-process' -Code 'dispose-failed' }
  }
  $script:TrackedProcessesExited=$allExited
}

function Get-ScratchTreePaths {
  param([Parameter(Mandatory)][string]$Root)
  $paths=[Collections.Generic.List[string]]::new()
  $pending=[Collections.Generic.Stack[string]]::new()
  $paths.Add($Root)
  $pending.Push($Root)
  while ($pending.Count -gt 0) {
    $directory=$pending.Pop()
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
      $attributes=[IO.File]::GetAttributes($entry)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [InvalidOperationException]::new('ScratchTreeReparsePoint') }
      $paths.Add($entry)
      if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { $pending.Push($entry) }
    }
  }
  return ,([string[]]$paths.ToArray())
}

function Remove-ScratchRoot {
  if (-not $script:ScratchCreated -or $null -eq $script:ScratchFullPath) { return }
  $phase='scratch-containment'
  try {
    $full=[IO.Path]::GetFullPath($script:ScratchFullPath).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)
    $parent=[IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($full)).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)
    if (-not [string]::Equals($parent,$script:RunnerTempPath,[StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($full) -notmatch '\Am247-i-[0-9a-f]{32}\z' -or
        -not [string]::Equals($full,$script:ScratchFullPath,[StringComparison]::OrdinalIgnoreCase)) {
      Add-CleanupFailure -Phase 'scratch-containment' -Code 'path-not-owned-child'
      return
    }
    if (-not [IO.Directory]::Exists($full)) {
      Add-CleanupFailure -Phase 'scratch-identity' -Code 'root-missing'
      return
    }
    $rootAttributes=[IO.File]::GetAttributes($full)
    if (($rootAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      Add-CleanupFailure -Phase 'scratch-identity' -Code 'root-is-reparse-point'
      return
    }
    $expectedIdentityPath=Join-Path $full '.morrow-owner'
    if (-not [string]::Equals($expectedIdentityPath,$script:ScratchIdentityPath,[StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.File]::Exists($expectedIdentityPath)) {
      Add-CleanupFailure -Phase 'scratch-identity' -Code 'owner-marker-missing'
      return
    }
    $identityAttributes=[IO.File]::GetAttributes($expectedIdentityPath)
    if (($identityAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        $script:Utf8NoBom.GetString([IO.File]::ReadAllBytes($expectedIdentityPath)) -cne $script:ScratchIdentityToken) {
      Add-CleanupFailure -Phase 'scratch-identity' -Code 'owner-marker-mismatch'
      return
    }
  } catch {
    Add-CleanupFailure -Phase $phase -Code 'identity-check-failed'
    return
  }
  if (-not $script:TrackedProcessesExited) {
    Add-CleanupFailure -Phase 'scratch-processes' -Code 'exit-not-confirmed'
    return
  }
  $phase='scratch-tree'
  try {
    $paths=[string[]](Get-ScratchTreePaths -Root $full)
  } catch {
    $code=if ($_.Exception.Message -ceq 'ScratchTreeReparsePoint') { 'reparse-point-found' } else { 'inspection-failed' }
    Add-CleanupFailure -Phase $phase -Code $code
    return
  }
  $phase='scratch-attributes'
  try {
    foreach ($entry in $paths) {
      $attributes=[IO.File]::GetAttributes($entry)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [InvalidOperationException]::new('ScratchTreeReparsePoint') }
      if (($attributes -band [IO.FileAttributes]::ReadOnly) -ne 0) {
        $writableAttributes=$attributes -band (-bnot [IO.FileAttributes]::ReadOnly)
        [IO.File]::SetAttributes($entry,$writableAttributes)
      }
    }
  } catch {
    $code=if ($_.Exception.Message -ceq 'ScratchTreeReparsePoint') { 'reparse-point-found' } else { 'readonly-clear-failed' }
    Add-CleanupFailure -Phase $phase -Code $code
    return
  }
  $phase='scratch-delete'
  try {
    [IO.Directory]::Delete($full,$true)
    if ([IO.Directory]::Exists($full) -or [IO.File]::Exists($full)) { Add-CleanupFailure -Phase $phase -Code 'delete-not-confirmed'; return }
    $script:ScratchCreated=$false
    $script:ScratchFullPath=$null
    $script:ScratchIdentityPath=$null
    $script:ScratchIdentityToken=$null
  } catch {
    Add-CleanupFailure -Phase $phase -Code 'delete-failed'
  }
}

function Write-Receipt {
  param([Parameter(Mandatory)][System.Collections.IDictionary]$Receipt)
  $path=Join-Path $script:EvidenceFullPath 'validator-report.json'
  $json=ConvertTo-Json -InputObject $Receipt -Depth 14 -Compress
  $bytes=[System.Text.UTF8Encoding]::new($false).GetBytes($json)
  $stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
}

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw [InvalidOperationException]::new('Harness:WindowsRequired') }
  if (-not [IO.File]::Exists($ControllerPath)) { throw [InvalidOperationException]::new('Harness:ControllerMissing') }
  $script:ControllerFullPath=[IO.Path]::GetFullPath($ControllerPath)
  $hash= [Security.Cryptography.SHA256]::Create()
  try {
    $script:ControllerSha256=([BitConverter]::ToString($hash.ComputeHash([IO.File]::ReadAllBytes($script:ControllerFullPath)))).Replace('-','').ToLowerInvariant()
  } finally { $hash.Dispose() }

  Initialize-EvidenceRoot -RequestedPath $EvidenceRoot
  Initialize-ScratchRoot
  $script:SystemRootPath=[Environment]::GetEnvironmentVariable('SystemRoot',[EnvironmentVariableTarget]::Machine)
  if ([string]::IsNullOrWhiteSpace($script:SystemRootPath)) { $script:SystemRootPath=[Environment]::GetEnvironmentVariable('SystemRoot',[EnvironmentVariableTarget]::Process) }
  $script:WindowsDirectory=[Environment]::GetEnvironmentVariable('windir',[EnvironmentVariableTarget]::Machine)
  if ([string]::IsNullOrWhiteSpace($script:WindowsDirectory)) { $script:WindowsDirectory=$script:SystemRootPath }
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  $script:CurrentOwnerSid=[string]$identity.User.Value
  Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace($script:CurrentOwnerSid)) -Name 'CurrentOwnerSidMissing'

  $sourceRuntime=[IO.Path]::GetFullPath($PSHOME)
  $script:RuntimeDirectory=Join-Path $script:ScratchFullPath 'p-☃'
  Copy-DirectoryWithoutReparsePoints -SourceRoot $sourceRuntime -DestinationRoot $script:RuntimeDirectory
  $script:RuntimeExePath=Join-Path $script:RuntimeDirectory 'pwsh.exe'
  Assert-Condition -Condition ([IO.File]::Exists($script:RuntimeExePath)) -Name 'CopiedPwshMissing'
  $sourceExeHash=(Get-FileHash -LiteralPath (Join-Path $sourceRuntime 'pwsh.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
  $script:RuntimeSha256=(Get-FileHash -LiteralPath $script:RuntimeExePath -Algorithm SHA256).Hash.ToLowerInvariant()
  Assert-Condition -Condition ($script:RuntimeSha256 -ceq $sourceExeHash) -Name 'CopiedPwshHashChanged'

  Add-IndependentPipeType
  Write-FixtureScript
  Invoke-ControllerCases
} catch {
  [void]$script:CaseFailures.Add('harness')
  [void]$script:CaseResults.Add([ordered]@{ name='harness'; status='failed'; code=(Get-AssertionCode $_) })
} finally {
  try { Stop-TrackedTestProcesses } catch { Add-CleanupFailure -Phase 'process-finalization' -Code 'control-failed' }
  $script:Clock.Stop()
  try { Remove-ScratchRoot } catch { Add-CleanupFailure -Phase 'scratch-finalization' -Code 'cleanup-failed' }
}

$overallStatus=if ($script:CaseFailures.Count -eq 0 -and $script:CaseResults.Count -gt 0) { 'passed' } else { 'failed' }
$receipt=[ordered]@{
  schemaVersion=1
  issue=247
  status=$overallStatus
  startedUtc=$script:StartedUtc.ToString('o',[Globalization.CultureInfo]::InvariantCulture)
  durationMilliseconds=[long]$script:Clock.ElapsedMilliseconds
  controllerSha256=$script:ControllerSha256
  copiedRuntimeSha256=$script:RuntimeSha256
  powershellVersion=[string]$PSVersionTable.PSVersion
  osPlatform=[string][Environment]::OSVersion.Platform
  cases=@($script:CaseResults.ToArray())
  cleanupFailures=@($script:CleanupFailures.ToArray())
  syntheticProcessesOnly=$true
  applicationLaunched=$false
  driverStarted=$false
  guiTested=$false
  networkUsed=$false
  responseLimitBytesIncludingLf=$script:MaxReplyBytes
  observedResponseLinesWithinLimit=$true
  oversizePath='executor-structural-or-injected-proof'
  externalObserverHeldOnlyFixtureHandles=$true
  wideUtf8FixturePathVerified=$script:WideUtf8FixturePathVerified
}
if ($script:EvidenceCreated -and $null -ne $script:EvidenceFullPath) {
  try { Write-Receipt -Receipt $receipt } catch { $overallStatus='failed' }
}
$shortHash=if ($script:ControllerSha256) { $script:ControllerSha256.Substring(0,12) } else { 'unavailable' }
[Console]::Out.WriteLine("issue247-independent status=$overallStatus cases=$($script:CaseResults.Count) failed=$($script:CaseFailures.Count) controllerSha256=$shortHash")
if ($overallStatus -ne 'passed') { exit 1 }
