function ConvertTo-PilotCanonicalPath {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string] $Path,
    [switch] $AllowMissing
  )

  if ([string]::IsNullOrWhiteSpace($Path) -or $Path.Contains([char]0) -or $Path.Contains('/')) {
    throw 'A process path is empty or not a normalized Windows path.'
  }
  if ($Path.StartsWith('\\') -or $Path.StartsWith('\\?\') -or $Path.StartsWith('\\.\') -or $Path -notmatch '^[A-Za-z]:\\') {
    throw 'A process path must use a local drive, not a network or device path.'
  }
  $full = [IO.Path]::GetFullPath($Path)
  if (-not [string]::Equals($full.TrimEnd('\'), $Path.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'A process path is not in normalized form.'
  }
  $driveRoot = [IO.Path]::GetPathRoot($full)
  $remaining = $full.Substring($driveRoot.Length)
  $current = $driveRoot
  foreach ($segment in $remaining.Split([char[]]@('\'), [StringSplitOptions]::RemoveEmptyEntries)) {
    if ($segment.Contains(':')) {
      throw 'A process path component contains an alternate data stream separator.'
    }
    if ($segment -eq '.' -or $segment -eq '..' -or $segment.EndsWith('.') -or $segment.EndsWith(' ')) {
      throw 'A process path contains a dot segment or Windows path alias.'
    }
    $current = [IO.Path]::Combine($current, $segment)
    if ([IO.File]::Exists($current) -or [IO.Directory]::Exists($current)) {
      $attributes = [IO.File]::GetAttributes($current)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'A process path crosses a reparse point or junction.'
      }
    } elseif (-not $AllowMissing) {
      throw 'A process path component does not exist.'
    }
  }
  if (-not $AllowMissing -and -not [IO.File]::Exists($full) -and -not [IO.Directory]::Exists($full)) {
    throw 'A process path does not exist.'
  }
  return $full.TrimEnd('\')
}

function Get-PilotWebViewUserDataDirectory([string] $CommandLine) {
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $null }
  $flags = [regex]::Matches($CommandLine, '(?i)(?:^|\s)--user-data-dir(?=\s|=|$)')
  if ($flags.Count -gt 1) {
    throw 'The WebView2 command line contains multiple --user-data-dir arguments.'
  }
  if ($flags.Count -eq 0) { return $null }

  $tailStart = $flags[0].Index + $flags[0].Length
  $tail = $CommandLine.Substring($tailStart)
  if ($tail.StartsWith('=')) {
    $tail = $tail.Substring(1)
  } else {
    $tail = $tail.TrimStart()
  }
  if ([string]::IsNullOrWhiteSpace($tail)) {
    throw 'The WebView2 --user-data-dir argument has no value.'
  }

  if ($tail.StartsWith('"')) {
    $closingQuote = $tail.IndexOf('"', 1)
    if ($closingQuote -le 1) { throw 'The WebView2 --user-data-dir argument has ambiguous quoting.' }
    if ($closingQuote + 1 -lt $tail.Length -and -not [char]::IsWhiteSpace($tail[$closingQuote + 1])) {
      throw 'The WebView2 --user-data-dir argument has trailing non-separator characters.'
    }
    $value = $tail.Substring(1, $closingQuote - 1)
  } else {
    $bare = [regex]::Match($tail, '^(?<value>[^\s"]+)')
    if (-not $bare.Success) { throw 'The WebView2 --user-data-dir argument has no unambiguous value.' }
    $value = $bare.Groups['value'].Value
    $remainder = $tail.Substring($bare.Length).TrimStart()
    if ($remainder -and -not $remainder.StartsWith('-')) {
      throw 'The WebView2 --user-data-dir value contains ambiguous unquoted whitespace.'
    }
  }
  if ([string]::IsNullOrWhiteSpace($value)) { throw 'The WebView2 --user-data-dir value is empty.' }
  return (ConvertTo-PilotCanonicalPath -Path $value -AllowMissing)
}

function Get-PilotSyntheticOwnershipMarker([string] $CommandLine) {
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $null }
  $match = [regex]::Match($CommandLine, '(?i)morrow-g13-synthetic-owner=([a-f0-9]{32})')
  if (-not $match.Success) { return $null }
  return $match.Groups[1].Value.ToLowerInvariant()
}

function Get-WindowsProcessOwnershipIdentity {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][ValidateRange(1, 2147483647)][int] $ProcessId,
    [switch] $ParseWebViewUserDataDirectory
  )

  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Win32 process ownership can only be observed on Windows.'
  }
  $processes = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop)
  if ($processes.Count -ne 1) { throw 'The process PID is missing or ambiguous.' }
  $process = $processes[0]
  if ([int]$process.ProcessId -ne $ProcessId -or [string]::IsNullOrWhiteSpace([string]$process.ExecutablePath)) {
    throw 'The process PID or executable path could not be verified.'
  }
  $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop
  if ($null -eq $owner -or [uint32]$owner.ReturnValue -ne 0 -or [string]::IsNullOrWhiteSpace([string]$owner.Sid)) {
    throw 'Win32_Process.GetOwnerSid did not return a process owner.'
  }
  $creationValue = $process.CreationDate
  if ($creationValue -is [datetime]) {
    $creation = $creationValue.ToUniversalTime()
  } else {
    $creation = [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$creationValue).ToUniversalTime()
  }
  $executablePath = ConvertTo-PilotCanonicalPath -Path ([string]$process.ExecutablePath)
  $executableSha256 = (Get-FileHash -LiteralPath $executablePath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
  $commandLine = [string]$process.CommandLine
  $webViewUserDataDirectory = $null
  if ($ParseWebViewUserDataDirectory) {
    $webViewUserDataDirectory = Get-PilotWebViewUserDataDirectory $commandLine
  }

  return [pscustomobject]@{
    processId = [int]$process.ProcessId
    parentProcessId = [int]$process.ParentProcessId
    executablePath = $executablePath
    executableSha256 = $executableSha256
    creationTimeUtc = $creation.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    ownerSid = [string]$owner.Sid
    commandLineUserDataDir = $webViewUserDataDirectory
    ownershipMarker = Get-PilotSyntheticOwnershipMarker $commandLine
  }
}

function Get-WindowsLoopbackListenerProof {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][ValidateRange(1, 65535)][int] $Port,
    [Parameter(Mandatory)][ValidateRange(1, 2147483647)][int] $ExpectedProcessId
  )

  if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
    throw 'Get-NetTCPConnection is unavailable; listener ownership cannot be verified.'
  }
  $connections = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop)
  if ($connections.Count -eq 0) { throw 'The expected loopback listener is missing.' }
  $owners = @($connections | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)
  if ($owners.Count -ne 1 -or $owners[0] -ne $ExpectedProcessId) {
    throw 'The loopback listener is not owned by the expected process PID.'
  }
  foreach ($connection in $connections) {
    if ([string]$connection.LocalAddress -notin @('127.0.0.1', '::1')) {
      throw 'The process listener is exposed beyond the loopback interface.'
    }
  }
  $address = if (@($connections | Where-Object { [string]$_.LocalAddress -eq '127.0.0.1' }).Count -gt 0) { '127.0.0.1' } else { '::1' }
  return [pscustomobject]@{
    processId = [int]$owners[0]
    port = $Port
    localAddress = $address
  }
}

function Get-PilotTemporaryPathProof {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string] $Path,
    [Parameter(Mandatory)][string] $RunnerTemp
  )

  $root = ConvertTo-PilotCanonicalPath -Path $RunnerTemp
  $full = ConvertTo-PilotCanonicalPath -Path $Path
  $relative = [IO.Path]::GetRelativePath($root, $full)
  if ([string]::IsNullOrWhiteSpace($relative) -or $relative -eq '.' -or [IO.Path]::IsPathRooted($relative) -or
      $relative -eq '..' -or $relative.StartsWith('..\', [StringComparison]::Ordinal) -or
      $relative.StartsWith('../', [StringComparison]::Ordinal)) {
    throw 'An isolated runtime path must be a distinct child of RUNNER_TEMP.'
  }
  return [pscustomobject]@{
    path = $full
    underRunnerTemp = $true
    noReparse = $true
  }
}

function Assert-WindowsPilotOwnershipChain {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][psobject] $Driver,
    [Parameter(Mandatory)][psobject] $NativeDriver,
    [Parameter(Mandatory)][psobject] $RustBackend,
    [Parameter(Mandatory)][psobject] $WebView,
    [Parameter(Mandatory)][ValidatePattern('^S-\d-\d+(?:-\d+)+$')][string] $ExpectedOwnerSid,
    [Parameter(Mandatory)][ValidateRange(1, 2147483647)][int] $ExpectedDriverParentProcessId
  )

  $nodes = @($Driver, $NativeDriver, $RustBackend, $WebView)
  foreach ($node in $nodes) {
    if ([int]$node.processId -le 0 -or [int]$node.parentProcessId -le 0) {
      throw 'The process ownership chain contains an invalid PID or parent PID.'
    }
    if ([string]$node.executablePath -notmatch '^[A-Za-z]:\\' -or [string]$node.executablePath -match '[\\/]{2}') {
      throw 'The process ownership chain contains a non-local executable path.'
    }
    $segments = ([string]$node.executablePath).Substring(3).Split([char[]]@('\'), [StringSplitOptions]::RemoveEmptyEntries)
    if (@($segments | Where-Object { $_.Contains(':') -or $_ -eq '.' -or $_ -eq '..' -or $_.EndsWith('.') -or $_.EndsWith(' ') }).Count -gt 0) {
      throw 'The process ownership chain contains an ambiguous executable path.'
    }
    if ([string]$node.executableSha256 -notmatch '^[a-fA-F0-9]{64}$') {
      throw 'The process ownership chain contains an invalid executable digest.'
    }
    $creation = [DateTime]::MinValue
    $validCreationTime = [DateTime]::TryParse(
        [string]$node.creationTimeUtc,
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind,
        [ref]$creation
      )
    if (-not $validCreationTime -or $creation.Kind -ne [DateTimeKind]::Utc) {
      throw 'The process ownership chain contains an invalid creation time.'
    }
    if ([string]$node.ownerSid -notmatch '^S-\d-\d+(?:-\d+)+$') {
      throw 'The process ownership chain contains an invalid owner SID.'
    }
  }

  $processIds = @($nodes | ForEach-Object { [int]$_.processId } | Sort-Object -Unique)
  if ($processIds.Count -ne 4) { throw 'The process ownership chain contains a repeated PID.' }
  if ([IO.Path]::GetFileName([string]$Driver.executablePath) -ine 'tauri-driver.exe') {
    throw 'The listener process is not the expected tauri-driver executable.'
  }
  if ([IO.Path]::GetFileName([string]$NativeDriver.executablePath) -ine 'msedgedriver.exe') {
    throw 'The native driver process is not msedgedriver.exe.'
  }
  if ([IO.Path]::GetFileName([string]$RustBackend.executablePath) -ine 'morrow.exe') {
    throw 'The Rust backend process is not the staged Morrow executable.'
  }
  if ([IO.Path]::GetFileName([string]$WebView.executablePath) -ine 'msedgewebview2.exe' -or
      [string]$WebView.executablePath -notmatch '(?i)\\Microsoft\\EdgeWebView\\Application\\[^\\]+\\msedgewebview2\.exe$') {
    throw 'The final process in the ownership chain is not Microsoft WebView2.'
  }

  if (@($nodes | Where-Object { [string]$_.ownerSid -cne $ExpectedOwnerSid }).Count -gt 0) {
    throw 'Every process in the native ownership chain must run under the isolated runner SID.'
  }
  if ([int]$Driver.parentProcessId -ne $ExpectedDriverParentProcessId -or
      [int]$NativeDriver.parentProcessId -ne [int]$Driver.processId -or
      [int]$RustBackend.parentProcessId -ne [int]$NativeDriver.processId -or
      [int]$WebView.parentProcessId -ne [int]$RustBackend.processId) {
    throw 'The tauri-driver, msedgedriver, Morrow, and WebView2 parent chain is incomplete or ambiguous.'
  }

  return $true
}

function Assert-WindowsPilotObservationShape {
  [CmdletBinding()]
  param([Parameter(Mandatory)][psobject] $Observation)

  $expectedNames = @('driver', 'nativeDriver', 'rustBackend', 'webview', 'listener', 'isolatedPaths')
  $actualNames = @($Observation.PSObject.Properties.Name)
  if (($actualNames -join '|') -cne ($expectedNames -join '|')) {
    throw 'The issue 184 ownership observation schema changed or is incomplete.'
  }
  foreach ($name in @('driver', 'nativeDriver', 'rustBackend', 'webview')) {
    $process = $Observation.$name
    foreach ($field in @('processId', 'parentProcessId', 'executablePath', 'executableSha256', 'creationTimeUtc', 'ownerSid')) {
      if (-not $process.PSObject.Properties[$field]) {
        throw "The issue 184 $name tuple is missing $field."
      }
    }
  }
  if (-not $Observation.webview.PSObject.Properties['commandLineUserDataDir']) {
    throw 'The issue 184 WebView2 tuple is missing the effective user-data directory.'
  }
  foreach ($field in @('processId', 'port', 'localAddress')) {
    if (-not $Observation.listener.PSObject.Properties[$field]) {
      throw "The issue 184 listener proof is missing $field."
    }
  }
  if ([int]$Observation.listener.processId -ne [int]$Observation.driver.processId -or
      [int]$Observation.listener.port -ne 4444 -or
      [string]$Observation.listener.localAddress -notin @('127.0.0.1', '::1')) {
    throw 'The issue 184 listener must be loopback:4444 and owned by the tauri-driver PID.'
  }
  foreach ($field in @(
      'backendPath', 'backendUnderRunnerTemp', 'backendNoReparse',
      'webviewPath', 'webviewUnderRunnerTemp', 'webviewNoReparse',
      'vaultPath', 'vaultUnderRunnerTemp', 'vaultNoReparse',
      'evidencePath', 'evidenceUnderRunnerTemp', 'evidenceNoReparse'
    )) {
    if (-not $Observation.isolatedPaths.PSObject.Properties[$field]) {
      throw "The issue 184 isolated path proof is missing $field."
    }
  }
  foreach ($name in @('backend', 'webview', 'vault', 'evidence')) {
    $underRunnerTempField = "${name}UnderRunnerTemp"
    $noReparseField = "${name}NoReparse"
    if (-not [bool]$Observation.isolatedPaths.PSObject.Properties[$underRunnerTempField].Value -or
        -not [bool]$Observation.isolatedPaths.PSObject.Properties[$noReparseField].Value) {
      throw "The issue 184 $name path is outside RUNNER_TEMP or crosses a reparse point."
    }
  }
  return $true
}

# Frozen observation interface for issue 184: driver, nativeDriver, rustBackend,
# webview, listener, and isolatedPaths. This function only observes supplied PIDs.
function Get-WindowsPilotOwnershipObservation {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][ValidateRange(1, 2147483647)][int] $DriverProcessId,
    [Parameter(Mandatory)][ValidateRange(1, 2147483647)][int] $NativeDriverProcessId,
    [Parameter(Mandatory)][ValidateRange(1, 2147483647)][int] $RustBackendProcessId,
    [Parameter(Mandatory)][ValidateRange(1, 2147483647)][int] $WebViewProcessId,
    [Parameter(Mandatory)][ValidateRange(1, 2147483647)][int] $ExpectedDriverParentProcessId,
    [Parameter(Mandatory)][ValidateRange(4444, 4444)][int] $DriverPort,
    [Parameter(Mandatory)][string] $BackendDataPath,
    [Parameter(Mandatory)][string] $WebViewDataPath,
    [Parameter(Mandatory)][string] $VaultPath,
    [Parameter(Mandatory)][string] $EvidencePath,
    [Parameter(Mandatory)][string] $RunnerTemp
  )

  $driver = Get-WindowsProcessOwnershipIdentity -ProcessId $DriverProcessId
  $nativeDriver = Get-WindowsProcessOwnershipIdentity -ProcessId $NativeDriverProcessId
  $backend = Get-WindowsProcessOwnershipIdentity -ProcessId $RustBackendProcessId
  $webview = Get-WindowsProcessOwnershipIdentity -ProcessId $WebViewProcessId -ParseWebViewUserDataDirectory
  if ($null -eq $webview.commandLineUserDataDir) {
    throw 'The WebView2 process has no observable --user-data-dir argument.'
  }
  $listener = Get-WindowsLoopbackListenerProof -Port $DriverPort -ExpectedProcessId $DriverProcessId
  $backendPathProof = Get-PilotTemporaryPathProof -Path $BackendDataPath -RunnerTemp $RunnerTemp
  $webviewPathProof = Get-PilotTemporaryPathProof -Path $WebViewDataPath -RunnerTemp $RunnerTemp
  $effectiveWebviewPathProof = Get-PilotTemporaryPathProof -Path $webview.commandLineUserDataDir -RunnerTemp $RunnerTemp
  $vaultPathProof = Get-PilotTemporaryPathProof -Path $VaultPath -RunnerTemp $RunnerTemp
  $evidencePathProof = Get-PilotTemporaryPathProof -Path $EvidencePath -RunnerTemp $RunnerTemp
  if (-not [string]::Equals($effectiveWebviewPathProof.path, $webviewPathProof.path, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The effective WebView2 --user-data-dir differs from the isolated profile path.'
  }
  $runnerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  [void](Assert-WindowsPilotOwnershipChain -Driver $driver -NativeDriver $nativeDriver -RustBackend $backend -WebView $webview -ExpectedOwnerSid $runnerSid -ExpectedDriverParentProcessId $ExpectedDriverParentProcessId)

  $observation = [pscustomobject][ordered]@{
    driver = $driver
    nativeDriver = $nativeDriver
    rustBackend = $backend
    webview = $webview
    listener = $listener
    isolatedPaths = [pscustomobject]@{
      backendPath = $backendPathProof.path
      backendUnderRunnerTemp = $backendPathProof.underRunnerTemp
      backendNoReparse = $backendPathProof.noReparse
      webviewPath = $webviewPathProof.path
      webviewUnderRunnerTemp = $webviewPathProof.underRunnerTemp
      webviewNoReparse = $webviewPathProof.noReparse
      vaultPath = $vaultPathProof.path
      vaultUnderRunnerTemp = $vaultPathProof.underRunnerTemp
      vaultNoReparse = $vaultPathProof.noReparse
      evidencePath = $evidencePathProof.path
      evidenceUnderRunnerTemp = $evidencePathProof.underRunnerTemp
      evidenceNoReparse = $evidencePathProof.noReparse
    }
  }
  [void](Assert-WindowsPilotObservationShape -Observation $observation)
  return $observation
}

function Assert-WindowsProcessIdentityMatches {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][psobject] $Expected,
    [Parameter(Mandatory)][psobject] $Actual
  )

  foreach ($field in @('processId', 'parentProcessId', 'creationTimeUtc', 'ownerSid', 'executableSha256')) {
    if ([string]$Expected.$field -cne [string]$Actual.$field) {
      throw "The process ownership tuple changed at $field."
    }
  }
  $expectedPath = ConvertTo-PilotCanonicalPath -Path ([string]$Expected.executablePath)
  $actualPath = ConvertTo-PilotCanonicalPath -Path ([string]$Actual.executablePath)
  if (-not [string]::Equals($expectedPath, $actualPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The process canonical executable path changed.'
  }
  if ($Expected.ownershipMarker -and $Expected.ownershipMarker -cne $Actual.ownershipMarker) {
    throw 'The synthetic runner ownership marker changed.'
  }
  return $true
}

function Stop-VerifiedSyntheticWindowsProcess {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][psobject] $Expected,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{32}$')][string] $OwnershipMarker
  )

  if ($Expected.ownershipMarker -cne $OwnershipMarker) {
    throw 'The process does not carry the exact synthetic test ownership marker.'
  }
  $name = [IO.Path]::GetFileName([string]$Expected.executablePath)
  if ($name -notin @('pwsh.exe', 'powershell.exe')) {
    throw 'This pre-181 cleanup helper only stops an explicitly owned synthetic PowerShell child.'
  }

  $before = Get-WindowsProcessOwnershipIdentity -ProcessId ([int]$Expected.processId)
  [void](Assert-WindowsProcessIdentityMatches -Expected $Expected -Actual $before)

  $process = [Diagnostics.Process]::GetProcessById([int]$Expected.processId)
  try {
    # Pin one process handle before the final CIM read. Kill() uses this handle,
    # so PID reuse after revalidation cannot redirect cleanup to a new process.
    $handle = $process.Handle
    if (-not ('MorrowG13ProcessHandle' -as [type])) {
      $nativeProcessType = Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MorrowG13ProcessHandle
{
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetProcessTimes(IntPtr processHandle, out long creationTime, out long exitTime, out long kernelTime, out long userTime);
}
'@
    }
    [long]$creation = 0
    [long]$exit = 0
    [long]$kernel = 0
    [long]$user = 0
    if (-not [MorrowG13ProcessHandle]::GetProcessTimes($handle, [ref]$creation, [ref]$exit, [ref]$kernel, [ref]$user)) {
      throw 'The process handle creation time could not be read.'
    }
    $handleCreation = [DateTime]::FromFileTimeUtc($creation)
    $expectedCreation = [DateTime]::Parse(
      [string]$Expected.creationTimeUtc,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind
    ).ToUniversalTime()
    if ([Math]::Abs(($handleCreation - $expectedCreation).Ticks) -gt 20) {
      throw 'The process handle refers to a different creation time; cleanup was refused.'
    }
    $handlePath = ConvertTo-PilotCanonicalPath -Path ([string]$process.MainModule.FileName)
    if (-not [string]::Equals($handlePath, [string]$Expected.executablePath, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'The process handle executable path changed; cleanup was refused.'
    }
    $handleHash = (Get-FileHash -LiteralPath $handlePath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    if ($handleHash -cne [string]$Expected.executableSha256) {
      throw 'The process handle executable digest changed; cleanup was refused.'
    }

    $final = Get-WindowsProcessOwnershipIdentity -ProcessId ([int]$Expected.processId)
    [void](Assert-WindowsProcessIdentityMatches -Expected $Expected -Actual $final)
    if ($final.ownershipMarker -cne $OwnershipMarker) {
      throw 'The synthetic test marker changed before cleanup.'
    }
    $process.Kill()
    if (-not $process.WaitForExit(5000)) { throw 'The owned synthetic process did not stop within five seconds.' }
    return [pscustomobject]@{ stopped = $true; ownedSyntheticOnly = $true }
  } finally {
    $process.Dispose()
  }
}
