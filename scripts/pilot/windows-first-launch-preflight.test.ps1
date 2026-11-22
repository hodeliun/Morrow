$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$sourcePath = Join-Path $PSScriptRoot 'windows-first-launch-preflight.ps1'
$tokens = $null
$parseErrors = $null
[void][Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) {
  $messages = ($parseErrors | ForEach-Object { $_.Message }) -join '; '
  throw "windows-first-launch-preflight.ps1 failed PowerShell parsing: $messages"
}
. $sourcePath -LibraryOnly
Add-Type -AssemblyName System.IO.Compression

if (-not ('MorrowFirstLaunchTest.FakeWindowsJobSession' -as [type])) {
  Add-Type -TypeDefinition @'
using System;

namespace MorrowFirstLaunchTest {
  public sealed class FakeJobState {
    public bool LeaveMember { get; set; }
    public int ResumeCount { get; set; }
    public int ObserveCount { get; set; }
    public int MemberQueries { get; set; }
    public int StopCount { get; set; }
    public int DisposeCount { get; set; }
    public int StopTimeoutMs { get; set; }
    public int ObservationDelayMs { get; set; }
    public int FactoryDelayMs { get; set; }
    public FakeJobState(bool leaveMember, int observationDelayMs, int factoryDelayMs) {
      LeaveMember = leaveMember;
      ObservationDelayMs = observationDelayMs;
      FactoryDelayMs = factoryDelayMs;
    }
  }

  public static class FakeJobStateSlot {
    public static FakeJobState Current { get; set; }
  }

  public sealed class FakeRootObservation {
    public string state { get; set; }
    public uint? exitCode { get; set; }
  }

  public sealed class FakeStopResult {
    public bool jobEmpty { get; set; }
    public bool rootExited { get; set; }
    public bool timedOut { get; set; }
  }

  public sealed class FakeWindowsJobSession : IDisposable {
    private readonly FakeJobState _state;
    private bool _disposed;
    public FakeWindowsJobSession(FakeJobState state) {
      _state = state ?? throw new ArgumentNullException("state");
    }
    public void Resume() { EnsureUsable(); _state.ResumeCount++; }
    public FakeRootObservation ObserveRoot() {
      EnsureUsable();
      _state.ObserveCount++;
      if (_state.ObservationDelayMs > 0) System.Threading.Thread.Sleep(_state.ObservationDelayMs);
      return new FakeRootObservation { state = "exited", exitCode = 0 };
    }
    public uint[] ListMemberIds() {
      EnsureUsable();
      _state.MemberQueries++;
      return _state.LeaveMember ? new uint[] { 424242 } : new uint[0];
    }
    public FakeStopResult StopAndWait(int timeoutMs) {
      EnsureUsable();
      _state.StopCount++;
      _state.StopTimeoutMs = timeoutMs;
      return new FakeStopResult { jobEmpty = true, rootExited = true, timedOut = false };
    }
    public void Dispose() {
      if (_disposed) return;
      _disposed = true;
      _state.DisposeCount++;
    }
    private void EnsureUsable() {
      if (_disposed) throw new ObjectDisposedException("FakeWindowsJobSession");
    }
  }
}
'@ -Language CSharp -ErrorAction Stop
}

$script:assertionCount = 0
function Assert-True([bool] $Condition, [string] $Label) {
  $script:assertionCount++
  if (-not $Condition) { throw "Assertion failed: $Label" }
}

function Assert-Throws([string] $Label, [scriptblock] $Action) {
  $script:assertionCount++
  $thrown = $false
  try { & $Action } catch { $thrown = $true }
  if (-not $thrown) { throw "Expected failure was not raised: $Label" }
}

function Assert-ThrowsWithoutSecrets([string] $Label, [scriptblock] $Action, [string[]] $Secrets) {
  $script:assertionCount++
  $message = $null
  try { & $Action } catch { $message = [string]$_.Exception.Message }
  if ($null -eq $message) { throw "Expected failure was not raised: $Label" }
  foreach ($secret in $Secrets) {
    if ($message.Contains($secret)) { throw "Secret text escaped the boundary: $Label" }
  }
}

function Get-TestSha256([byte[]] $Bytes) {
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}

function New-TestZip([string] $Path, [object[]] $Entries) {
  $file = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $archive = [IO.Compression.ZipArchive]::new($file, [IO.Compression.ZipArchiveMode]::Create, $false)
  try {
    foreach ($item in $Entries) {
      $entry = $archive.CreateEntry([string]$item.Name, [IO.Compression.CompressionLevel]::NoCompression)
      if ($item.Contains('ExternalAttributes') -and $null -ne $item.ExternalAttributes) {
        $entry.ExternalAttributes = [int]$item.ExternalAttributes
      }
      $output = $entry.Open()
      try {
        [byte[]]$bytes = [byte[]]::new(0)
        if ($item.Contains('Bytes') -and $item.Bytes -is [byte[]]) {
          $bytes = [byte[]]$item.Bytes
        } else {
          $bytes = [Text.Encoding]::UTF8.GetBytes([string]$item.Content)
        }
        $output.Write($bytes, 0, $bytes.Length)
      } finally { $output.Dispose() }
    }
  } finally { $archive.Dispose() }
}

function Corrupt-TestZipPayload([string] $Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ([BitConverter]::ToUInt32($bytes, 0) -ne 0x04034b50) { throw 'Fixture ZIP has an unexpected local header.' }
  $nameLength = [BitConverter]::ToUInt16($bytes, 26)
  $extraLength = [BitConverter]::ToUInt16($bytes, 28)
  $payloadOffset = 30 + $nameLength + $extraLength
  $bytes[$payloadOffset] = $bytes[$payloadOffset] -bxor 0xFF
  [IO.File]::WriteAllBytes($Path, $bytes)
}

function Set-TestBytes([byte[]] $Target, [int] $Offset, [byte[]] $Value) {
  [Array]::Copy($Value, 0, $Target, $Offset, $Value.Length)
}

function New-TestPeBytes([switch] $WithoutResourceDirectory) {
  $bytes = New-Object byte[] 512
  $bytes[0] = 0x4D
  $bytes[1] = 0x5A
  $peOffset = 0x80
  Set-TestBytes $bytes 0x3C ([BitConverter]::GetBytes([int]$peOffset))
  Set-TestBytes $bytes $peOffset ([Text.Encoding]::ASCII.GetBytes(('PE' + [char]0 + [char]0)))
  Set-TestBytes $bytes ($peOffset + 4) ([BitConverter]::GetBytes([uint16]0x8664))
  Set-TestBytes $bytes ($peOffset + 6) ([BitConverter]::GetBytes([uint16]1))
  Set-TestBytes $bytes ($peOffset + 20) ([BitConverter]::GetBytes([uint16]240))
  $optionalOffset = $peOffset + 24
  Set-TestBytes $bytes $optionalOffset ([BitConverter]::GetBytes([uint16]0x20B))
  if (-not $WithoutResourceDirectory) {
    Set-TestBytes $bytes ($optionalOffset + 128) ([BitConverter]::GetBytes([uint32]0x2000))
    Set-TestBytes $bytes ($optionalOffset + 132) ([BitConverter]::GetBytes([uint32]32))
  }
  return ,$bytes
}

function New-TestLocalProcessRunner {
  $runner = {
    param($Request)
    $runnerType = Get-FirstLaunchBoundedProcessType
    $result = $runnerType::Run(
      [string]$Request.executable,
      [string[]]$Request.arguments,
      [string]$Request.workingDirectory,
      [Collections.Generic.Dictionary[string,string]]$Request.environment,
      [int]$Request.timeoutMs,
      [int]$Request.maximumOutputBytes
    )
    return [pscustomobject]@{
      ExitCode = [int]$result.ExitCode
      StdOut = [string]$result.StandardOutput
      StdErr = [string]$result.StandardError
      TimedOut = [bool]$result.TimedOut
      OutputLimitExceeded = [bool]$result.OutputLimitExceeded
    }
  }
  return $runner.GetNewClosure()
}

function New-TestFakeJobSessionFactory([bool] $LeaveMember, [int] $ObservationDelayMs = 0, [int] $FactoryDelayMs = 0) {
  $state = [MorrowFirstLaunchTest.FakeJobState]::new($LeaveMember, $ObservationDelayMs, $FactoryDelayMs)
  [MorrowFirstLaunchTest.FakeJobStateSlot]::Current = $state
  $factory = {
    param($Launch)
    $testState = [MorrowFirstLaunchTest.FakeJobStateSlot]::Current
    if ($testState.FactoryDelayMs -gt 0) { Start-Sleep -Milliseconds $testState.FactoryDelayMs }
    $request = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Launch.requestPath)) -AsHashtable -NoEnumerate
    $receipt = [ordered]@{
      schema = 'morrow.e003.g23.process-result.v1'
      requestId = [string]$request.requestId
      stageOwnerToken = [string]$request.stageOwnerToken
      exitCode = 0
      stdout = 'MSEdgeDriver 156.0.4314.58'
      stderr = 'bounded-fake-stderr'
      timedOut = $false
      outputLimitExceeded = $false
    }
    $receiptBytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $receipt -Depth 4 -Compress))
    Write-FirstLaunchNewFile $Launch.resultPath $receiptBytes
    return [MorrowFirstLaunchTest.FakeWindowsJobSession]::new([MorrowFirstLaunchTest.FakeJobStateSlot]::Current)
  }
  return $factory.GetNewClosure()
}

function Copy-TestCandidate {
  $json = ConvertTo-Json -InputObject (Get-FirstLaunchPins) -Depth 16 -Compress
  return (ConvertFrom-Json -InputObject $json -AsHashtable -DateKind String)
}

function New-TestPackageFixture([string] $Root) {
  $candidate = Copy-TestCandidate
  $candidate.artifact.expiresAtUtc = '2099-12-31T23:59:59.000Z'
  $packageRoot = Join-Path $Root 'package-fixture'
  [void][IO.Directory]::CreateDirectory($packageRoot)
  $inventory = [Collections.ArrayList]::new()

  foreach ($pinnedEntry in (Get-FirstLaunchInventory)) {
    $relative = [string]$pinnedEntry.path
    if ($relative -ceq 'morrow.exe') {
      $bytes = New-TestPeBytes
    } elseif ($relative -ceq 'DemoVault/.morrow/plugins/polaris-dados/manifest.json') {
      $bytes = [Text.Encoding]::UTF8.GetBytes('{"id":"polaris-dados","name":"Polaris Dados","version":"test"}')
    } else {
      $bytes = [Text.Encoding]::UTF8.GetBytes(('synthetic package fixture: ' + $relative + [Environment]::NewLine))
    }
    $nativePath = Join-Path $packageRoot ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($nativePath))
    [IO.File]::WriteAllBytes($nativePath, [byte[]]$bytes)
    [void]$inventory.Add([ordered]@{
      path = $relative
      sizeBytes = [long]$bytes.LongLength
      sha256 = Get-TestSha256 $bytes
    })
  }

  $inventoryArray = @($inventory.ToArray())
  $candidate.package.canonicalInventorySha256 = Get-TestSha256 (Get-FirstLaunchCanonicalInventoryBytes $inventoryArray)
  $candidate.package.fileInventoryCount = $inventoryArray.Count
  $candidate.package.executableSizeBytes = [long](@($inventoryArray | Where-Object { $_.path -ceq 'morrow.exe' })[0].sizeBytes)
  $candidate.package.executableSha256 = [string](@($inventoryArray | Where-Object { $_.path -ceq 'morrow.exe' })[0].sha256)
  $candidate.package.launcherSha256 = [string](@($inventoryArray | Where-Object { $_.path -ceq 'windows-launch.ps1' })[0].sha256)
  $candidate.package.launcherCmdSha256 = [string](@($inventoryArray | Where-Object { $_.path -ceq 'windows-launch.cmd' })[0].sha256)
  $candidate.package.mcpResourceSha256 = [string](@($inventoryArray | Where-Object { $_.path -ceq 'mcp/index.js' })[0].sha256)
  $candidate.package.demoVaultSha256 = Get-TestSha256 ([Text.Encoding]::UTF8.GetBytes('synthetic DemoVault tree'))

  $buildInfo = [ordered]@{
    schemaVersion = 1
    scope = 'synthetic first-launch fixture'
    applicationVersion = [string]$candidate.package.applicationVersion
    sourceBuildPlatform = 'windows-native'
    run = [ordered]@{ id = [string]$candidate.buildRunId; attempt = [string]$candidate.buildRunAttempt; sha = [string]$candidate.sourceSha }
    git = [ordered]@{ branch = [string]$candidate.branch; head = [string]$candidate.sourceSha; tree = [string]$candidate.sourceTree; status = 'clean' }
    runner = [ordered]@{ os = 'Windows'; architecture = 'X64' }
    appLaunched = $false
    windowsRuntimeTested = $false
    appGUIWindowsTested = $null
    pilotIdentifier = [string]$candidate.package.pilotIdentifier
    overlay = [ordered]@{
      path = [string]$candidate.package.overlayPath
      sha256 = [string]$candidate.package.overlaySha256
      identifier = [string]$candidate.package.pilotIdentifier
      bundleActive = $false
      mcpResourceSource = [string]$candidate.package.mcpResourceSource
      mcpResourceTarget = [string]$candidate.package.mcpResourceTarget
    }
    template = [ordered]@{ path = [string]$candidate.package.demoVaultPath; sha256 = [string]$candidate.package.demoVaultSha256 }
    fileInventory = $inventoryArray
    buildCommands = @(
      [ordered]@{ label = 'npm-ci'; command = 'npm ci'; status = 'passed'; exitCode = 0 },
      [ordered]@{ label = 'npm-check'; command = 'npm run check'; status = 'passed'; exitCode = 0 },
      [ordered]@{ label = 'cargo-fmt'; command = 'cargo fmt --check'; status = 'passed'; exitCode = 0 },
      [ordered]@{ label = 'cargo-clippy'; command = 'cargo clippy'; status = 'passed'; exitCode = 0 },
      [ordered]@{ label = 'cargo-test'; command = 'cargo test'; status = 'passed'; exitCode = 0 },
      [ordered]@{ label = 'tauri-windows-debug-build'; command = 'tauri build --debug --no-bundle --config src-tauri/tauri.pilot.conf.json'; status = 'passed'; exitCode = 0 },
      [ordered]@{ label = 'polaris-dados-plugin-build'; command = 'npm run build:polaris-dados'; status = 'passed'; exitCode = 0 }
    )
  }
  $buildInfoPath = Join-Path $packageRoot 'BUILD-INFO.json'
  $buildInfoJson = ConvertTo-Json -InputObject $buildInfo -Depth 14 -Compress
  [IO.File]::WriteAllText($buildInfoPath, $buildInfoJson, [Text.UTF8Encoding]::new($false))
  $candidate.package.buildInfoSizeBytes = (Get-Item -LiteralPath $buildInfoPath).Length
  $candidate.package.buildInfoSha256 = Get-Sha256 $buildInfoPath

  $sumLines = [Collections.Generic.List[string]]::new()
  $sumLines.Add(([string]$candidate.package.buildInfoSha256 + '  BUILD-INFO.json'))
  foreach ($entry in $inventoryArray) { $sumLines.Add(([string]$entry.sha256 + '  ' + [string]$entry.path)) }
  $sumsPath = Join-Path $packageRoot 'SHA256SUMS'
  [IO.File]::WriteAllText($sumsPath, (($sumLines -join [Environment]::NewLine) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  $candidate.package.sha256SumsSizeBytes = (Get-Item -LiteralPath $sumsPath).Length
  $candidate.package.sha256SumsSha256 = Get-Sha256 $sumsPath

  $innerPath = Join-Path $Root 'inner-fixture.zip'
  $innerEntries = @(
    [pscustomobject]@{ Name = 'BUILD-INFO.json'; Path = $buildInfoPath },
    [pscustomobject]@{ Name = 'SHA256SUMS'; Path = $sumsPath }
  ) + @($inventoryArray | ForEach-Object {
    [pscustomobject]@{
      Name = [string]$_.path
      Path = Join-Path $packageRoot ([string]$_.path.Replace('/', [IO.Path]::DirectorySeparatorChar))
    }
  })
  $file = [IO.File]::Open($innerPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $archive = [IO.Compression.ZipArchive]::new($file, [IO.Compression.ZipArchiveMode]::Create, $false)
  try {
    foreach ($item in $innerEntries) {
      $entry = $archive.CreateEntry([string]$item.Name, [IO.Compression.CompressionLevel]::NoCompression)
      $input = [IO.File]::OpenRead([string]$item.Path)
      $output = $entry.Open()
      try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
    }
  } finally { $archive.Dispose() }
  $candidate.package.innerEntryCount = $innerEntries.Count
  $candidate.package.innerTotalBytes = [long](($innerEntries | ForEach-Object { (Get-Item -LiteralPath $_.Path).Length } | Measure-Object -Sum).Sum)
  $candidate.package.innerSizeBytes = (Get-Item -LiteralPath $innerPath).Length
  $candidate.package.innerSha256 = Get-Sha256 $innerPath

  $outerPath = Join-Path $Root 'artifact-fixture.zip'
  New-TestZip $outerPath @(@{ Name = [string]$candidate.package.innerName; Bytes = [IO.File]::ReadAllBytes($innerPath) })
  $candidate.artifact.sizeBytes = (Get-Item -LiteralPath $outerPath).Length
  $candidate.package.outerSha256 = Get-Sha256 $outerPath
  $candidate.artifact.digest = 'sha256:' + [string]$candidate.package.outerSha256
  $metadata = [ordered]@{
    id = [long]$candidate.artifact.id
    name = [string]$candidate.artifact.name
    expired = $false
    size_in_bytes = [long]$candidate.artifact.sizeBytes
    digest = [string]$candidate.artifact.digest
    expires_at = [string]$candidate.artifact.expiresAtUtc
    workflow_run = [ordered]@{
      id = [long]$candidate.buildRunId
      head_sha = [string]$candidate.sourceSha
      head_branch = [string]$candidate.branch
    }
  }
  return [pscustomobject]@{
    candidate = $candidate
    expectedInventory = $inventoryArray
    packageRoot = $packageRoot
    innerZipPath = $innerPath
    outerZipPath = $outerPath
    metadataBytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $metadata -Depth 8 -Compress))
    outerZipBytes = [IO.File]::ReadAllBytes($outerPath)
  }
}

function New-TestTransport([object] $Fixture, [string] $Mode = 'success') {
  $capturedCalls = [Collections.ArrayList]::new()
  $capturedFixture = $Fixture
  $capturedMode = $Mode
  $script:transportCalls = $capturedCalls
  $transport = {
    param($Request)
    [void]$capturedCalls.Add($Request)
    $index = $capturedCalls.Count
    switch ($index) {
      1 {
        if ($capturedMode -eq 'transport-secret') {
          throw 'synthetic transport failure https://host.invalid/blob?sv=secret&sig=FAKE_SAS_MUST_NOT_LEAK synthetic-api-token'
        }
        $body = [byte[]]$capturedFixture.metadataBytes
        return [pscustomobject]@{
          StatusCode = if ($capturedMode -eq 'metadata-status') { 404 } else { 200 }
          Headers = [ordered]@{ 'Content-Length' = [string]$body.LongLength }
          BodyBytes = $body
        }
      }
      2 {
        $location = 'https://productionresultssa16.blob.core.windows.net/container/artifact.zip?sv=synthetic&sig=FAKE_SAS_MUST_NOT_LEAK'
        if ($capturedMode -eq 'redirect-host') { $location = 'https://attacker.example/blob?sig=FAKE_SAS_MUST_NOT_LEAK' }
        return [pscustomobject]@{
          StatusCode = if ($capturedMode -eq 'redirect-status') { 200 } else { 302 }
          Headers = [ordered]@{ Location = $location; 'Content-Length' = '0' }
          BodyBytes = [byte[]]@()
        }
      }
      3 {
        $body = [byte[]]$capturedFixture.outerZipBytes
        $length = $body.LongLength
        if ($capturedMode -eq 'blob-length') { $length++ }
        if ($capturedMode -eq 'blob-digest') { $body[0] = $body[0] -bxor 0xFF }
        return [pscustomobject]@{
          StatusCode = if ($capturedMode -eq 'blob-status') { 302 } else { 200 }
          Headers = [ordered]@{ 'Content-Length' = [string]$length }
          BodyBytes = $body
        }
      }
      default { throw 'Unexpected extra HTTP request.' }
    }
  }
  return $transport.GetNewClosure()
}

function New-TestEdgeArchive([string] $Path, [byte[]] $ExecutableBytes) {
  if ($null -eq $ExecutableBytes) { $ExecutableBytes = New-TestPeBytes -WithoutResourceDirectory }
  New-TestZip $Path @(
    @{ Name = 'msedgedriver.exe'; Bytes = $ExecutableBytes },
    @{ Name = 'LICENSE'; Content = 'Synthetic Microsoft Edge WebDriver license fixture.' }
  )
  return [IO.File]::ReadAllBytes($Path)
}

function New-TestEdgeCatalog([long] $ArchiveSize, [string] $Version = '156.0.4314.84', [string] $GeneratedAt = '2026-11-22T03:00:00.1234567Z', [string] $LastModified = '2026-11-22T02:00:00.7654321Z', [string] $Platform = 'win64') {
  $catalog = [ordered]@{
    generatedAt = $GeneratedAt
    items = @(
      [ordered]@{ name = ($Version + '/edgedriver_' + $Platform + '.zip'); isDirectory = $false; contentLength = $ArchiveSize; lastModified = $LastModified },
      [ordered]@{ name = 'LATEST_STABLE'; isDirectory = $false; contentLength = 64; lastModified = $LastModified },
      [ordered]@{ name = 'listing.json'; isDirectory = $false; contentLength = 1024; lastModified = $LastModified }
    )
  }
  $json = ConvertTo-Json -InputObject $catalog -Depth 8 -Compress
  return [Text.UTF8Encoding]::new($false).GetBytes($json)
}

function New-TestEdgeTransport([byte[]] $CatalogBytes, [byte[]] $ArchiveBytes, [string] $Mode = 'success') {
  $calls = [Collections.ArrayList]::new()
  $capturedCatalog = $CatalogBytes
  $capturedArchive = $ArchiveBytes
  $capturedMode = $Mode
  $transport = {
    param($Request)
    [void]$calls.Add($Request)
    if ($Request.allowAutoRedirect -ne $false -or $Request.headers.Count -ne 0) {
      throw 'EdgeDriver requests must disable redirects and credentials.'
    }
    if ($Request.uri -ceq 'https://msedgedriver.microsoft.com/listing.json') {
      $status = if ($capturedMode -eq 'catalog-redirect') { 302 } elseif ($capturedMode -eq 'catalog-error') { 503 } else { 200 }
      $contentType = if ($capturedMode -eq 'catalog-content-type') { 'text/plain' } else { 'application/json' }
      return [pscustomobject]@{
        StatusCode = $status
        Headers = [ordered]@{ 'Content-Type' = $contentType; 'Content-Length' = [string]$capturedCatalog.LongLength }
        BodyBytes = [byte[]]$capturedCatalog
      }
    }
    if ($Request.uri -match '^https://msedgedriver\.microsoft\.com/156\.0\.4314\.84/edgedriver_win64\.zip$' -and
        -not [string]::IsNullOrEmpty([string]$Request.destination)) {
      $status = if ($capturedMode -eq 'archive-redirect') { 302 } else { 200 }
      $contentType = if ($capturedMode -eq 'archive-content-type') { 'text/plain' } else { 'application/zip' }
      $bytes = [byte[]]$capturedArchive
      $length = $bytes.LongLength
      if ($capturedMode -eq 'archive-length-header') { $length++ }
      return [pscustomobject]@{
        StatusCode = $status
        Headers = [ordered]@{ 'Content-Type' = $contentType; 'Content-Length' = [string]$length }
        BodyBytes = $bytes
      }
    }
    throw 'The EdgeDriver transport received an unexpected URL or request.'
  }
  return [pscustomobject]@{ Callback = $transport.GetNewClosure(); Calls = $calls }
}

function New-TestEdgeProbe([string] $Mode = 'success') {
  $calls = [Collections.ArrayList]::new()
  $capturedMode = $Mode
  $probe = {
    param($Request)
    [void]$calls.Add($Request)
    if ($Request.arguments.Count -ne 1 -or $Request.arguments[0] -cne '--version') {
      throw 'The EdgeDriver probe may only invoke --version.'
    }
    return [pscustomobject]@{
      ExitCode = if ($capturedMode -eq 'probe-exit') { 5 } else { 0 }
      StdOut = if ($capturedMode -eq 'probe-pin') { 'MSEdgeDriver 156.0.4314.85 (fixture)' } elseif ($capturedMode -eq 'probe-unbranded') { 'FakeDriver 156.0.4314.84' } else { 'MSEdgeDriver 156.0.4314.84 (fixture)' }
      StdErr = ''
      TimedOut = ($capturedMode -eq 'probe-timeout')
      OutputLimitExceeded = ($capturedMode -eq 'probe-output')
    }
  }
  return [pscustomobject]@{ Callback = $probe.GetNewClosure(); Calls = $calls }
}

function New-TestStageIdentity {
  return [pscustomobject]@{
    gate = [ordered]@{
      repository = 'hodeliun/Morrow'
      ref = 'refs/heads/codex/e003-g07-windows-runtime'
      workflowPath = '.github/workflows/pilot-windows-first-launch-preflight.yml'
      workflowRef = 'hodeliun/Morrow/.github/workflows/pilot-windows-first-launch-preflight.yml@refs/heads/codex/e003-g07-windows-runtime'
      sourceSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      gateRunId = '98765432101'
      gateRunAttempt = '1'
      event = 'push'
    }
    runner = [ordered]@{ os = 'Windows'; arch = 'X64'; tempRoot = 'C:\runner\_temp'; workspace = 'C:\morrow\checkout' }
  }
}

function New-TestVerifiedPinnedPackage {
  return [pscustomobject]@{
    receipt = [ordered]@{
      schema = 'morrow.e003.g23.verified-package.v1'
      status = 'verified'
      candidateBuildRunId = '44961916968'
      candidateBuildRunAttempt = '1'
      artifact = [ordered]@{ id = '14730062702' }
      packageInventory = Get-FirstLaunchInventory
      packageInventorySha256 = 'd8d4e6cb1a419cc342f9f63f43c5931cc1d3feb6041a4a1f7d104167104b9baf'
    }
  }
}

function New-TestTauriDriverDto([string] $Hash = ('a' * 64)) {
  return [ordered]@{
    version = '2.1.0'
    source = 'crates.io'
    sourceUrl = 'https://crates.io/crates/tauri-driver/2.1.0'
    downloadUrl = 'https://crates.io/api/v1/crates/tauri-driver/2.1.0/download'
    cargoVersion = 'cargo 1.91.0'
    installCommand = 'cargo install tauri-driver --version 2.1.0 --locked --root <tool-stage>'
    executableSha256 = $Hash
    serviceStarted = $false
  }
}

function Assert-StageAcceptedByGate([string] $StagePath, [string] $Workspace) {
  $node = (Get-Command node -ErrorAction Stop).Source
  $inline = @'
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createBinding, FIRST_LAUNCH_CANDIDATE, WINDOWS_FIRST_LAUNCH_GATE } from './scripts/pilot/windows-first-launch-gate.mjs';
const stagePath = process.argv[1];
const workspacePath = process.argv[2];
const stageBytes = readFileSync(stagePath);
const stage = JSON.parse(stageBytes.toString('utf8'));
const context = {
  ...stage.gate,
  runner: { os: stage.runner.os, arch: stage.runner.arch, tempRoot: stage.runner.tempRoot, workspace: 'C:\\morrow\\checkout' },
};
const sourceHashes = WINDOWS_FIRST_LAUNCH_GATE.sourcePaths.map((filePath, index) => ({
  path: filePath, sha256: String(index + 1).padStart(64, '0'), sizeBytes: 10 + index,
}));
const profileRoot = path.win32.join(stage.runner.tempRoot, 'morrow-issue-187-' + stage.gate.sourceSha + '-' + stage.gate.gateRunId + '-1', 'profile');
const digest = createHash('sha256').update(stageBytes).digest('hex');
const checkedAtUtc = new Date(Date.parse(stage.stagedAtUtc) + 1000).toISOString();
const receipt = {
  schema: 'morrow.e003.g15.first-launch-check-only-receipt.v1',
  status: 'passed', purpose: 'first-windows-launch', executionPhase: 'protected-check-only',
  gate: stage.gate, candidateBuild: FIRST_LAUNCH_CANDIDATE, stageSha256: digest, pinsVerified: true,
  driverHashes: {
    tauriDriverSha256: stage.drivers.tauriDriver.executableSha256,
    edgeDriverSha256: stage.drivers.edgeDriver.executableSha256,
  },
  webView2RuntimeVersion: stage.webView2Runtime.version,
  identity: { sid: 'S-1-5-21-100-200-300-1001' },
  knownFolders: { localAppData: 'C:\\Users\\runneradmin\\AppData\\Local', roamingAppData: 'C:\\Users\\runneradmin\\AppData\\Roaming' },
  profiles: {
    root: profileRoot,
    morrowUserData: path.win32.join(profileRoot, 'MorrowUserData'),
    webView2UserData: path.win32.join(profileRoot, 'WebView2UserData'),
  },
  noLaunch: { appLaunched: false, driverServiceStarted: false, guiTested: false },
  checkedAtUtc,
};
const checked = createBinding({
  context, sourceHashes, stageBytes,
  checkOnlyReceiptBytes: Buffer.from(JSON.stringify(receipt), 'utf8'),
  now: Date.parse('2026-11-22T04:00:00.000Z'),
});
process.stdout.write(checked.binding.stage.schema);
'@
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $node
  $start.WorkingDirectory = $Workspace
  $start.UseShellExecute = $false
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  [void]$start.ArgumentList.Add('--input-type=module')
  [void]$start.ArgumentList.Add('-e')
  [void]$start.ArgumentList.Add($inline)
  [void]$start.ArgumentList.Add($StagePath)
  [void]$start.ArgumentList.Add($Workspace)
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  if (-not $process.Start()) { throw 'The local gate DTO validator did not start.' }
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(30000)) { try { $process.Kill($true) } catch {}; throw 'The local gate DTO validator exceeded its test deadline.' }
  $outText = $stdout.GetAwaiter().GetResult()
  $errText = $stderr.GetAwaiter().GetResult()
  $exitCode = $process.ExitCode
  $process.Dispose()
  if ($exitCode -ne 0 -or $outText -cne 'morrow.e003.g15.first-launch-stage.v1') {
    throw "The generated Stage DTO failed the independent Node gate validator: $errText $outText"
  }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ('morrow-first-launch-preflight-tests-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$readOnlyTree = $null
try {
  $jobHelperPath = Join-Path $PSScriptRoot 'windows-native-job.ps1'
  $verifiedJobHelperSource = Get-FirstLaunchVerifiedNativeJobHelperScriptBlock $jobHelperPath
  Assert-True ($verifiedJobHelperSource -is [scriptblock] -and
    $verifiedJobHelperSource.ToString().Contains('CreateAtomicSuspendedRoot')) 'native Job helper source is strict-decoded and matches its immutable SHA pin'
  $verifiedJobModule = Import-FirstLaunchVerifiedNativeJobHelperModule $jobHelperPath
  Assert-True ($verifiedJobModule.ExportedFunctions.ContainsKey('CreateAtomicSuspendedRoot')) 'exact pinned Job helper bytes load into the private module'
  Remove-Module -ModuleInfo $verifiedJobModule -Force
  $mutatedJobHelperPath = Join-Path $root 'windows-native-job-mutated.ps1'
  [IO.File]::Copy($jobHelperPath, $mutatedJobHelperPath)
  $mutatedJobHelperBytes = [IO.File]::ReadAllBytes($mutatedJobHelperPath)
  $mutatedJobHelperBytes[0] = $mutatedJobHelperBytes[0] -bxor 1
  [IO.File]::WriteAllBytes($mutatedJobHelperPath, $mutatedJobHelperBytes)
  Assert-Throws 'mutated native Job helper is rejected before module import' {
    Import-FirstLaunchVerifiedNativeJobHelperModule $mutatedJobHelperPath
  }
  Assert-True ($null -eq (Get-Module -Name MorrowFirstLaunchNativeJob)) 'mutated helper bytes are not imported into the private module'
  if ([IO.Path]::DirectorySeparatorChar -eq '/') {
    $linkedJobHelperPath = Join-Path $root 'windows-native-job-linked.ps1'
    [void][IO.File]::CreateSymbolicLink($linkedJobHelperPath, $jobHelperPath)
    Assert-Throws 'native Job helper reparse path is rejected before source read' {
      Import-FirstLaunchVerifiedNativeJobHelperModule $linkedJobHelperPath
    }
    Assert-True ($null -eq (Get-Module -Name MorrowFirstLaunchNativeJob)) 'reparse helper path is rejected before private module import'
    [IO.File]::Delete($linkedJobHelperPath)
  }

  $pins = Get-FirstLaunchPins
  $inventoryPin = Get-FirstLaunchInventory
  Assert-True ($pins.sourceSha -eq 'bdf54cd4eb6f20e63664c00cf46209a5c941065e') 'candidate source pin'
  Assert-True ($pins.artifact.id -eq '14730062702' -and $pins.artifact.sizeBytes -eq 31988714) 'artifact identity and size pin'
  Assert-True ($pins.package.innerEntryCount -eq 21 -and $pins.package.fileInventoryCount -eq 19 -and $inventoryPin.Count -eq 19) '21 ZIP entries and canonical 19-file inventory pins'
  $pinBytes = Get-FirstLaunchCanonicalInventoryBytes $inventoryPin
  Assert-True ((Get-TestSha256 $pinBytes) -eq $pins.package.canonicalInventorySha256) 'PowerShell canonical 19-entry invoice digest'
  $mutablePins = Get-FirstLaunchPins
  $mutableInventory = Get-FirstLaunchInventory
  $mutablePins.package.innerSha256 = '0' * 64
  $mutablePins.artifact.id = '1'
  $mutableInventory[0].path = 'mutated/path'
  $freshPins = Get-FirstLaunchPins
  $freshInventory = Get-FirstLaunchInventory
  Assert-True ($freshPins.package.innerSha256 -eq $pins.package.innerSha256 -and $freshPins.artifact.id -eq $pins.artifact.id) 'candidate getter returns deep detached copies'
  Assert-True ($freshInventory[0].path -eq $inventoryPin[0].path) 'inventory getter returns deep detached copies'

  $helperModule = Get-Module MorrowFirstLaunchNeutralZipHelpers -All | Select-Object -First 1
  Assert-True ($null -ne $helperModule) 'isolated legacy helper module was imported'
  Assert-True ($helperModule.ExportedFunctions.Keys -contains 'Assert-ZipArchiveSafe' -and
    $helperModule.ExportedFunctions.Keys -contains 'Expand-SafeZipArchive') 'only neutral ZIP entrypoints are exported from the helper module'
  Assert-True ($null -eq (Get-Variable -Name Artifact -Scope Script -ErrorAction SilentlyContinue)) 'legacy Artifact pin is not visible in the caller scope'

  $metadataCandidate = Copy-TestCandidate
  $metadataCandidate.artifact.expiresAtUtc = '2099-12-31T23:59:59.000Z'
  $metadata = [ordered]@{
    id = [long]$metadataCandidate.artifact.id
    name = [string]$metadataCandidate.artifact.name
    expired = $false
    size_in_bytes = [long]$metadataCandidate.artifact.sizeBytes
    digest = [string]$metadataCandidate.artifact.digest
    expires_at = [string]$metadataCandidate.artifact.expiresAtUtc
    workflow_run = [ordered]@{ id = [long]$metadataCandidate.buildRunId; head_sha = [string]$metadataCandidate.sourceSha; head_branch = [string]$metadataCandidate.branch }
  }
  $verifiedMetadata = Assert-PinnedArtifactMetadata $metadata $metadataCandidate
  Assert-True ($verifiedMetadata.artifactId -eq '14730062702' -and $verifiedMetadata.expired -eq $false) 'pinned GitHub metadata acceptance'
  foreach ($mutant in @(
    @{ Field = 'id'; Value = 1 },
    @{ Field = 'name'; Value = 'other-artifact' },
    @{ Field = 'expired'; Value = $true },
    @{ Field = 'expired'; Value = 'false' },
    @{ Field = 'expired'; Value = 0 },
    @{ Field = 'size_in_bytes'; Value = 1 },
    @{ Field = 'digest'; Value = 'sha256:' + ('0' * 64) }
  )) {
    $badMetadata = ConvertFrom-Json -InputObject (ConvertTo-Json -InputObject $metadata -Depth 8 -Compress) -AsHashtable
    $badMetadata[$mutant.Field] = $mutant.Value
    Assert-Throws "metadata mutant $($mutant.Field)" { Assert-PinnedArtifactMetadata $badMetadata $metadataCandidate }
  }
  $missingExpired = ConvertFrom-Json -InputObject (ConvertTo-Json -InputObject $metadata -Depth 8 -Compress) -AsHashtable
  [void]$missingExpired.Remove('expired')
  Assert-Throws 'metadata missing strict expired boolean' { Assert-PinnedArtifactMetadata $missingExpired $metadataCandidate }
  $elapsedMetadata = ConvertFrom-Json -InputObject (ConvertTo-Json -InputObject $metadata -Depth 8 -Compress) -AsHashtable
  $elapsedMetadata.expires_at = '2020-01-01T00:00:00.000Z'
  Assert-Throws 'metadata elapsed expiry rejected' { Assert-PinnedArtifactMetadata $elapsedMetadata $metadataCandidate }
  $elapsedCandidate = Copy-TestCandidate
  $elapsedCandidate.artifact.expiresAtUtc = '2020-01-01T00:00:00.000Z'
  Assert-Throws 'pinned candidate elapsed expiry rejected' { Assert-FirstLaunchCandidateNotExpired $elapsedCandidate }
  $wrongRun = ConvertFrom-Json -InputObject (ConvertTo-Json -InputObject $metadata -Depth 8 -Compress) -AsHashtable
  $wrongRun.workflow_run.head_sha = '0' * 40
  Assert-Throws 'metadata source SHA mutant' { Assert-PinnedArtifactMetadata $wrongRun $metadataCandidate }

  $goodBlob = 'https://productionresultssa16.blob.core.windows.net/container/artifact.zip?sv=synthetic&sig=secret'
  Assert-True ((Assert-FirstLaunchBlobUri $goodBlob).Host -eq 'productionresultssa16.blob.core.windows.net') 'official blob redirect host accepted'
  foreach ($badUri in @(
    'http://productionresultssa16.blob.core.windows.net/a?sig=x',
    'https://attacker.example/a?sig=x',
    'https://user@productionresultssa16.blob.core.windows.net/a?sig=x',
    'https://productionresultssa16.blob.core.windows.net:444/a?sig=x',
    'https://productionresultssa16.blob.core.windows.net/a?sig=x#fragment'
  )) { Assert-Throws "redirect URI rejected: $($badUri.Split('?')[0])" { Assert-FirstLaunchBlobUri $badUri } }

  $safeZip = Join-Path $root 'safe.zip'
  New-TestZip $safeZip @(@{ Name = 'safe/file.txt'; Content = 'synthetic bytes' })
  $safeValidation = Assert-FirstLaunchZipPolicy $safeZip 1 15
  Assert-True ($safeValidation.EntryCount -eq 1) 'safe package ZIP path and CRC accepted'

  $traversal = Join-Path $root 'traversal.zip'
  New-TestZip $traversal @(@{ Name = '../outside.txt'; Content = 'no-write' })
  Assert-Throws 'ZIP traversal rejected before expansion' { Assert-FirstLaunchZipPolicy $traversal }
  $absolute = Join-Path $root 'absolute.zip'
  New-TestZip $absolute @(@{ Name = '/outside.txt'; Content = 'no-write' })
  Assert-Throws 'ZIP absolute path rejected before expansion' { Assert-FirstLaunchZipPolicy $absolute }
  $stream = Join-Path $root 'stream.zip'
  New-TestZip $stream @(@{ Name = 'safe/file.txt:alternate'; Content = 'no-write' })
  Assert-Throws 'ZIP alternate data stream rejected' { Assert-FirstLaunchZipPolicy $stream }
  $caseDuplicate = Join-Path $root 'case-duplicate.zip'
  New-TestZip $caseDuplicate @(
    @{ Name = 'DemoVault/one.txt'; Content = 'one' },
    @{ Name = 'demovault/two.txt'; Content = 'two' }
  )
  Assert-Throws 'case-folded ZIP path collision rejected' { Assert-FirstLaunchZipPolicy $caseDuplicate }
  $shortAlias = Join-Path $root 'short-alias.zip'
  New-TestZip $shortAlias @(@{ Name = 'DemoVault/PROGRA~1.txt'; Content = 'alias' })
  Assert-Throws 'Windows 8.3 short-name alias rejected' { Assert-FirstLaunchZipPolicy $shortAlias }
  foreach ($aliasName in @('FOO~10', 'PROGRA~10.txt', 'PROGRA~10/child.txt', 'PROGRA~10/')) {
    $aliasPath = Join-Path $root ('alias-' + [Guid]::NewGuid().ToString('N') + '.zip')
    $aliasEntry = @{ Name = ('DemoVault/' + $aliasName); Content = 'alias' }
    if ($aliasName.EndsWith('/')) { $aliasEntry = @{ Name = ('DemoVault/' + $aliasName); Bytes = [byte[]]@() } }
    New-TestZip $aliasPath @($aliasEntry)
    Assert-Throws "Windows 8.3 short-name alias rejected: $aliasName" { Assert-FirstLaunchZipPolicy $aliasPath }
    $aliasDestination = Join-Path $root ('alias-dest-' + [Guid]::NewGuid().ToString('N'))
    Assert-Throws "short-name alias rejected before expansion: $aliasName" { Expand-FirstLaunchSafeZipArchive $aliasPath $aliasDestination 0 -1 }
    Assert-True (-not [IO.Directory]::Exists($aliasDestination)) "invalid alias creates no extraction root: $aliasName"
  }
  $outerAlias = Join-Path $root 'outer-alias.zip'
  New-TestZip $outerAlias @(@{ Name = 'art~10.zip'; Content = 'inner' })
  Assert-Throws 'outer ZIP short-name alias rejected' { Assert-FirstLaunchZipPolicy $outerAlias }
  $outerAliasDestination = Join-Path $root 'outer-alias-dest'
  Assert-Throws 'outer ZIP alias rejected before extraction' { Expand-FirstLaunchSafeZipArchive $outerAlias $outerAliasDestination 1 5 }
  Assert-True (-not [IO.Directory]::Exists($outerAliasDestination)) 'outer ZIP alias creates no extraction root'
  $nonCanonicalUnicode = Join-Path $root 'noncanonical-unicode.zip'
  $nfcSegment = "Caf$([char]0x00E9).md"
  $nfdSegment = "Cafe$([char]0x0301).md"
  $nfcPath = 'DemoVault/' + $nfcSegment
  $nfdPath = 'DemoVault/' + $nfdSegment
  Assert-True ([string]::Equals($nfdPath.Normalize([Text.NormalizationForm]::FormC), $nfcPath, [StringComparison]::Ordinal) -and
    -not [string]::Equals($nfdPath, $nfcPath, [StringComparison]::Ordinal)) 'NFD and NFC paths are distinct ordinal strings before normalization'
  Assert-Throws 'direct path guard rejects NFD by ordinal comparison' { Get-FirstLaunchZipPathPolicy $nfdPath $false }
  New-TestZip $nonCanonicalUnicode @(@{ Name = $nfdPath; Content = 'unicode' })
  Assert-Throws 'non-NFC Unicode path rejected' { Assert-FirstLaunchZipPolicy $nonCanonicalUnicode }
  $canonicalCollision = Join-Path $root 'case-collision.zip'
  New-TestZip $canonicalCollision @(
    @{ Name = 'DemoVault/Readme.md'; Content = 'one' },
    @{ Name = 'demovault/readme.MD'; Content = 'two' }
  )
  Assert-Throws 'OrdinalIgnoreCase path collision rejected' { Assert-FirstLaunchZipPolicy $canonicalCollision }

  $invalidZipPathIndex = 0
  foreach ($invalidCharacter in @('<', '>', '"', '|', '?', '*', [char]0x0001)) {
    $innerBadPath = Join-Path $root ('invalid-inner-' + $invalidZipPathIndex + '.zip')
    New-TestZip $innerBadPath @(@{ Name = ('DemoVault/bad' + $invalidCharacter + '.txt'); Content = 'bad' })
    Assert-Throws "inner ZIP rejects Windows-invalid path char U+$('{0:X4}' -f [int][char]$invalidCharacter)" { Assert-FirstLaunchZipPolicy $innerBadPath }
    $innerBadDestination = Join-Path $root ('invalid-inner-dest-' + $invalidZipPathIndex)
    Assert-Throws "inner ZIP invalid path rejected before extraction $invalidZipPathIndex" { Expand-FirstLaunchSafeZipArchive $innerBadPath $innerBadDestination 0 -1 }
    Assert-True (-not [IO.Directory]::Exists($innerBadDestination)) "inner ZIP invalid path creates no root $invalidZipPathIndex"

    $outerBadPath = Join-Path $root ('invalid-outer-' + $invalidZipPathIndex + '.zip')
    New-TestZip $outerBadPath @(@{ Name = ('artifact' + $invalidCharacter + '.zip'); Content = 'bad' })
    Assert-Throws "outer ZIP rejects Windows-invalid path char U+$('{0:X4}' -f [int][char]$invalidCharacter)" { Assert-FirstLaunchZipPolicy $outerBadPath }
    $invalidZipPathIndex++
  }

  $readOnlyTree = Join-Path $root 'readonly-package-tree'
  $readOnlyTarget = Join-Path $root 'readonly-link-target'
  [void][IO.Directory]::CreateDirectory((Join-Path $readOnlyTree 'safe'))
  [void][IO.Directory]::CreateDirectory($readOnlyTarget)
  [IO.File]::WriteAllText((Join-Path $readOnlyTree 'safe/keep.txt'), 'read-only tree fixture')
  $linkPath = Join-Path $readOnlyTree 'empty-link'
  if ([IO.Path]::DirectorySeparatorChar -eq '\') {
    [void](New-Item -ItemType Junction -Path $linkPath -Target $readOnlyTarget -ErrorAction Stop)
  } else {
    [void][IO.Directory]::CreateSymbolicLink($linkPath, $readOnlyTarget)
  }
  [IO.File]::SetAttributes($readOnlyTree, [IO.FileAttributes]::ReadOnly)
  Assert-True (([IO.File]::GetAttributes($linkPath) -band [IO.FileAttributes]::ReparsePoint) -ne 0) 'empty directory link is identified as reparse before scan'
  Assert-Throws 'bounded top-down inventory rejects empty symlink before descent in read-only root' {
    Get-FirstLaunchPackageTree $readOnlyTree @('safe/keep.txt')
  }
  $plainTree = Join-Path $root 'plain-package-tree'
  [void][IO.Directory]::CreateDirectory((Join-Path $plainTree 'safe'))
  [void][IO.Directory]::CreateDirectory((Join-Path $plainTree 'empty-extra'))
  [IO.File]::WriteAllText((Join-Path $plainTree 'safe/keep.txt'), 'plain tree fixture')
  Assert-Throws 'inventory rejects an unexpected empty directory path' { Get-FirstLaunchPackageTree $plainTree @('safe/keep.txt') }
  Assert-Throws 'inventory rejects a missing expected file path' { Get-FirstLaunchPackageTree $plainTree @('safe/keep.txt', 'missing.txt') }
  $oversizedExpectedTree = @(1..1025 | ForEach-Object { 'file-' + $_ + '.txt' })
  Assert-Throws 'inventory expected tree has a bounded directory and file count' { Get-FirstLaunchPackageTree $plainTree $oversizedExpectedTree }
  $symlink = Join-Path $root 'symlink.zip'
  New-TestZip $symlink @(@{ Name = 'link.txt'; Content = 'target'; ExternalAttributes = -1577123840 })
  Assert-Throws 'ZIP reparse/symlink entry rejected' { Assert-FirstLaunchZipPolicy $symlink }
  $badCrc = Join-Path $root 'bad-crc.zip'
  New-TestZip $badCrc @(@{ Name = 'data.bin'; Content = 'bytes that will be corrupted' })
  Corrupt-TestZipPayload $badCrc
  Assert-Throws 'ZIP CRC mismatch rejected' { Assert-FirstLaunchZipPolicy $badCrc }

  $fixture = New-TestPackageFixture $root
  $stage = Join-Path $root 'verified-stage'
  $liveOverrideStage = Join-Path $root 'live-override-stage'
  $pinnedTransportStage = Join-Path $root 'pinned-transport-stage'
  $pinnedTransport = New-TestTransport $fixture
  Assert-Throws 'hermetic transport requires explicit synthetic candidate and inventory' {
    Get-FirstLaunchVerifiedPackage 'synthetic-api-token' $pinnedTransportStage $pins $inventoryPin $pinnedTransport
  }
  Assert-True ($script:transportCalls.Count -eq 0 -and -not [IO.Directory]::Exists($pinnedTransportStage)) 'pinned candidate cannot use offline transport path or create stage'
  Assert-Throws 'live network path refuses test candidate overrides' {
    Get-FirstLaunchVerifiedPackage 'synthetic-api-token' $liveOverrideStage $fixture.candidate $fixture.expectedInventory
  }
  Assert-True (-not [IO.Directory]::Exists($liveOverrideStage)) 'live candidate override is rejected before staging or network access'
  $expiredStage = Join-Path $root 'expired-candidate-stage'
  $expiredCandidate = Copy-FirstLaunchValue $fixture.candidate
  $expiredCandidate.artifact.expiresAtUtc = '2020-01-01T00:00:00.000Z'
  $expiredTransport = New-TestTransport $fixture
  Assert-Throws 'expired package candidate rejected before transport or stage creation' {
    Get-FirstLaunchVerifiedPackage 'synthetic-api-token' $expiredStage $expiredCandidate $fixture.expectedInventory $expiredTransport
  }
  Assert-True ($script:transportCalls.Count -eq 0 -and -not [IO.Directory]::Exists($expiredStage)) 'expired candidate cannot request or publish bytes'
  $livePinnedStage = Join-Path $root 'live-pinned-stage'
  Assert-Throws 'live caller snapshots are accepted structurally then blocked at local runner stage boundary' {
    Get-FirstLaunchVerifiedPackage 'synthetic-api-token' $livePinnedStage (Get-FirstLaunchPins) (Get-FirstLaunchInventory)
  }
  Assert-True (-not [IO.Directory]::Exists($livePinnedStage)) 'live stage boundary rejects an unsafe platform/path before network or stage creation'
  $successTransport = New-TestTransport $fixture
  $verified = Get-FirstLaunchVerifiedPackage 'synthetic-api-token' $stage $fixture.candidate $fixture.expectedInventory $successTransport
  Assert-True ($verified.receipt.schema -eq 'morrow.e003.g23.verified-package.v1' -and $verified.receipt.status -eq 'verified') 'verified package receipt schema'
  Assert-True ($verified.receipt.packageInventory.Count -eq 19 -and $verified.receipt.packageInventorySha256 -eq $fixture.candidate.package.canonicalInventorySha256) 'verified package forwards exact inventory and digest'
  Assert-True ($verified.receipt.noLaunch.appLaunched -eq $false -and $verified.receipt.noLaunch.launcherExecuted -eq $false -and
    $verified.receipt.noLaunch.driverServiceStarted -eq $false -and $verified.receipt.noLaunch.guiTested -eq $false) 'receipt explicitly records no launcher, app, GUI, or driver execution'
  Assert-True ($script:transportCalls.Count -eq 3) 'exactly three GET requests used'
  Assert-True ($script:transportCalls[0].uri -match '^https://api\.github\.com/repos/hodeliun/Morrow/actions/artifacts/14730062702$' -and
    $script:transportCalls[0].headers.Authorization -eq 'Bearer synthetic-api-token') 'metadata request uses fixed API endpoint and bearer'
  Assert-True ($script:transportCalls[1].uri -match '/actions/artifacts/14730062702/zip$' -and
    $script:transportCalls[1].headers.Authorization -eq 'Bearer synthetic-api-token') 'ZIP redirect request uses fixed API endpoint and bearer'
  Assert-True ($script:transportCalls[2].uri -match '^https://productionresultssa16\.blob\.core\.windows\.net/' -and
    -not $script:transportCalls[2].headers.Contains('Authorization')) 'blob request sends no bearer to signed storage'
  Assert-True (@($script:transportCalls | Where-Object { $_.allowAutoRedirect -ne $false }).Count -eq 0) 'redirects are disabled on all requests'
  Assert-True ($script:transportCalls[2].maxBytes -eq $fixture.candidate.artifact.sizeBytes -and $script:transportCalls[2].timeoutMs -le 120000) 'blob request has byte and deadline limits'
  $receiptText = [IO.File]::ReadAllText($verified.receiptPath)
  Assert-True (-not $receiptText.Contains('synthetic-api-token') -and -not $receiptText.Contains('FAKE_SAS_MUST_NOT_LEAK')) 'receipt excludes API token and signed redirect query'
  Assert-True ([IO.File]::Exists((Join-Path $verified.packageRoot 'morrow.exe')) -and [IO.File]::Exists((Join-Path $verified.packageRoot 'windows-launch.ps1'))) 'verified synthetic package extracted without launching executable or launcher'

  $occupiedPart = Join-Path $root 'occupied.part'
  [IO.File]::WriteAllText($occupiedPart, 'do not replace', [Text.UTF8Encoding]::new($false))
  $occupiedPartTransport = { param($Request) [pscustomobject]@{ StatusCode = 200; Headers = @{}; BodyBytes = [Text.Encoding]::UTF8.GetBytes('replacement') } }.GetNewClosure()
  Assert-Throws 'HTTP test body uses create-new semantics for an occupied partial path' {
    Invoke-FirstLaunchHttpGet ([uri]$goodBlob) @{} 1000 64 $occupiedPart $occupiedPartTransport
  }
  Assert-True ([IO.File]::ReadAllText($occupiedPart) -ceq 'do not replace') 'occupied .part file content remains unchanged'

  $receiptCollisionStage = Join-Path $root 'receipt-collision-stage'
  $receiptCollisionState = @{ receiptPath = $null }
  $receiptCollisionBaseTransport = New-TestTransport $fixture
  $receiptCollisionTransport = {
    param($Request)
    if ($Request.destination) {
      $downloadsPath = [IO.Path]::GetDirectoryName([string]$Request.destination)
      $stagePath = [IO.Path]::GetDirectoryName($downloadsPath)
      $receiptCollisionState.receiptPath = Join-Path $stagePath 'verified-package.json'
      [IO.File]::WriteAllText($receiptCollisionState.receiptPath, 'preserve existing receipt', [Text.UTF8Encoding]::new($false))
    }
    & $receiptCollisionBaseTransport $Request
  }.GetNewClosure()
  Assert-Throws 'verified-package receipt uses create-new semantics' {
    Get-FirstLaunchVerifiedPackage 'synthetic-api-token' $receiptCollisionStage $fixture.candidate $fixture.expectedInventory $receiptCollisionTransport
  }
  Assert-True ([IO.File]::ReadAllText($receiptCollisionState.receiptPath) -ceq 'preserve existing receipt') 'receipt collision does not overwrite existing bytes'

  foreach ($mode in @('metadata-status', 'redirect-status', 'redirect-host', 'blob-status', 'blob-length', 'blob-digest')) {
    $badStage = Join-Path $root ('failed-' + $mode)
    $badTransport = New-TestTransport $fixture $mode
    Assert-Throws "download transport mutant $mode" {
      Get-FirstLaunchVerifiedPackage 'synthetic-api-token' $badStage $fixture.candidate $fixture.expectedInventory $badTransport
    }
    Assert-True (-not [IO.File]::Exists((Join-Path $badStage 'downloads/artifact.zip'))) "failed $mode does not publish an artifact file"
    $partCount = 0
    if ([IO.Directory]::Exists((Join-Path $badStage 'downloads'))) {
      $partCount = @([IO.Directory]::EnumerateFiles((Join-Path $badStage 'downloads'), '*.part')).Count
    }
    Assert-True ($partCount -eq 0) "failed $mode removes partial bytes"
  }

  $secretStage = Join-Path $root 'transport-secret-stage'
  $secretTransport = New-TestTransport $fixture 'transport-secret'
  Assert-ThrowsWithoutSecrets 'raw injected transport exception is replaced at the boundary' {
    Get-FirstLaunchVerifiedPackage 'synthetic-api-token' $secretStage $fixture.candidate $fixture.expectedInventory $secretTransport
  } @('synthetic-api-token', 'FAKE_SAS_MUST_NOT_LEAK', 'sig=secret', 'https://host.invalid')

  $tamperedRoot = Join-Path $root 'tampered-package'
  $tamperedStage = Join-Path $root 'tampered-stage'
  $tamperedFixture = New-TestPackageFixture $tamperedRoot
  $tamperedTransport = New-TestTransport $tamperedFixture
  $tampered = Get-FirstLaunchVerifiedPackage 'synthetic-api-token' $tamperedStage $tamperedFixture.candidate $tamperedFixture.expectedInventory $tamperedTransport
  $tamperedFile = Join-Path $tampered.packageRoot 'DemoVault/Checklist.md'
  [IO.File]::WriteAllText($tamperedFile, 'tampered', [Text.UTF8Encoding]::new($false))
  Assert-Throws 'mutated extracted file hash rejected' { Assert-FirstLaunchPackage $tampered.packageRoot $tampered.innerZipPath $tamperedFixture.candidate $tamperedFixture.expectedInventory }
  $extraFile = Join-Path $tampered.packageRoot 'unlisted.txt'
  [IO.File]::WriteAllText($extraFile, 'extra', [Text.UTF8Encoding]::new($false))
  Assert-Throws 'extra package file rejected' { Assert-FirstLaunchPackageInventory $tampered.packageRoot $tamperedFixture.candidate $tamperedFixture.expectedInventory }

  $precise = ConvertTo-FirstLaunchPreciseCatalogUtc '2026-11-22T03:00:00.1234567Z' 'test timestamp'
  Assert-True ($precise.Text -ceq '2026-11-22T03:00:00.1234567Z') 'catalog timestamps preserve all seven fractional digits'
  foreach ($invalidTimestamp in @(
    '2026-11-22T03:00:00.123456Z',
    '2026-11-22T03:00:00.12345678Z',
    '2026-11-22T03:00:00.1234567+00:00',
    '2025-02-29T03:00:00.1234567Z'
  )) {
    Assert-Throws "noncanonical or impossible seven-digit timestamp rejected: $invalidTimestamp" {
      ConvertTo-FirstLaunchPreciseCatalogUtc $invalidTimestamp 'test timestamp'
    }
  }

  $registryRequests = [Collections.ArrayList]::new()
  $registryReader = {
    param($Request)
    [void]$registryRequests.Add($Request)
    [pscustomobject]@{
      Present = $true
      Value = '156.0.4314.58'
      Kind = 'REG_SZ'
      RegistryPath = [string]$Request.registryPath
    }
  }.GetNewClosure()
  $runtime = Get-FirstLaunchWebView2Observation -RegistryReader $registryReader
  Assert-True ($registryRequests.Count -eq 2 -and @($registryRequests | Where-Object { $_.view -cne 'Registry64' }).Count -eq 0) 'WebView2 observation requests only both documented Registry64 views'
  Assert-True ($runtime.version -ceq '156.0.4314.58' -and $runtime.sources.Count -eq 2) 'matching HKLM/HKCU WebView2 pv values are selected'
  $badRuntimeReader = {
    param($Request)
    $version = if ($Request.hive -ceq 'LocalMachine') { '156.0.4314.58' } else { '155.0.4314.58' }
    [pscustomobject]@{ Present = $true; Value = $version; Kind = 'REG_SZ'; RegistryPath = [string]$Request.registryPath }
  }
  Assert-Throws 'divergent WebView2 machine/user pv values fail closed' { Get-FirstLaunchWebView2Observation -RegistryReader $badRuntimeReader }
  $badPvReader = {
    param($Request)
    [pscustomobject]@{ Present = $true; Value = '156.0.bad.58'; Kind = 'REG_SZ'; RegistryPath = [string]$Request.registryPath }
  }
  Assert-Throws 'malformed WebView2 pv fails closed' { Get-FirstLaunchWebView2Observation -RegistryReader $badPvReader }
  $wrongKindReader = {
    param($Request)
    [pscustomobject]@{ Present = $true; Value = '156.0.4314.58'; Kind = 'OTHER'; RegistryPath = [string]$Request.registryPath }
  }
  Assert-Throws 'non-string WebView2 pv fails closed' { Get-FirstLaunchWebView2Observation -RegistryReader $wrongKindReader }
  $missingRuntimeReader = {
    param($Request)
    [pscustomobject]@{ Present = $false; Value = $null; Kind = $null; RegistryPath = [string]$Request.registryPath }
  }
  Assert-Throws 'missing WebView2 runtime fails closed' { Get-FirstLaunchWebView2Observation -RegistryReader $missingRuntimeReader }

  $systemRootForTools = Join-Path $root 'synthetic-system-root'
  [void][IO.Directory]::CreateDirectory($systemRootForTools)
  $env:SystemRoot = $systemRootForTools
  $toolCache = Join-Path $root 'trusted-tool-cache'
  $cargoDirectory = Join-Path $toolCache 'Rust/1.91.0/bin'
  [void][IO.Directory]::CreateDirectory($cargoDirectory)
  $cargoPath = Join-Path $cargoDirectory 'cargo.exe'
  [IO.File]::WriteAllText($cargoPath, 'synthetic trusted cargo executable', [Text.UTF8Encoding]::new($false))
  $env:RUNNER_TOOL_CACHE = $toolCache
  $env:RUSTUP_HOME = ''
  $tauriStageRoot = Join-Path $root 'tauri-stage-fixture'
  [void][IO.Directory]::CreateDirectory($tauriStageRoot)
  $cargoCalls = [Collections.ArrayList]::new()
  $cargoRunner = {
    param($Request)
    [void]$cargoCalls.Add($Request)
    if ($Request.executable -cne $cargoPath -or $Request.timeoutMs -le 0 -or
        $Request.maximumOutputBytes -le 0 -or $Request.environment.ContainsKey('GITHUB_TOKEN') -or
        $Request.environment.ContainsKey('GH_TOKEN') -or $Request.environment.ContainsKey('CARGO_REGISTRIES_CRATES_IO_INDEX')) {
      throw 'The scoped Cargo request inherited credentials or untrusted configuration.'
    }
    if ($Request.arguments.Count -eq 1 -and $Request.arguments[0] -ceq '--version') {
      return [pscustomobject]@{ ExitCode = 0; StdOut = 'cargo 1.91.0 (fixture build)'; StdErr = ''; TimedOut = $false; OutputLimitExceeded = $false }
    }
    if ($Request.arguments.Count -ge 1 -and $Request.arguments[0] -ceq 'install' -and $Request.arguments -ccontains '--list') {
      return [pscustomobject]@{ ExitCode = 0; StdOut = 'tauri-driver v2.1.0:'; StdErr = ''; TimedOut = $false; OutputLimitExceeded = $false }
    }
    if ($Request.arguments.Count -ge 1 -and $Request.arguments[0] -ceq 'install' -and
        $Request.arguments -ccontains 'tauri-driver') {
      $tauriRootIndex = [Array]::IndexOf([string[]]$Request.arguments, '--root')
      if ($Request.arguments -notcontains '--locked' -or $Request.arguments -notcontains '2.1.0' -or $tauriRootIndex -lt 0) {
        throw 'Cargo install did not use the exact locked driver pin and private root.'
      }
      $privateRoot = [string]$Request.arguments[$tauriRootIndex + 1]
      $privateExe = Join-Path (Join-Path $privateRoot 'bin') 'tauri-driver.exe'
      [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($privateExe))
      [IO.File]::WriteAllBytes($privateExe, [Text.Encoding]::UTF8.GetBytes('synthetic tauri-driver bytes'))
      return [pscustomobject]@{ ExitCode = 0; StdOut = 'installed'; StdErr = ''; TimedOut = $false; OutputLimitExceeded = $false }
    }
    throw 'Unexpected Cargo invocation.'
  }.GetNewClosure()
  $tauri = Get-FirstLaunchTauriDriver -CargoPath $cargoPath -StageRoot $tauriStageRoot -ProcessRunner $cargoRunner
  $tauriExe = Join-Path (Join-Path $tauriStageRoot 'tauri-tool-stage/bin') 'tauri-driver.exe'
  Assert-True ($cargoCalls.Count -eq 3 -and $tauri.version -ceq '2.1.0' -and $tauri.cargoVersion -ceq 'cargo 1.91.0') 'Tauri driver 2.1.0 is selected from scoped Cargo install metadata'
  Assert-True ($tauri.executableSha256 -ceq (Get-TestSha256 ([IO.File]::ReadAllBytes($tauriExe))) -and $tauri.serviceStarted -eq $false) 'Tauri executable hash is measured without executing the driver'
  Assert-True ($cargoCalls[1].arguments -join ' ' -match '^install tauri-driver --version 2\.1\.0 --locked --root ') 'Tauri Cargo install uses the locked 2.1.0 command'
  Assert-True ($cargoCalls[1].environment['CARGO_HOME'] -like ($tauriStageRoot + '*') -and
    $cargoCalls[1].environment['HOME'] -eq $cargoCalls[1].environment['CARGO_HOME'] -and
    $cargoCalls[1].environment['CARGO_TARGET_DIR'] -like ($tauriStageRoot + '*')) 'Cargo home, target, and working state stay under the run-private stage'
  Assert-Throws 'Cargo outside the trusted tool cache is rejected before invocation' {
    $untrustedCargoStage = Join-Path $root 'untrusted-cargo-stage'
    [void][IO.Directory]::CreateDirectory($untrustedCargoStage)
    Get-FirstLaunchTauriDriver -CargoPath '/tmp/untrusted/cargo.exe' -StageRoot $untrustedCargoStage -ProcessRunner $cargoRunner
  }
  $cargoCallCountBeforeConfig = $cargoCalls.Count
  $untrustedConfigStage = Join-Path $root 'untrusted-cargo-config-stage'
  [void][IO.Directory]::CreateDirectory((Join-Path $untrustedConfigStage '.cargo'))
  [IO.File]::WriteAllText((Join-Path $untrustedConfigStage '.cargo/config.toml'), "[source.crates-io]`nreplace-with = 'untrusted'", [Text.UTF8Encoding]::new($false))
  Assert-Throws 'Cargo source replacement in the working-directory ancestry is rejected' {
    Get-FirstLaunchTauriDriver -CargoPath $cargoPath -StageRoot $untrustedConfigStage -ProcessRunner $cargoRunner
  }
  Assert-True ($cargoCalls.Count -eq $cargoCallCountBeforeConfig) 'Cargo source replacement is rejected before any Cargo invocation'

  $edgeArchivePath = Join-Path $root 'official-edge-driver-fixture.zip'
  $edgeArchiveBytes = New-TestEdgeArchive $edgeArchivePath
  $edgeCatalogBytes = New-TestEdgeCatalog $edgeArchiveBytes.LongLength
  $selectedEdge = ConvertFrom-FirstLaunchEdgeCatalog $edgeCatalogBytes '156.0.4314.58'
  Assert-True ($selectedEdge.version -ceq '156.0.4314.84' -and
    $selectedEdge.compatibleFirstThreeComponents -ceq '156.0.4314' -and
    $selectedEdge.expectedArchiveBytes -eq $edgeArchiveBytes.LongLength) 'official catalog selects win64 build matching the WebView2 first three components'
  Assert-True ($selectedEdge.catalogSha256 -ceq (Get-TestSha256 $edgeCatalogBytes) -and
    $selectedEdge.catalogSizeBytes -eq $edgeCatalogBytes.LongLength -and $selectedEdge.catalogItemCount -eq 3) 'raw official catalog bytes, digest, size, and item count are recorded'
  Assert-True ($selectedEdge.catalogGeneratedAtUtc -ceq '2026-11-22T03:00:00.1234567Z' -and
    $selectedEdge.selectedLastModified -ceq '2026-11-22T02:00:00.7654321Z') 'catalog and selected item retain source timestamp precision'
  $noCompatibleCatalog = New-TestEdgeCatalog $edgeArchiveBytes.LongLength '155.0.4314.84'
  Assert-Throws 'catalog with no compatible x64 version fails closed' { ConvertFrom-FirstLaunchEdgeCatalog $noCompatibleCatalog '156.0.4314.58' }
  $win32OnlyCatalog = New-TestEdgeCatalog $edgeArchiveBytes.LongLength '156.0.4314.84' '2026-11-22T03:00:00.1234567Z' '2026-11-22T02:00:00.7654321Z' 'win32'
  Assert-Throws 'a matching win32 archive cannot satisfy the x64 driver requirement' { ConvertFrom-FirstLaunchEdgeCatalog $win32OnlyCatalog '156.0.4314.58' }
  $badGeneratedCatalog = New-TestEdgeCatalog $edgeArchiveBytes.LongLength '156.0.4314.84' '2026-11-22T03:00:00.123456Z'
  Assert-Throws 'catalog timestamp with lost fractional precision is rejected' { ConvertFrom-FirstLaunchEdgeCatalog $badGeneratedCatalog '156.0.4314.58' }
  $badItemTimeCatalog = New-TestEdgeCatalog $edgeArchiveBytes.LongLength '156.0.4314.84' '2026-11-22T03:00:00.1234567Z' '2026-11-22T03:00:01.0000000Z'
  Assert-Throws 'selected item time cannot postdate catalog generation' { ConvertFrom-FirstLaunchEdgeCatalog $badItemTimeCatalog '156.0.4314.58' }

  $edgeStageRoot = Join-Path $root 'edge-stage-success'
  [void][IO.Directory]::CreateDirectory($edgeStageRoot)
  $edgeTransport = New-TestEdgeTransport $edgeCatalogBytes $edgeArchiveBytes
  $edgeProbe = New-TestEdgeProbe
  $edge = Get-FirstLaunchEdgeDriver -RuntimeVersion '156.0.4314.58' -StageRoot $edgeStageRoot `
    -Transport $edgeTransport.Callback -ProcessRunner $edgeProbe.Callback
  Assert-True ($edge.version -ceq '156.0.4314.84' -and $edge.runtimeVersion -ceq '156.0.4314.58' -and
    $edge.versionProbeExitCode -eq 0 -and $edge.serviceStarted -eq $false) 'EdgeDriver Stage verifies the bounded version probe and never starts service'
  Assert-True ($edge.archiveSizeBytes -eq $edge.expectedArchiveBytes -and
    $edge.archiveSha256 -ceq (Get-TestSha256 $edgeArchiveBytes) -and
    $edge.executableSha256 -ceq (Get-TestSha256 (New-TestPeBytes -WithoutResourceDirectory))) 'Edge archive and extracted AMD64 PE32+ executable receive measured size and SHA-256 pins without requiring Morrow PE resources'
  Assert-True ($edgeTransport.Calls.Count -eq 2 -and
    $edgeTransport.Calls[0].uri -ceq 'https://msedgedriver.microsoft.com/listing.json' -and
    $edgeTransport.Calls[1].uri -ceq $edge.downloadUrl -and
    @($edgeTransport.Calls | Where-Object { $_.headers.Count -ne 0 -or $_.allowAutoRedirect -ne $false }).Count -eq 0) 'Microsoft catalog and archive use unauthenticated HTTPS requests with redirects disabled'
  Assert-True ($edgeProbe.Calls.Count -eq 1 -and $edgeProbe.Calls[0].arguments[0] -ceq '--version' -and
    $edgeProbe.Calls[0].timeoutMs -eq 15000 -and $edgeProbe.Calls[0].maximumOutputBytes -eq 8192 -and
    $edgeProbe.Calls[0].environment.ContainsKey('MSEDGEDRIVER_TELEMETRY_OPTOUT') -and
    -not $edgeProbe.Calls[0].environment.ContainsKey('GITHUB_TOKEN')) 'the sole EdgeDriver probe is bounded and runs with a credential-free environment'
  $cacheTransport = New-TestEdgeTransport $edgeCatalogBytes $edgeArchiveBytes
  $cacheProbe = New-TestEdgeProbe
  Assert-Throws 'existing EdgeDriver stage is not reused or overwritten' {
    Get-FirstLaunchEdgeDriver -RuntimeVersion '156.0.4314.58' -StageRoot $edgeStageRoot `
      -Transport $cacheTransport.Callback -ProcessRunner $cacheProbe.Callback
  }
  Assert-True ($cacheTransport.Calls.Count -eq 0 -and $cacheProbe.Calls.Count -eq 0) 'stage collision rejects cache reuse before network or probe'

  foreach ($mode in @('catalog-redirect', 'catalog-error', 'catalog-content-type', 'archive-redirect', 'archive-content-type', 'archive-length-header')) {
    $badStageRoot = Join-Path $root ('edge-' + $mode)
    [void][IO.Directory]::CreateDirectory($badStageRoot)
    $badTransport = New-TestEdgeTransport $edgeCatalogBytes $edgeArchiveBytes $mode
    $badProbe = New-TestEdgeProbe
    Assert-Throws "official EdgeDriver $mode response is rejected" {
      Get-FirstLaunchEdgeDriver -RuntimeVersion '156.0.4314.58' -StageRoot $badStageRoot `
        -Transport $badTransport.Callback -ProcessRunner $badProbe.Callback
    }
    Assert-True ($badProbe.Calls.Count -eq 0) "EdgeDriver $mode cannot reach the version probe"
  }
  $wrongArchiveCatalog = New-TestEdgeCatalog ($edgeArchiveBytes.LongLength + 1)
  $wrongArchiveStage = Join-Path $root 'edge-wrong-catalog-size'
  [void][IO.Directory]::CreateDirectory($wrongArchiveStage)
  $wrongArchiveTransport = New-TestEdgeTransport $wrongArchiveCatalog $edgeArchiveBytes
  $wrongArchiveProbe = New-TestEdgeProbe
  Assert-Throws 'archive length differing from the catalog item is rejected' {
    Get-FirstLaunchEdgeDriver -RuntimeVersion '156.0.4314.58' -StageRoot $wrongArchiveStage `
      -Transport $wrongArchiveTransport.Callback -ProcessRunner $wrongArchiveProbe.Callback
  }
  Assert-True ($wrongArchiveProbe.Calls.Count -eq 0) 'archive size pin mismatch blocks the EdgeDriver probe'
  $x86PeBytes = New-TestPeBytes -WithoutResourceDirectory
  Set-TestBytes $x86PeBytes 0x84 ([BitConverter]::GetBytes([uint16]0x014C))
  $truncatedPeBytes = New-TestPeBytes -WithoutResourceDirectory
  $truncatedPeBytes = [byte[]]$truncatedPeBytes[0..420]
  foreach ($fixtureCase in @(
      [pscustomobject]@{ Name = 'x86'; Bytes = $x86PeBytes },
      [pscustomobject]@{ Name = 'non-pe'; Bytes = [Text.Encoding]::UTF8.GetBytes('not a PE executable') },
      [pscustomobject]@{ Name = 'truncated-pe'; Bytes = $truncatedPeBytes }
    )) {
    $badPeArchive = Join-Path $root ('edge-' + $fixtureCase.Name + '.zip')
    $badPeArchiveBytes = New-TestEdgeArchive $badPeArchive ([byte[]]$fixtureCase.Bytes)
    $badPeCatalog = New-TestEdgeCatalog $badPeArchiveBytes.LongLength
    $badPeStage = Join-Path $root ('edge-' + $fixtureCase.Name + '-stage')
    [void][IO.Directory]::CreateDirectory($badPeStage)
    $badPeTransport = New-TestEdgeTransport $badPeCatalog $badPeArchiveBytes
    $badPeProbe = New-TestEdgeProbe
    Assert-Throws "EdgeDriver $($fixtureCase.Name) image is rejected before probe" {
      Get-FirstLaunchEdgeDriver -RuntimeVersion '156.0.4314.58' -StageRoot $badPeStage `
        -Transport $badPeTransport.Callback -ProcessRunner $badPeProbe.Callback
    }
    Assert-True ($badPeProbe.Calls.Count -eq 0) "EdgeDriver $($fixtureCase.Name) image cannot reach --version"
  }
  foreach ($mode in @('probe-pin', 'probe-unbranded', 'probe-exit', 'probe-timeout', 'probe-output')) {
    $probeStageRoot = Join-Path $root ('edge-' + $mode)
    [void][IO.Directory]::CreateDirectory($probeStageRoot)
    $probeTransport = New-TestEdgeTransport $edgeCatalogBytes $edgeArchiveBytes
    $badProbe = New-TestEdgeProbe $mode
    Assert-Throws "EdgeDriver $mode probe result is rejected" {
      Get-FirstLaunchEdgeDriver -RuntimeVersion '156.0.4314.58' -StageRoot $probeStageRoot `
        -Transport $probeTransport.Callback -ProcessRunner $badProbe.Callback
    }
    Assert-True ($badProbe.Calls.Count -eq 1) "EdgeDriver $mode failure is bounded to the single --version probe"
  }

  $nativePwsh = Join-Path $PSHOME 'pwsh'
  if ([IO.Path]::DirectorySeparatorChar -eq '\') { $nativePwsh += '.exe' }
  Assert-True ([IO.File]::Exists($nativePwsh)) 'the native bounded-process fixture uses the current portable PowerShell executable'
  $nativeProcessRunner = New-TestLocalProcessRunner
  $nativeEnvironment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
  $nativeEnvironment['TEMP'] = $root
  $nativeEnvironment['TMP'] = $root
  if ([IO.Path]::DirectorySeparatorChar -eq '\') {
    $nativeEnvironment['SystemRoot'] = [string]$env:SystemRoot
    $nativeEnvironment['WINDIR'] = [string]$env:SystemRoot
    $nativeEnvironment['PATH'] = [string]::Join(';', @((Join-Path $env:SystemRoot 'System32'), $env:SystemRoot))
  } else {
    $nativeEnvironment['PATH'] = '/usr/bin:/bin'
  }
  $pipeFixture = Invoke-FirstLaunchBoundedProcess -Executable $nativePwsh `
    -Arguments @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "[Console]::Out.Write('bounded-stdout'); [Console]::Error.Write('bounded-stderr')") `
    -WorkingDirectory $root -Environment $nativeEnvironment -TimeoutMs 5000 -MaximumOutputBytes 256 -ProcessRunner $nativeProcessRunner
  Assert-True ($pipeFixture.ExitCode -eq 0 -and $pipeFixture.StdOut -ceq 'bounded-stdout' -and
    $pipeFixture.StdErr -ceq 'bounded-stderr' -and -not $pipeFixture.TimedOut -and -not $pipeFixture.OutputLimitExceeded) 'native bounded runner drains both child pipes and returns the exit code'
  $outputLimitClock = [Diagnostics.Stopwatch]::StartNew()
  Assert-Throws 'native bounded runner stops a benign child after the combined pipe cap' {
    Invoke-FirstLaunchBoundedProcess -Executable $nativePwsh `
      -Arguments @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "[Console]::Out.Write(('x' * 1000000))") `
      -WorkingDirectory $root -Environment $nativeEnvironment -TimeoutMs 5000 -MaximumOutputBytes 256 -ProcessRunner $nativeProcessRunner
  }
  Assert-True ($outputLimitClock.Elapsed.TotalSeconds -lt 3) 'native output-limit termination and cleanup are bounded'
  $timeoutClock = [Diagnostics.Stopwatch]::StartNew()
  $timeoutChildPidPath = Join-Path $root 'timeout-child.pid'
  $nativeEnvironment['MORROW_TEST_PID_FILE'] = $timeoutChildPidPath
  Assert-Throws 'native bounded runner kills a benign sleeping child at its deadline' {
    Invoke-FirstLaunchBoundedProcess -Executable $nativePwsh `
      -Arguments @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[IO.File]::WriteAllText($env:MORROW_TEST_PID_FILE, [string]$PID); Start-Sleep -Seconds 10') `
      -WorkingDirectory $root -Environment $nativeEnvironment -TimeoutMs 2000 -MaximumOutputBytes 256 -ProcessRunner $nativeProcessRunner
  }
  Assert-True ($timeoutClock.Elapsed.TotalSeconds -lt 4) 'native process exit and pipe-drain timeout cleanup have a bounded tail'
  $timeoutChildStopped = $false
  $timeoutChildState = 'child PID was not published before the process deadline'
  if ([IO.File]::Exists($timeoutChildPidPath)) {
    $timeoutChildId = 0
    if ([int]::TryParse([IO.File]::ReadAllText($timeoutChildPidPath).Trim(), [ref]$timeoutChildId)) {
      try {
        $timeoutChild = [Diagnostics.Process]::GetProcessById($timeoutChildId)
        if ($timeoutChild.ProcessName -like 'pwsh*') {
          $timeoutChildStopped = $timeoutChild.HasExited
          $timeoutChildState = 'processName=' + $timeoutChild.ProcessName + '; exited=' + $timeoutChildStopped
          if (-not $timeoutChildStopped) {
            $timeoutChild.Kill($true)
            [void]$timeoutChild.WaitForExit(2000)
          }
        } else {
          $timeoutChildState = 'unexpected processName=' + $timeoutChild.ProcessName
        }
        $timeoutChild.Dispose()
      } catch [ArgumentException] { $timeoutChildStopped = $true; $timeoutChildState = 'PID already exited' }
    }
  }
  Assert-True ($timeoutChildStopped) "native deadline termination leaves no owned sleeping PowerShell child ($timeoutChildState)"
  $stageOwnerParent = Join-Path $root 'stage-owner-lifecycle'
  [void][IO.Directory]::CreateDirectory($stageOwnerParent)
  foreach ($failedPhase in @('package', 'registry', 'cargo', 'edge')) {
    $failedStageRoot = Join-Path $stageOwnerParent ('failed-' + $failedPhase)
    $phaseAction = {
      param($claim, $phase)
      [void](Assert-FirstLaunchStageClaim $claim.stageRoot $claim.token)
      [IO.File]::WriteAllText((Join-Path $claim.stageRoot ($phase + '.partial')), 'owned partial stage bytes')
      throw ('simulated ' + $phase + ' Stage failure')
    }.GetNewClosure()
    Assert-Throws "failed Stage after $failedPhase cleans only its claimed tree" {
      Invoke-FirstLaunchOwnedStage -StageRoot $failedStageRoot -Action $phaseAction -ActionArguments @($failedPhase)
    }
    Assert-True (-not [IO.Directory]::Exists($failedStageRoot) -and -not [IO.File]::Exists($failedStageRoot + '.claim')) "failed $failedPhase Stage removes its exact claimed directory and claim"
  }
  $completedStageRoot = Join-Path $stageOwnerParent 'completed-stage'
  $completedStageAction = {
    param($claim)
    [IO.File]::WriteAllText((Join-Path $claim.stageRoot 'stage.json'), 'completed DTO')
    return 'completed'
  }.GetNewClosure()
  $completedStage = Invoke-FirstLaunchOwnedStage -StageRoot $completedStageRoot -Action $completedStageAction
  Assert-True ($completedStage -ceq 'completed' -and [IO.File]::ReadAllText((Join-Path $completedStageRoot 'stage.json')) -ceq 'completed DTO' -and
    [IO.File]::Exists((Join-Path $completedStageRoot $script:FirstLaunchStageOwnerMarkerName)) -and
    -not [IO.File]::Exists($completedStageRoot + '.claim')) 'successful Stage retains its output and in-root owner marker, then releases its sidecar'
  $priorStageRoot = Join-Path $stageOwnerParent 'prior-data'
  [void][IO.Directory]::CreateDirectory($priorStageRoot)
  $priorStageFile = Join-Path $priorStageRoot 'preserve.txt'
  [IO.File]::WriteAllText($priorStageFile, 'preexisting bytes')
  Assert-Throws 'Stage claim refuses a preexisting directory before acquiring ownership' {
    Invoke-FirstLaunchOwnedStage -StageRoot $priorStageRoot -Action $completedStageAction
  }
  Assert-True ([IO.File]::ReadAllText($priorStageFile) -ceq 'preexisting bytes' -and
    -not [IO.File]::Exists($priorStageRoot + '.claim')) 'preexisting stage content remains untouched when ownership cannot be acquired'
  $claimCollisionRoot = Join-Path $stageOwnerParent 'claim-collision'
  [IO.File]::WriteAllText($claimCollisionRoot + '.claim', 'prior claim bytes')
  Assert-Throws 'Stage claim refuses a preexisting sidecar signal' {
    Invoke-FirstLaunchOwnedStage -StageRoot $claimCollisionRoot -Action $completedStageAction
  }
  Assert-True ([IO.File]::ReadAllText($claimCollisionRoot + '.claim') -ceq 'prior claim bytes' -and
    -not [IO.Directory]::Exists($claimCollisionRoot)) 'prior sidecar and absent root remain untouched on claim collision'
  $raceStageRoot = Join-Path $stageOwnerParent 'race-empty-root'
  $raceDirectoryCreator = {
    param($path)
    [void][IO.Directory]::CreateDirectory($path)
    $directoryType = Get-FirstLaunchBoundedProcessType
    $directoryType::CreateDirectoryExclusive($path)
  }.GetNewClosure()
  $raceError = $null
  try { New-FirstLaunchStageClaim -StageRoot $raceStageRoot -DirectoryCreator $raceDirectoryCreator | Out-Null }
  catch { $raceError = [string]$_.Exception.Message }
  Assert-True ($raceError -like '*appeared before exclusive creation*' -and [IO.Directory]::Exists($raceStageRoot) -and
    @([IO.Directory]::EnumerateFileSystemEntries($raceStageRoot)).Count -eq 0 -and
    -not [IO.File]::Exists($raceStageRoot + '.claim') -and
    -not [IO.File]::Exists((Join-Path $raceStageRoot $script:FirstLaunchStageOwnerMarkerName))) 'an empty foreign directory created after the sidecar claim survives an exclusive-create race'
  $jobAction = {
    param($claim, $jobFactory, $timeoutMs = 15000)
    $work = Join-Path $claim.stageRoot 'job-work'
    [void][IO.Directory]::CreateDirectory($work)
    $executable = Join-Path $work 'msedgedriver.exe'
    $executableBytes = [Text.Encoding]::UTF8.GetBytes('bounded fake executable path')
    [IO.File]::WriteAllBytes($executable, $executableBytes)
    $fakeSystemRoot = [string]$env:SystemRoot
    if ([string]::IsNullOrWhiteSpace($fakeSystemRoot)) { $fakeSystemRoot = [IO.Path]::GetPathRoot($claim.stageRoot) }
    $jobEnvironment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    $jobEnvironment['SystemRoot'] = $fakeSystemRoot
    $jobEnvironment['WINDIR'] = $fakeSystemRoot
    $jobResult = Invoke-FirstLaunchBoundedProcess -Executable $executable -Arguments @('--version') `
      -WorkingDirectory $work -Environment $jobEnvironment -TimeoutMs $timeoutMs -MaximumOutputBytes 8192 `
      -StageRoot $claim.stageRoot -StageOwnerToken $claim.token -ProcessRole edge-version `
      -ExpectedExecutableSha256 (Get-TestSha256 $executableBytes) -JobSessionFactory $jobFactory
    [IO.File]::WriteAllText((Join-Path $claim.stageRoot 'stage.json'), $jobResult.StdOut)
    return $jobResult
  }.GetNewClosure()
  $emptyJobFactory = New-TestFakeJobSessionFactory $false
  $emptyJobState = [MorrowFirstLaunchTest.FakeJobStateSlot]::Current
  $emptyJobRoot = Join-Path $stageOwnerParent 'job-root-clean'
  $emptyJobResult = Invoke-FirstLaunchOwnedStage -StageRoot $emptyJobRoot -Action $jobAction -ActionArguments @($emptyJobFactory)
  Assert-True ($emptyJobResult.StdOut -ceq 'MSEdgeDriver 156.0.4314.58' -and
    $emptyJobResult.StdErr -ceq 'bounded-fake-stderr' -and
    [regex]::IsMatch($emptyJobResult.StdOut, '\AMSEdgeDriver 156\.0\.4314\.58\z') -and $emptyJobState.ResumeCount -eq 1 -and
    $emptyJobState.ObserveCount -eq 1 -and $emptyJobState.MemberQueries -eq 1 -and $emptyJobState.StopCount -eq 0 -and
    $emptyJobState.DisposeCount -eq 1) 'private Job orchestration accepts a drained root and releases its session'
  Assert-True (@([IO.Directory]::EnumerateFileSystemEntries((Join-Path $emptyJobRoot 'job-work')) | Where-Object {
    [IO.Path]::GetFileName($_) -like 'morrow-e003-g23-process-*'
  }).Count -eq 0) 'completed private Job request and result receipts are removed after verification'
  $memberJobFactory = New-TestFakeJobSessionFactory $true
  $memberJobState = [MorrowFirstLaunchTest.FakeJobStateSlot]::Current
  $memberJobRoot = Join-Path $stageOwnerParent 'job-root-with-descendant'
  Assert-Throws 'private Job orchestration terminates members after the helper root exits' {
    Invoke-FirstLaunchOwnedStage -StageRoot $memberJobRoot -Action $jobAction -ActionArguments @($memberJobFactory)
  }
  Assert-True ($memberJobState.ObserveCount -eq 1 -and $memberJobState.MemberQueries -eq 1 -and
    $memberJobState.StopCount -eq 1 -and $memberJobState.StopTimeoutMs -eq 300 -and $memberJobState.DisposeCount -eq 1 -and
    -not [IO.Directory]::Exists($memberJobRoot)) 'a live Job descendant after root exit triggers bounded tree stop before owned Stage cleanup'
  $lateJobFactory = New-TestFakeJobSessionFactory $false 60
  $lateJobState = [MorrowFirstLaunchTest.FakeJobStateSlot]::Current
  $lateJobRoot = Join-Path $stageOwnerParent 'job-root-observation-past-deadline'
  Assert-Throws 'private Job root observation completing past deadline is rejected' {
    Invoke-FirstLaunchOwnedStage -StageRoot $lateJobRoot -Action $jobAction -ActionArguments @($lateJobFactory, 10)
  }
  Assert-True ($lateJobState.ObserveCount -eq 1 -and $lateJobState.MemberQueries -eq 1 -and
    $lateJobState.StopCount -eq 1 -and $lateJobState.StopTimeoutMs -eq 300 -and $lateJobState.DisposeCount -eq 1 -and
    -not [IO.Directory]::Exists($lateJobRoot)) 'late root observation uses bounded Job cleanup and removes only the claimed Stage'
  $slowFactoryJob = New-TestFakeJobSessionFactory $false 0 60
  $slowFactoryJobState = [MorrowFirstLaunchTest.FakeJobStateSlot]::Current
  $slowFactoryJobRoot = Join-Path $stageOwnerParent 'job-factory-past-deadline'
  Assert-Throws 'private Job factory completing past deadline is stopped before resume' {
    Invoke-FirstLaunchOwnedStage -StageRoot $slowFactoryJobRoot -Action $jobAction -ActionArguments @($slowFactoryJob, 10)
  }
  Assert-True ($slowFactoryJobState.ResumeCount -eq 0 -and $slowFactoryJobState.StopCount -eq 1 -and
    $slowFactoryJobState.StopTimeoutMs -eq 300 -and $slowFactoryJobState.DisposeCount -eq 1 -and
    -not [IO.Directory]::Exists($slowFactoryJobRoot)) 'late Job creation cannot resume a target after the monotonic command deadline'
  $tamperedStageRoot = Join-Path $stageOwnerParent 'tampered-owner'
  $tamperAction = {
    param($claim)
    [IO.File]::WriteAllText((Join-Path $claim.stageRoot 'preserve.txt'), 'owner mismatch bytes')
    [IO.File]::WriteAllText($claim.markerPath, ('0' * 32))
    throw 'simulated owner marker tamper'
  }.GetNewClosure()
  Assert-Throws 'Stage failure cannot clean a tree after the exact owner marker changes' {
    Invoke-FirstLaunchOwnedStage -StageRoot $tamperedStageRoot -Action $tamperAction
  }
  Assert-True ([IO.File]::ReadAllText((Join-Path $tamperedStageRoot 'preserve.txt')) -ceq 'owner mismatch bytes' -and
    [IO.File]::Exists($tamperedStageRoot + '.claim')) 'owner mismatch preserves Stage tree and claim for safe inspection'

  $stageRuntime = [pscustomobject]@{
    version = '156.0.4314.58'
    observedAtUtc = '2026-11-22T03:00:00.000Z'
    sources = @(
      [ordered]@{ registryPath = 'HKLM64\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'; version = '156.0.4314.58' },
      [ordered]@{ registryPath = 'HKCU64\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'; version = '156.0.4314.58' }
    )
  }
  $stageIdentity = New-TestStageIdentity
  $stageDto = New-FirstLaunchStageDto -Identity $stageIdentity -PackageResult (New-TestVerifiedPinnedPackage) `
    -Runtime $stageRuntime -TauriDriver $tauri -EdgeDriver $edge -StagedAtUtc '2026-11-22T03:30:00.000Z'
  Assert-True ($stageDto.schema -ceq 'morrow.e003.g15.first-launch-stage.v1' -and
    $stageDto.gate.gateRunId -ceq '98765432101' -and $stageDto.candidateBuild.candidateBuildRunId -ceq '44961916968' -and
    $stageDto.candidateBuild.artifact.id -ceq '14730062702' -and $stageDto.packageInventory.Count -eq 19) 'Stage DTO keeps gate and candidate run identities separate and carries the pinned inventory'
  Assert-True ($stageDto.noLaunch.appLaunched -eq $false -and $stageDto.noLaunch.driverServiceStarted -eq $false -and
    $stageDto.noLaunch.guiTested -eq $false) 'Stage DTO explicitly records that no application, service, or GUI was launched'
  $stagePath = Join-Path $root 'gate-compatible-stage.json'
  $stageJson = ConvertTo-Json -InputObject $stageDto -Depth 20
  [IO.File]::WriteAllBytes($stagePath, [Text.UTF8Encoding]::new($false).GetBytes($stageJson + "`n"))
  $projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
  Assert-StageAcceptedByGate $stagePath $projectRoot
  $badStageIdentity = New-TestStageIdentity
  $badStageIdentity.gate.gateRunId = '44961916968'
  Assert-Throws 'Stage DTO rejects gate run aliasing the candidate build run' {
    New-FirstLaunchStageDto -Identity $badStageIdentity -PackageResult (New-TestVerifiedPinnedPackage) `
      -Runtime $stageRuntime -TauriDriver $tauri -EdgeDriver $edge -StagedAtUtc '2026-11-22T03:30:00.000Z'
  }
  $overlappingStageIdentity = New-TestStageIdentity
  $overlappingStageIdentity.runner.tempRoot = 'C:\morrow\checkout\_temp'
  Assert-Throws 'Stage DTO rejects RUNNER_TEMP overlapping the checkout' {
    New-FirstLaunchStageDto -Identity $overlappingStageIdentity -PackageResult (New-TestVerifiedPinnedPackage) `
      -Runtime $stageRuntime -TauriDriver $tauri -EdgeDriver $edge -StagedAtUtc '2026-11-22T03:30:00.000Z'
  }
  $badStageTauri = New-TestTauriDriverDto
  $badStageTauri.extra = 'not in gate DTO'
  Assert-Throws 'Stage DTO rejects extra driver provenance fields' {
    New-FirstLaunchStageDto -Identity $stageIdentity -PackageResult (New-TestVerifiedPinnedPackage) `
      -Runtime $stageRuntime -TauriDriver $badStageTauri -EdgeDriver $edge -StagedAtUtc '2026-11-22T03:30:00.000Z'
  }
  $badStageRuntime = Copy-FirstLaunchValue $stageRuntime
  $badStageRuntime.sources[1].version = '155.0.4314.58'
  Assert-Throws 'Stage DTO rejects divergent runtime registry observations' {
    New-FirstLaunchStageDto -Identity $stageIdentity -PackageResult (New-TestVerifiedPinnedPackage) `
      -Runtime $badStageRuntime -TauriDriver $tauri -EdgeDriver $edge -StagedAtUtc '2026-11-22T03:30:00.000Z'
  }
  $earlyStageRuntime = Copy-FirstLaunchValue $stageRuntime
  $earlyStageRuntime.observedAtUtc = '2026-11-22T02:00:00.000Z'
  Assert-Throws 'Stage DTO rejects official catalog timestamps that postdate Stage completion' {
    New-FirstLaunchStageDto -Identity $stageIdentity -PackageResult (New-TestVerifiedPinnedPackage) `
      -Runtime $earlyStageRuntime -TauriDriver $tauri -EdgeDriver $edge -StagedAtUtc '2026-11-22T02:30:00.000Z'
  }

  Write-Output "windows-first-launch-preflight passed $script:assertionCount assertions."
} finally {
  if ($null -ne $readOnlyTree -and [IO.Directory]::Exists($readOnlyTree)) {
    $attributes = [IO.File]::GetAttributes($readOnlyTree)
    [IO.File]::SetAttributes($readOnlyTree, $attributes -band (-bnot [IO.FileAttributes]::ReadOnly))
  }
  if ([IO.Directory]::Exists($root)) { [IO.Directory]::Delete($root, $true) }
}
