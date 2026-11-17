[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateNotNullOrEmpty()]
  [string] $AdapterPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Throws {
  param(
    [Parameter(Mandatory)][string] $Label,
    [Parameter(Mandatory)][scriptblock] $Action
  )

  $threw = $false
  try {
    & $Action | Out-Null
  } catch {
    $threw = $true
  }
  if (-not $threw) {
    throw "Expected adapter rejection: $Label."
  }
}

function Assert-EqualIgnoreCase {
  param(
    [Parameter(Mandatory)][string] $Actual,
    [Parameter(Mandatory)][string] $Expected,
    [Parameter(Mandatory)][string] $Label
  )

  if (-not [string]::Equals($Actual, $Expected, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Independent assertion failed: $Label."
  }
}

function Copy-IdentityWithChanges {
  param(
    [Parameter(Mandatory)][psobject] $Identity,
    [Parameter(Mandatory)][hashtable] $Changes
  )

  $copy = [ordered]@{}
  foreach ($property in $Identity.PSObject.Properties) {
    $copy[$property.Name] = $property.Value
  }
  foreach ($key in $Changes.Keys) {
    $copy[$key] = $Changes[$key]
  }
  return [pscustomobject]$copy
}

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

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'This independent adapter probe must run on a Windows CI runner.'
}
$adapter = [IO.Path]::GetFullPath($AdapterPath)
if ([IO.Path]::GetFileName($adapter) -cne 'windows-process.ps1' -or -not [IO.File]::Exists($adapter)) {
  throw 'AdapterPath must point to the frozen windows-process.ps1 source.'
}
. $adapter

$runnerTemp = [Environment]::GetEnvironmentVariable('RUNNER_TEMP', [EnvironmentVariableTarget]::Process)
if ([string]::IsNullOrWhiteSpace($runnerTemp)) {
  throw 'RUNNER_TEMP is required for isolated adapter probes.'
}
$runnerTemp = ConvertTo-PilotCanonicalPath -Path $runnerTemp
$marker = [Guid]::NewGuid().ToString('N')
$ownedRoot = Join-Path $runnerTemp "issue-180-independent-$marker"
$markerPath = Join-Path $ownedRoot '.issue-180-independent-owner'
$junctionPath = Join-Path $ownedRoot 'reparse-link'
$child = $null
$childIdentity = $null
$childPort = 0
$failed = $false

try {
  [void][IO.Directory]::CreateDirectory($ownedRoot)
  $ownedRoot = ConvertTo-PilotCanonicalPath -Path $ownedRoot
  [IO.File]::WriteAllText($markerPath, $marker, [Text.UTF8Encoding]::new($false))

  $profileRoot = Join-Path $ownedRoot 'profile with spaces'
  $webViewPath = Join-Path $profileRoot 'webview data'
  [void][IO.Directory]::CreateDirectory($webViewPath)
  $profileProof = Get-PilotTemporaryPathProof -Path $profileRoot -RunnerTemp $runnerTemp
  if (-not $profileProof.underRunnerTemp -or -not $profileProof.noReparse) {
    throw 'A normal synthetic profile did not pass the RUNNER_TEMP path proof.'
  }

  $quotedCommand = '"C:\Program Files (x86)\Microsoft\EdgeWebView\msedgewebview2.exe" --type=webview --user-data-dir="' + $webViewPath + '" --lang=en-US'
  $parsedPath = Get-PilotWebViewUserDataDirectory $quotedCommand
  Assert-EqualIgnoreCase -Actual $parsedPath -Expected $webViewPath -Label 'quoted WebView user-data-dir'

  Assert-Throws -Label 'duplicate WebView user-data-dir flags' -Action {
    Get-PilotWebViewUserDataDirectory ($quotedCommand + ' --user-data-dir="' + $webViewPath + '"')
  }
  Assert-Throws -Label 'unquoted WebView path with spaces' -Action {
    Get-PilotWebViewUserDataDirectory ('--user-data-dir=' + $webViewPath + ' --lang=en-US')
  }
  Assert-Throws -Label 'empty WebView user-data-dir' -Action {
    Get-PilotWebViewUserDataDirectory '--user-data-dir='
  }
  Assert-Throws -Label 'ambiguous text after a quoted path' -Action {
    Get-PilotWebViewUserDataDirectory ('--user-data-dir="' + $webViewPath + '"suffix')
  }
  Assert-Throws -Label 'alternate data stream path' -Action {
    Get-PilotWebViewUserDataDirectory ('--user-data-dir="' + $webViewPath + ':stream"')
  }
  Assert-Throws -Label 'path containing a dot-segment alias' -Action {
    ConvertTo-PilotCanonicalPath -Path (Join-Path $ownedRoot 'profile\..\profile')
  }
  Assert-Throws -Label 'RUNNER_TEMP root collision' -Action {
    Get-PilotTemporaryPathProof -Path $runnerTemp -RunnerTemp $runnerTemp
  }
  Assert-Throws -Label 'path outside RUNNER_TEMP' -Action {
    Get-PilotTemporaryPathProof -Path $env:SystemRoot -RunnerTemp $runnerTemp
  }

  $junctionTarget = Join-Path $ownedRoot 'junction-target'
  [void][IO.Directory]::CreateDirectory($junctionTarget)
  [void](New-Item -ItemType Junction -Path $junctionPath -Target $junctionTarget -ErrorAction Stop)
  Assert-Throws -Label 'reparse point in WebView path' -Action {
    ConvertTo-PilotCanonicalPath -Path (Join-Path $junctionPath 'missing-child') -AllowMissing
  }

  $childStart = [Diagnostics.ProcessStartInfo]::new((Join-Path $PSHOME 'pwsh.exe'))
  foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command')) {
    [void]$childStart.ArgumentList.Add($argument)
  }
  $childCommand = '$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $listener.Start(); [Console]::Out.WriteLine($listener.LocalEndpoint.Port); [Console]::Out.Flush(); Start-Sleep -Seconds 120; $listener.Stop(); # morrow-g13-synthetic-owner=' + $marker
  [void]$childStart.ArgumentList.Add($childCommand)
  $childStart.UseShellExecute = $false
  $childStart.CreateNoWindow = $true
  $childStart.RedirectStandardOutput = $true
  $childStart.RedirectStandardError = $true
  $childStart.Environment.Clear()
  foreach ($name in @('SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA')) {
    $value = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::Process)
    if (-not [string]::IsNullOrEmpty($value)) {
      $childStart.Environment[$name] = $value
    }
  }
  foreach ($name in @('SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE')) {
    if ([string]::IsNullOrEmpty([string]$childStart.Environment[$name])) {
      throw 'A required Windows variable for the synthetic process is missing.'
    }
  }

  $child = [Diagnostics.Process]::Start($childStart)
  if ($null -eq $child) {
    throw 'The synthetic PowerShell child did not start.'
  }
  $stderrTask = $child.StandardError.ReadToEndAsync()
  $portTask = $child.StandardOutput.ReadLineAsync()
  if (-not $portTask.Wait(10000)) {
    throw 'The synthetic loopback process did not report a port.'
  }
  $portText = $portTask.Result
  if (-not [int]::TryParse($portText, [ref]$childPort) -or $childPort -lt 1 -or $childPort -gt 65535) {
    throw 'The synthetic loopback process reported an invalid port.'
  }

  $childIdentity = Get-WindowsProcessOwnershipIdentity -ProcessId $child.Id
  if ($childIdentity.parentProcessId -ne $PID) {
    throw 'The synthetic process parent PID did not match this test process.'
  }
  if ($childIdentity.ownerSid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) {
    throw 'The synthetic process SID did not match the hosted runner SID.'
  }
  if ($childIdentity.ownershipMarker -cne $marker) {
    throw 'The synthetic process did not carry its unique ownership marker.'
  }
  if ($childIdentity.executableSha256 -notmatch '^[a-f0-9]{64}$' -or
      [DateTime]::Parse($childIdentity.creationTimeUtc).Kind -eq [DateTimeKind]::Unspecified) {
    throw 'The synthetic process identity omitted its executable hash or UTC creation time.'
  }

  $freshIdentity = Get-WindowsProcessOwnershipIdentity -ProcessId $child.Id
  [void](Assert-WindowsProcessIdentityMatches -Expected $childIdentity -Actual $freshIdentity)
  $listenerProof = Get-WindowsLoopbackListenerProof -Port $childPort -ExpectedProcessId $child.Id
  if ($listenerProof.processId -ne $child.Id -or $listenerProof.port -ne $childPort -or
      $listenerProof.localAddress -notin @('127.0.0.1', '::1')) {
    throw 'The synthetic loopback listener proof did not match the owned process.'
  }
  Assert-Throws -Label 'wrong PID claiming synthetic listener' -Action {
    Get-WindowsLoopbackListenerProof -Port $childPort -ExpectedProcessId $PID
  }

  $staleIdentities = @(
    (Copy-IdentityWithChanges -Identity $childIdentity -Changes @{ processId = $PID }),
    (Copy-IdentityWithChanges -Identity $childIdentity -Changes @{ parentProcessId = $childIdentity.parentProcessId + 1 }),
    (Copy-IdentityWithChanges -Identity $childIdentity -Changes @{ executablePath = (Join-Path $ownedRoot 'other.exe') }),
    (Copy-IdentityWithChanges -Identity $childIdentity -Changes @{ executableSha256 = ('0' * 64) }),
    (Copy-IdentityWithChanges -Identity $childIdentity -Changes @{ creationTimeUtc = ([DateTime]::Parse($childIdentity.creationTimeUtc).AddSeconds(-1).ToString('o')) }),
    (Copy-IdentityWithChanges -Identity $childIdentity -Changes @{ ownerSid = 'S-1-5-21-0-0-0-9999' })
  )
  foreach ($stale in $staleIdentities) {
    Assert-Throws -Label 'stale process identity tuple' -Action {
      Assert-WindowsProcessIdentityMatches -Expected $childIdentity -Actual $stale
    }
    Assert-Throws -Label 'stale tuple cleanup attempt' -Action {
      Stop-VerifiedSyntheticWindowsProcess -Expected $stale -OwnershipMarker $marker
    }
    if ($child.HasExited) {
      throw 'A stale process tuple stopped the owned child.'
    }
  }

  $wrongMarker = [Guid]::NewGuid().ToString('N')
  Assert-Throws -Label 'wrong synthetic ownership marker' -Action {
    Stop-VerifiedSyntheticWindowsProcess -Expected $childIdentity -OwnershipMarker $wrongMarker
  }
  if ($child.HasExited) {
    throw 'A mismatched ownership marker stopped the synthetic child.'
  }

  $stopResult = Stop-VerifiedSyntheticWindowsProcess -Expected $childIdentity -OwnershipMarker $marker
  if (-not $stopResult.stopped -or -not $stopResult.ownedSyntheticOnly -or -not $child.WaitForExit(5000)) {
    throw 'The exact owned synthetic PowerShell process was not stopped.'
  }
  $remainingListeners = @(Get-NetTCPConnection -State Listen -LocalPort $childPort -ErrorAction SilentlyContinue)
  if ($remainingListeners.Count -ne 0) {
    throw 'The loopback listener remained after the owned synthetic child stopped.'
  }

} catch {
  $failed = $true
  [Console]::Error.WriteLine(('FAIL: issue-180 independent adapter checks failed: ' + (Get-SafeErrorMessage -Exception $_.Exception)))
} finally {
  if ($null -ne $child) {
    try {
      if (-not $child.HasExited) {
        if ($null -eq $childIdentity) {
          $childIdentity = Get-WindowsProcessOwnershipIdentity -ProcessId $child.Id
        }
        Stop-VerifiedSyntheticWindowsProcess -Expected $childIdentity -OwnershipMarker $marker | Out-Null
      }
    } catch {
      $failed = $true
      [Console]::Error.WriteLine(('FAIL: child cleanup was refused: ' + (Get-SafeErrorMessage -Exception $_.Exception)))
    } finally {
      $child.Dispose()
    }
  }

  if ([IO.Directory]::Exists($ownedRoot)) {
    try {
      $canonicalRoot = ConvertTo-PilotCanonicalPath -Path $ownedRoot
      $canonicalRunnerTemp = ConvertTo-PilotCanonicalPath -Path $runnerTemp
      $relative = [IO.Path]::GetRelativePath($canonicalRunnerTemp, $canonicalRoot)
      $markerMatches = [IO.File]::Exists($markerPath) -and
        [IO.File]::ReadAllText($markerPath) -ceq $marker
      if (-not $markerMatches -or $relative -eq '.' -or $relative.StartsWith('..\', [StringComparison]::Ordinal)) {
        throw 'The independent scratch directory ownership could not be proven.'
      }
      if ([IO.Directory]::Exists($junctionPath)) {
        [IO.Directory]::Delete($junctionPath)
      }
      [IO.Directory]::Delete($ownedRoot, $true)
    } catch {
      $failed = $true
      [Console]::Error.WriteLine(('FAIL: temporary probe cleanup was refused: ' + (Get-SafeErrorMessage -Exception $_.Exception)))
    }
  }
}

if (-not $failed) {
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject ([ordered]@{
    status = 'passed'
    scope = 'issue-180 independent PS/CIM adapter probes'
    syntheticChildOnly = $true
    listenerLoopbackOwned = $true
    staleTupleCleanupRefused = $true
    parserAndPathGuardsChecked = $true
    reparseRejected = $true
    appLaunched = $false
    driverServiceStarted = $false
    realChainValidated = $false
    readiness = $false
  })))
}

if ($failed) {
  exit 1
}
