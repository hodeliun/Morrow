$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'windows-process.ps1')

$child = $null
$identity = $null
$marker = [Guid]::NewGuid().ToString('N')
$failed = $false
$runnerTemp = [Environment]::GetEnvironmentVariable('RUNNER_TEMP', [EnvironmentVariableTarget]::Process)

function Get-SafeErrorMessage {
  param([Parameter(Mandatory)][Exception] $Exception)

  $message = [string]$Exception.Message
  $message = $message -replace '[\r\n\t]+', ' '
  foreach ($sensitivePath in @($runnerTemp, [Environment]::GetEnvironmentVariable('USERPROFILE', [EnvironmentVariableTarget]::Process))) {
    if (-not [string]::IsNullOrWhiteSpace([string]$sensitivePath)) {
      $message = [regex]::Replace($message, [regex]::Escape([string]$sensitivePath), '<PRIVATE_PATH>', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    }
  }
  $message = [regex]::Replace($message, '(?i)\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,})', '<REDACTED_SECRET>')
  $message = [regex]::Replace($message, '(?i)\b([A-Z_][A-Z0-9_]*)\s*=\s*[^,\s;]+', '$1=<REDACTED_ENV>')
  $message = [regex]::Replace($message, '(?i)--[A-Za-z0-9-]+(?:=|\s+)(?:"[^"]*"|''[^'']*''|[^,\s;]+)', '--<REDACTED_ARG>')
  $message = [regex]::Replace($message, '"[^"]*"|''[^'']*''', '<REDACTED_TEXT>')
  $message = [regex]::Replace($message, '(?i)\b[A-Za-z]:\\[^\s,;<>|"'']+', '<PATH>')
  $message = [regex]::Replace($message, '\\\\[^\\\s,;"'']+(?:\\[^\\\s,;"'']+)*', '<PATH>')
  $message = [regex]::Replace($message, '\b[A-Za-z0-9_+/=-]{32,}\b', '<REDACTED_VALUE>')
  $message = [regex]::Replace($message, '[^\x20-\x7E]', ' ')
  $message = $message.Trim()
  if ($message.Length -gt 240) { $message = $message.Substring(0, 240) }
  return $message
}

function New-SyntheticNativeOwnershipChain {
  $sid = 'S-1-5-21-1200000000-1200000001-1200000002-1001'
  return [pscustomobject]@{
    driver = [pscustomobject]@{
      processId = 6100
      parentProcessId = 6000
      executablePath = 'C:\synthetic\tauri-driver.exe'
      executableSha256 = 'a' * 64
      creationTimeUtc = '2026-11-16T10:00:00.000Z'
      ownerSid = $sid
    }
    nativeDriver = [pscustomobject]@{
      processId = 6101
      parentProcessId = 6100
      executablePath = 'C:\synthetic\msedgedriver.exe'
      executableSha256 = 'b' * 64
      creationTimeUtc = '2026-11-16T10:00:01.000Z'
      ownerSid = $sid
    }
    rustBackend = [pscustomobject]@{
      processId = 6102
      parentProcessId = 6101
      executablePath = 'C:\synthetic\morrow.exe'
      executableSha256 = 'c' * 64
      creationTimeUtc = '2026-11-16T10:00:02.000Z'
      ownerSid = $sid
    }
    webview = [pscustomobject]@{
      processId = 6103
      parentProcessId = 6102
      executablePath = 'C:\Program Files (x86)\Microsoft\EdgeWebView\Application\156.0.0.0\msedgewebview2.exe'
      executableSha256 = 'd' * 64
      creationTimeUtc = '2026-11-16T10:00:03.000Z'
      ownerSid = $sid
      commandLineUserDataDir = 'C:\runner\temp\issue-180\profile\webview'
    }
  }
}

function New-SyntheticNativeObservation([psobject] $Chain) {
  return [pscustomobject][ordered]@{
    driver = $Chain.driver
    nativeDriver = $Chain.nativeDriver
    rustBackend = $Chain.rustBackend
    webview = $Chain.webview
    listener = [pscustomobject][ordered]@{
      processId = $Chain.driver.processId
      port = 4444
      localAddress = '127.0.0.1'
    }
    isolatedPaths = [pscustomobject][ordered]@{
      backendPath = 'C:\runner\temp\issue-180\profile\backend'
      backendUnderRunnerTemp = $true
      backendNoReparse = $true
      webviewPath = $Chain.webview.commandLineUserDataDir
      webviewUnderRunnerTemp = $true
      webviewNoReparse = $true
      vaultPath = 'C:\runner\temp\issue-180\profile\vault'
      vaultUnderRunnerTemp = $true
      vaultNoReparse = $true
      evidencePath = 'C:\runner\temp\issue-180\profile\evidence'
      evidenceUnderRunnerTemp = $true
      evidenceNoReparse = $true
    }
  }
}

function Assert-SyntheticNativeChainRejected([psobject] $Chain, [string] $Description) {
  $refused = $false
  try {
    [void](Assert-WindowsPilotOwnershipChain -Driver $Chain.driver -NativeDriver $Chain.nativeDriver -RustBackend $Chain.rustBackend -WebView $Chain.webview -ExpectedOwnerSid $Chain.driver.ownerSid -ExpectedDriverParentProcessId 6000)
  } catch {
    $refused = $true
  }
  if (-not $refused) { throw "The native ownership chain accepted an invalid $Description." }
}

try {
  if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { throw 'The Windows runner temporary root is missing.' }
  $outsideTempRefused = $false
  try {
    [void](Get-PilotTemporaryPathProof -Path $PSHOME -RunnerTemp $env:RUNNER_TEMP)
  } catch {
    $outsideTempRefused = $true
  }
  if (-not $outsideTempRefused) { throw 'A path outside RUNNER_TEMP was accepted as an isolated profile.' }
  $tempRootCollisionRefused = $false
  try {
    [void](Get-PilotTemporaryPathProof -Path $env:RUNNER_TEMP -RunnerTemp $env:RUNNER_TEMP)
  } catch {
    $tempRootCollisionRefused = $true
  }
  if (-not $tempRootCollisionRefused) { throw 'RUNNER_TEMP itself was accepted as a case profile path.' }

  $parserProfilePath = Join-Path $env:RUNNER_TEMP ('issue-180-profile-' + [Guid]::NewGuid().ToString('N'))
  $parsedUserDataDirectory = Get-PilotWebViewUserDataDirectory ('"C:\Program Files (x86)\Microsoft\EdgeWebView\msedgewebview2.exe" --user-data-dir="' + $parserProfilePath + '"')
  $expectedParsedPath = ConvertTo-PilotCanonicalPath -Path $parserProfilePath -AllowMissing
  if (-not [string]::Equals($parsedUserDataDirectory, $expectedParsedPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The synthetic WebView2 argv parser did not preserve the quoted user-data directory.'
  }

  $invalidUserDataCommands = @(
    ('"C:\synthetic\msedgewebview2.exe" --user-data-dir="' + $parserProfilePath + '" --user-data-dir="' + $parserProfilePath + '"'),
    ('"C:\synthetic\msedgewebview2.exe" --user-data-dir="' + $parserProfilePath + '" --user-data-dir="C:\runner\other-profile"'),
    '"C:\synthetic\msedgewebview2.exe" --user-data-dir',
    ('"C:\synthetic\msedgewebview2.exe" --user-data-dir=' + $env:RUNNER_TEMP + '\issue-180 profile --no-first-run'),
    ('"C:\synthetic\msedgewebview2.exe" --user-data-dir="' + $env:RUNNER_TEMP + '\issue-180:stream"'),
    ('"C:\synthetic\msedgewebview2.exe" --user-data-dir="' + $env:RUNNER_TEMP + '\issue-180-profile."')
  )
  foreach ($invalidCommand in $invalidUserDataCommands) {
    $invalidCommandRefused = $false
    try {
      [void](Get-PilotWebViewUserDataDirectory $invalidCommand)
    } catch {
      $invalidCommandRefused = $true
    }
    if (-not $invalidCommandRefused) { throw 'The WebView2 argv parser accepted a duplicate, missing, ambiguous, ADS, or aliased profile path.' }
  }
  $adsPathRefused = $false
  try {
    [void](Get-PilotTemporaryPathProof -Path ($env:RUNNER_TEMP + '\issue-180:stream') -RunnerTemp $env:RUNNER_TEMP)
  } catch {
    $adsPathRefused = $true
  }
  if (-not $adsPathRefused) { throw 'A Windows alternate data stream was accepted as an isolated profile path.' }

  $pathFixture = Join-Path $env:RUNNER_TEMP ('issue-180-path-fixture-' + [Guid]::NewGuid().ToString('N'))
  $pathMarker = [Guid]::NewGuid().ToString('N')
  $pathMarkerFile = Join-Path $pathFixture '.issue-180-owned-marker'
  $pathTarget = Join-Path $pathFixture 'target'
  $pathJunction = Join-Path $pathFixture 'junction'
  [void][IO.Directory]::CreateDirectory($pathFixture)
  [IO.File]::WriteAllText($pathMarkerFile, $pathMarker, [Text.UTF8Encoding]::new($false))
  [void][IO.Directory]::CreateDirectory($pathTarget)
  try {
    [void](New-Item -ItemType Junction -Path $pathJunction -Target $pathTarget -ErrorAction Stop)
    $junctionPathRefused = $false
    try {
      [void](Get-PilotTemporaryPathProof -Path (Join-Path $pathJunction 'profile') -RunnerTemp $env:RUNNER_TEMP)
    } catch {
      $junctionPathRefused = $true
    }
    if (-not $junctionPathRefused) { throw 'A reparse point inside RUNNER_TEMP was accepted as an isolated profile.' }
  } finally {
    if ([IO.Directory]::Exists($pathJunction)) { [IO.Directory]::Delete($pathJunction) }
    if ([IO.File]::Exists($pathMarkerFile) -and [IO.File]::ReadAllText($pathMarkerFile) -ceq $pathMarker) {
      $fixtureAttributes = [IO.File]::GetAttributes($pathFixture)
      if (($fixtureAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The synthetic path fixture became a reparse point; path cleanup was refused.'
      }
      [IO.Directory]::Delete($pathFixture, $true)
    } else {
      throw 'The synthetic path fixture marker changed; path cleanup was refused.'
    }
  }

  $nativeChain = New-SyntheticNativeOwnershipChain
  if (-not (Assert-WindowsPilotOwnershipChain -Driver $nativeChain.driver -NativeDriver $nativeChain.nativeDriver -RustBackend $nativeChain.rustBackend -WebView $nativeChain.webview -ExpectedOwnerSid $nativeChain.driver.ownerSid -ExpectedDriverParentProcessId 6000)) {
    throw 'The synthetic tauri-driver → msedgedriver → Morrow → WebView2 chain was not accepted.'
  }
  $nativeObservation = New-SyntheticNativeObservation $nativeChain
  if (-not (Assert-WindowsPilotObservationShape -Observation $nativeObservation)) {
    throw 'The synthetic observation did not preserve the issue 184 interface.'
  }
  $badObservation = [pscustomobject][ordered]@{
    driver = $nativeObservation.driver
    rustBackend = $nativeObservation.rustBackend
    webview = $nativeObservation.webview
    listener = $nativeObservation.listener
    nativeDriver = $nativeObservation.nativeDriver
    isolatedPaths = $nativeObservation.isolatedPaths
  }
  $badSchemaRefused = $false
  try {
    [void](Assert-WindowsPilotObservationShape -Observation $badObservation)
  } catch {
    $badSchemaRefused = $true
  }
  if (-not $badSchemaRefused) { throw 'The observation adapter accepted a changed property order.' }
  $badObservation = New-SyntheticNativeObservation $nativeChain
  $badObservation.listener.localAddress = '0.0.0.0'
  $badListenerRefused = $false
  try {
    [void](Assert-WindowsPilotObservationShape -Observation $badObservation)
  } catch {
    $badListenerRefused = $true
  }
  if (-not $badListenerRefused) { throw 'The issue 184 observation schema accepted a non-loopback listener.' }
  $badObservation = New-SyntheticNativeObservation $nativeChain
  $badObservation.isolatedPaths.vaultNoReparse = $false
  $badPathRefused = $false
  try {
    [void](Assert-WindowsPilotObservationShape -Observation $badObservation)
  } catch {
    $badPathRefused = $true
  }
  if (-not $badPathRefused) { throw 'The issue 184 observation accepted an unproven vault path.' }
  $wrongPortError = ''
  try {
    [void](Get-WindowsPilotOwnershipObservation -DriverProcessId 6100 -NativeDriverProcessId 6101 -RustBackendProcessId 6102 -WebViewProcessId 6103 -ExpectedDriverParentProcessId 6000 -DriverPort 4445 -BackendDataPath 'C:\missing' -WebViewDataPath 'C:\missing' -VaultPath 'C:\missing' -EvidencePath 'C:\missing' -RunnerTemp 'C:\missing')
  } catch {
    $wrongPortError = $_.Exception.Message
  }
  if ($wrongPortError -notmatch 'DriverPort' -or $wrongPortError -notmatch '4444') {
    throw 'The ownership observation did not reject a listener port other than 4444 at parameter validation.'
  }
  $badChain = New-SyntheticNativeOwnershipChain
  $badChain.nativeDriver.parentProcessId = 6001
  Assert-SyntheticNativeChainRejected $badChain 'native-driver parent edge'
  $badChain = New-SyntheticNativeOwnershipChain
  $badChain.driver.parentProcessId = 6001
  Assert-SyntheticNativeChainRejected $badChain 'runner parent edge'
  $badChain = New-SyntheticNativeOwnershipChain
  $badChain.rustBackend.parentProcessId = $badChain.driver.processId
  Assert-SyntheticNativeChainRejected $badChain 'direct tauri-driver to app edge'
  $badChain = New-SyntheticNativeOwnershipChain
  $badChain.webview.parentProcessId = $badChain.nativeDriver.processId
  Assert-SyntheticNativeChainRejected $badChain 'WebView2 parent edge'
  $badChain = New-SyntheticNativeOwnershipChain
  $badChain.webview.ownerSid = 'S-1-5-21-9-9-9-9'
  Assert-SyntheticNativeChainRejected $badChain 'mixed process SID'
  $badChain = New-SyntheticNativeOwnershipChain
  $badChain.nativeDriver.executablePath = 'C:\synthetic\tauri-driver.exe'
  Assert-SyntheticNativeChainRejected $badChain 'native driver executable'
  $badChain = New-SyntheticNativeOwnershipChain
  $badChain.nativeDriver.executableSha256 = 'g' * 64
  Assert-SyntheticNativeChainRejected $badChain 'native driver digest'
  $badChain = New-SyntheticNativeOwnershipChain
  $badChain.webview.creationTimeUtc = 'not-a-timestamp'
  Assert-SyntheticNativeChainRejected $badChain 'WebView2 creation time'
  $badChain = New-SyntheticNativeOwnershipChain
  $badChain.webview.executablePath = 'C:\Program Files (x86)\Microsoft\EdgeWebView\Application\156.0.0.0\msedgewebview2.exe:stream'
  Assert-SyntheticNativeChainRejected $badChain 'WebView2 alternate data stream path'
  $badChain = New-SyntheticNativeOwnershipChain
  $badChain.webview.processId = $badChain.rustBackend.processId
  Assert-SyntheticNativeChainRejected $badChain 'repeated process PID'

  $childStart = [Diagnostics.ProcessStartInfo]::new((Join-Path $PSHOME 'pwsh.exe'))
  $childStart.ArgumentList.Add('-NoLogo')
  $childStart.ArgumentList.Add('-NoProfile')
  $childStart.ArgumentList.Add('-NonInteractive')
  $childStart.ArgumentList.Add('-Command')
  $syntheticListener = '$forbidden = @([Environment]::GetEnvironmentVariables().Keys | Where-Object { $_ -match ''^(?i:GH|GITHUB|ACTIONS|GIT)(_|$)'' }); if ($forbidden.Count -gt 0) { exit 41 }; $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $listener.Start(); [Console]::WriteLine($listener.LocalEndpoint.Port); Start-Sleep -Seconds 120; $listener.Stop() # morrow-g13-synthetic-owner=' + $marker
  $childStart.ArgumentList.Add($syntheticListener)
  $childStart.UseShellExecute = $false
  $childStart.CreateNoWindow = $true
  $childStart.RedirectStandardOutput = $true
  $childStart.RedirectStandardError = $true
  $childStart.Environment.Clear()
  foreach ($key in @('SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA')) {
    $value = [Environment]::GetEnvironmentVariable($key, [EnvironmentVariableTarget]::Process)
    if (-not [string]::IsNullOrEmpty($value)) { $childStart.Environment[$key] = $value }
  }
  foreach ($key in @('SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE')) {
    if ([string]::IsNullOrEmpty([string]$childStart.Environment[$key])) {
      throw 'A required synthetic child environment value is missing.'
    }
  }

  $child = [Diagnostics.Process]::Start($childStart)
  if ($null -eq $child) { throw 'The synthetic PowerShell process did not start.' }
  $stderrTask = $child.StandardError.ReadToEndAsync()
  $portTask = $child.StandardOutput.ReadLineAsync()
  if (-not $portTask.Wait(10000)) { throw 'The synthetic loopback probe did not report a port in time.' }
  $portText = $portTask.Result
  $port = 0
  if (-not [int]::TryParse($portText, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
    throw 'The synthetic loopback probe reported an invalid port.'
  }

  $identity = Get-WindowsProcessOwnershipIdentity -ProcessId $child.Id
  if ($identity.parentProcessId -ne $PID -or $identity.ownerSid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) {
    throw 'The synthetic process owner or parent does not match this runner.'
  }
  if ($identity.ownershipMarker -cne $marker) { throw 'The synthetic process marker was not visible in its process identity.' }
  [void](Assert-WindowsProcessIdentityMatches -Expected $identity -Actual (Get-WindowsProcessOwnershipIdentity -ProcessId $child.Id))

  $listener = Get-WindowsLoopbackListenerProof -Port $port -ExpectedProcessId $child.Id
  if ($listener.processId -ne $child.Id -or $listener.port -ne $port -or $listener.localAddress -notin @('127.0.0.1', '::1')) {
    throw 'The synthetic loopback listener ownership tuple did not match.'
  }
  $wrongOwnerRefused = $false
  try {
    [void](Get-WindowsLoopbackListenerProof -Port $port -ExpectedProcessId $PID)
  } catch {
    $wrongOwnerRefused = $true
  }
  if (-not $wrongOwnerRefused) { throw 'The loopback probe accepted the wrong PID as listener owner.' }

  $staleTuples = [Collections.Generic.List[object]]::new()
  foreach ($field in @('processId', 'parentProcessId', 'executablePath', 'executableSha256', 'creationTimeUtc', 'ownerSid')) {
    $stale = [pscustomobject]@{
      processId = $identity.processId
      parentProcessId = $identity.parentProcessId
      executablePath = $identity.executablePath
      executableSha256 = $identity.executableSha256
      creationTimeUtc = $identity.creationTimeUtc
      ownerSid = $identity.ownerSid
      ownershipMarker = $identity.ownershipMarker
    }
    switch ($field) {
      'processId' { $stale.processId = $child.Id + 10000 }
      'parentProcessId' { $stale.parentProcessId = $identity.parentProcessId + 1 }
      'executablePath' { $stale.executablePath = 'C:\synthetic\pwsh.exe' }
      'executableSha256' { $stale.executableSha256 = '0' * 64 }
      'creationTimeUtc' { $stale.creationTimeUtc = ([DateTime]::Parse($identity.creationTimeUtc).AddSeconds(-1)).ToString('o') }
      'ownerSid' { $stale.ownerSid = 'S-1-5-21-0-0-0-9999' }
    }
    [void]$staleTuples.Add($stale)
  }
  foreach ($stale in $staleTuples) {
    $staleRefused = $false
    try {
      Stop-VerifiedSyntheticWindowsProcess -Expected $stale -OwnershipMarker $marker | Out-Null
    } catch {
      $staleRefused = $true
    }
    if (-not $staleRefused -or $child.HasExited) { throw 'Cleanup did not reject a stale process ownership tuple.' }
  }
  [void](Assert-WindowsProcessIdentityMatches -Expected $identity -Actual (Get-WindowsProcessOwnershipIdentity -ProcessId $child.Id))

  foreach ($productName in @('morrow.exe', 'tauri-driver.exe', 'msedgedriver.exe', 'msedgewebview2.exe')) {
    $productIdentity = [pscustomobject]@{
      executablePath = "C:\synthetic\$productName"
      ownershipMarker = $marker
    }
    $productRefused = $false
    try {
      Stop-VerifiedSyntheticWindowsProcess -Expected $productIdentity -OwnershipMarker $marker | Out-Null
    } catch {
      $productRefused = $true
    }
    if (-not $productRefused) { throw 'The pre-181 cleanup helper accepted a product or driver executable.' }
  }

  $stopResult = Stop-VerifiedSyntheticWindowsProcess -Expected $identity -OwnershipMarker $marker
  if (-not $stopResult.stopped -or -not $stopResult.ownedSyntheticOnly -or -not $child.WaitForExit(5000)) {
    throw 'The exact synthetic process was not stopped after its tuple was revalidated.'
  }
  $remaining = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
  if ($remaining.Count -ne 0) { throw 'The synthetic loopback listener remained after its owned process stopped.' }
} catch {
  $line = $_.InvocationInfo.ScriptLineNumber
  $message = Get-SafeErrorMessage -Exception $_.Exception
  [Console]::Error.WriteLine(('FAIL: issue 180 synthetic process ownership contract failed at line {0}: {1}' -f $line, $message))
  $failed = $true
} finally {
  if ($null -ne $child) {
    try {
      if (-not $child.HasExited) {
        if ($null -eq $identity) {
          $identity = Get-WindowsProcessOwnershipIdentity -ProcessId $child.Id
        }
        Stop-VerifiedSyntheticWindowsProcess -Expected $identity -OwnershipMarker $marker | Out-Null
      }
    } catch {
      $failed = $true
      $line = $_.InvocationInfo.ScriptLineNumber
      $message = Get-SafeErrorMessage -Exception $_.Exception
      [Console]::Error.WriteLine(('FAIL: the test child was not cleaned because ownership could not be revalidated at line {0}: {1}' -f $line, $message))
    }
    $child.Dispose()
  }
}

if ($failed) { exit 1 }

# Emit the receipt only after the owned child and listener cleanup has completed.
# These probes prove only synthetic process and loopback ownership.
$receipt = [ordered]@{
  schemaVersion = 1
  probe = 'issue-180-synthetic-process-ownership'
  profileOutsideRunnerTempRejected = $true
  runnerTempRootCollisionRejected = $true
  syntheticWebViewArgvContractChecked = $true
  duplicateWebViewUserDataDirRejected = $true
  ambiguousWebViewUserDataDirRejected = $true
  alternateDataStreamPathRejected = $true
  reparsePathRejected = $true
  nativeOwnershipChainContractChecked = $true
  issue184ObservationSchemaChecked = $true
  nonLoopbackListenerRejected = $true
  missingNoReparseProofRejected = $true
  non4444PortRejected = $true
  wrongNativeDriverParentRejected = $true
  directTauriDriverToAppEdgeRejected = $true
  invalidTupleRejected = $true
  mixedOwnerSidRejected = $true
  credentialEnvironmentNotInherited = $true
  syntheticProcessOwned = $true
  syntheticLoopbackListenerOwned = $true
  staleTupleCleanupRefused = $true
  productAndDriverCleanupRefused = $true
  appLaunched = $false
  driverServiceStarted = $false
  nativeDriverLaunched = $false
  morrowAppLaunched = $false
  webviewProcessLaunched = $false
  windowsRuntimeIdentityConfirmed = $false
  ready = $false
}
[Console]::WriteLine(($receipt | ConvertTo-Json -Compress))
[Console]::WriteLine('PASS: issue 180 synthetic process ownership and revalidated cleanup.')
