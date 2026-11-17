[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateNotNullOrEmpty()]
  [string] $EvidenceRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$runId = [Guid]::NewGuid().ToString('N')
$checks = [ordered]@{
  evidenceRootCreatedAndOwned = $false
  dotSourceHasNoInteropSideEffects = $false
  explicitArgvAndUnicodeEnvironmentChecked = $false
  syntheticOutsiderStarted = $false
  createObserveResumeStop = $false
  rootExitObserved = $false
  descendantSurvivesRootAndIsJobMember = $false
  descendantStoppedWithJob = $false
  outsiderPreserved = $false
  disposeIsIdempotentAndStopsSuspendedRoot = $false
  creationErrorFailsClosed = $false
  consumerDeathAfterReturnBeforeResume = $false
  noProductOrGuiLaunched = $true
}
$observations = [Collections.Generic.List[object]]::new()
$sessions = [Collections.Generic.List[object]]::new()
$disposedSessions = [Collections.Generic.List[object]]::new()
$observedProcesses = [Collections.Generic.List[object]]::new()
$ownedProcesses = [Collections.Generic.List[object]]::new()
$helperOutput = [Collections.Generic.List[object]]::new()
$cleanupErrors = [Collections.Generic.List[string]]::new()
$failure = $null
$runnerTemp = [Environment]::GetEnvironmentVariable('RUNNER_TEMP', [EnvironmentVariableTarget]::Process)
$evidenceFullPath = $null
$scratch = $null
$ownerMarkerPath = $null
$evidenceCreated = $false
$pwshPath = $null
$explicitEnvironment = $null
$outsider = $null
$outsiderAliveAtTestEnd = $false
$parentSentinelName = 'MORROW_188_PARENT_SENTINEL'
$parentSentinelBefore = $null
$parentSentinelChanged = $false
$argvSentinel = 'issue 188 argument with spaces and trailing slash \'
$adapterPath = Join-Path $PSScriptRoot 'windows-native-job.ps1'

function ConvertTo-SafeErrorMessage {
  param([Parameter(Mandatory)][Exception] $Exception)

  $message = [string]$Exception.Message
  $message = $message -replace '[\r\n\t]+', ' '
  foreach ($sensitivePath in @($runnerTemp, $evidenceFullPath, $scratch, [Environment]::GetEnvironmentVariable('USERPROFILE', [EnvironmentVariableTarget]::Process))) {
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

function ConvertTo-SafeLogText {
  param([Parameter(Mandatory)][AllowEmptyString()][string] $Text)

  if ([string]::IsNullOrEmpty($Text)) { return '' }
  $lines = [Collections.Generic.List[string]]::new()
  foreach ($line in ($Text -split '\r?\n')) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    [void]$lines.Add((ConvertTo-SafeErrorMessage -Exception ([Exception]::new([string]$line))))
    if ($lines.Count -ge 100) {
      [void]$lines.Add('<LOG_TRUNCATED>')
      break
    }
  }
  return [string]::Join([Environment]::NewLine, $lines)
}

function Assert-Check {
  param(
    [Parameter(Mandatory)][string] $Name,
    [Parameter(Mandatory)][bool] $Condition,
    [Parameter(Mandatory)][string] $Message
  )

  if (-not $Condition) { throw "Assertion failed ($Name): $Message" }
  $checks[$Name] = $true
}

function Assert-Throws {
  param(
    [Parameter(Mandatory)][string] $Name,
    [Parameter(Mandatory)][scriptblock] $Action
  )

  $threw = $false
  try {
    & $Action | Out-Null
  } catch {
    $threw = $true
  }
  if (-not $threw) { throw "Expected the operation to fail closed: $Name." }
}

function ConvertTo-PowerShellLiteral {
  param([Parameter(Mandatory)][string] $Value)
  return "'" + $Value.Replace("'", "''") + "'"
}

function Write-Utf8File {
  param(
    [Parameter(Mandatory)][string] $Path,
    [Parameter(Mandatory)][AllowEmptyString()][string] $Content
  )
  [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function New-TestScript {
  param(
    [Parameter(Mandatory)][string] $Name,
    [Parameter(Mandatory)][AllowEmptyString()][string] $Content
  )
  $path = Join-Path $scratch $Name
  Write-Utf8File -Path $path -Content $Content
  return $path
}

function Get-ExplicitTestEnvironment {
  $names = @(
    'SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE',
    'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramData', 'PSModulePath', 'DOTNET_ROOT'
  )
  $values = @{}
  foreach ($name in $names) {
    $value = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::Process)
    if ($null -ne $value) { $values[$name] = [string]$value }
  }
  foreach ($required in @('SystemRoot', 'PATH', 'TEMP', 'TMP', 'USERPROFILE')) {
    if ([string]::IsNullOrWhiteSpace([string]$values[$required])) {
      throw "The Windows runner is missing a required synthetic process environment variable: $required."
    }
  }
  $values['MORROW_188_UNICODE_SENTINEL'] = 'explicit-λ-東京'
  return $values
}

function New-PowerShellProcessStartInfo {
  param(
    [Parameter(Mandatory)][string] $ScriptPath,
    [AllowEmptyCollection()][string[]] $ExtraArguments = @(),
    [switch] $RedirectOutput
  )

  $info = [Diagnostics.ProcessStartInfo]::new($pwshPath)
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.Environment.Clear()
  foreach ($name in $explicitEnvironment.Keys) {
    $info.Environment[[string]$name] = [string]$explicitEnvironment[$name]
  }
  foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $ScriptPath) + $ExtraArguments) {
    [void]$info.ArgumentList.Add([string]$argument)
  }
  if ($RedirectOutput) {
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
  }
  return $info
}

function Start-OwnedPowerShellProcess {
  param(
    [Parameter(Mandatory)][ValidateSet('outsider', 'consumer')][string] $Role,
    [Parameter(Mandatory)][string] $ScriptPath,
    [AllowEmptyCollection()][string[]] $ExtraArguments = @()
  )

  $info = New-PowerShellProcessStartInfo -ScriptPath $ScriptPath -ExtraArguments $ExtraArguments -RedirectOutput
  $process = [Diagnostics.Process]::Start($info)
  if ($null -eq $process) { throw 'A synthetic PowerShell helper process did not start.' }
  [void]$ownedProcesses.Add($process)
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  [void]$helperOutput.Add([pscustomobject]@{
    role = $Role
    processId = [int]$process.Id
    process = $process
    stdoutTask = $stdoutTask
    stderrTask = $stderrTask
    exitCode = $null
  })
  return $process
}

function Wait-ForCondition {
  param(
    [Parameter(Mandatory)][scriptblock] $Condition,
    [Parameter(Mandatory)][int] $TimeoutMs,
    [Parameter(Mandatory)][string] $Label
  )

  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 25
  }
  if (& $Condition) { return }
  throw "Timed out waiting for $Label."
}

function Open-ObservedProcess {
  param([Parameter(Mandatory)][psobject] $Observation)

  $process = [Diagnostics.Process]::GetProcessById([int]$Observation.processId)
  try {
    $actualPath = [string]$process.MainModule.FileName
    $expectedPath = [string]$Observation.executablePath
    $actualCreation = $process.StartTime.ToUniversalTime()
    $expectedCreation = [DateTime]::Parse(
      [string]$Observation.creationTimeUtc,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind
    ).ToUniversalTime()
    if (-not [string]::Equals($actualPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase) -or
        [Math]::Abs(($actualCreation - $expectedCreation).TotalSeconds) -gt 2) {
      throw 'The independently opened process does not match the native observation identity.'
    }
    [void]$observedProcesses.Add($process)
    return $process
  } catch {
    $process.Dispose()
    throw
  }
}

function Close-ObservedProcess {
  param([Parameter(Mandatory)][Diagnostics.Process] $Process)

  if ($observedProcesses.Remove($Process)) { $Process.Dispose() }
}

function Test-ObservedIdentityAlive {
  param(
    [Parameter(Mandatory)][int] $ProcessId,
    [Parameter(Mandatory)][string] $ExecutablePath,
    [Parameter(Mandatory)][string] $CreationTimeUtc
  )

  try {
    $process = [Diagnostics.Process]::GetProcessById($ProcessId)
  } catch [ArgumentException] {
    return $false
  }
  try {
    $actualPath = [string]$process.MainModule.FileName
    $actualCreation = $process.StartTime.ToUniversalTime()
    $expectedCreation = [DateTime]::Parse(
      $CreationTimeUtc,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind
    ).ToUniversalTime()
    return [string]::Equals($actualPath, $ExecutablePath, [StringComparison]::OrdinalIgnoreCase) -and
      [Math]::Abs(($actualCreation - $expectedCreation).TotalSeconds) -le 2
  } finally {
    $process.Dispose()
  }
}

function Assert-OutsiderAlive {
  if ($null -eq $outsider -or $outsider.HasExited) {
    throw 'The exact synthetic outsider process was unexpectedly stopped.'
  }
}

function Start-RootSession {
  param([Parameter(Mandatory)][string] $ScriptPath)

  $session = CreateAtomicSuspendedRoot `
    -ExecutablePath $pwshPath `
    -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $ScriptPath, $argvSentinel) `
    -Environment $explicitEnvironment `
    -WorkingDirectory $scratch
  if ($session.GetType().FullName -cne 'Morrow.Pilot.WindowsNativeJobSession') {
    $session.Dispose()
    throw 'The factory did not return its opaque in-process session directly.'
  }
  [void]$sessions.Add($session)
  return $session
}

function Assert-InitialSuspendedObservation {
  param([Parameter(Mandatory)][psobject] $Observation)

  Assert-Check -Name 'createObserveResumeStop' -Condition (
    $Observation.state -ceq 'suspended' -and
    [bool]$Observation.isMember -and
    [bool]$Observation.wasAssociatedAtCreation -and
    $null -eq $Observation.parentProcessId -and
    [int]$Observation.creatorProcessId -eq $PID -and
    [int]$Observation.jobLimitFlags -eq 8192 -and
    -not [bool]$Observation.jobHandleInheritable
  ) -Message 'Creation must return a suspended member, expose creator provenance separately, and prove the private Job flags/handle.'
  $observations.Add([pscustomobject]@{
    processId = [int]$Observation.processId
    creatorProcessId = [int]$Observation.creatorProcessId
    parentProcessId = $null
    creationTimeUtc = [string]$Observation.creationTimeUtc
    image = [IO.Path]::GetFileName([string]$Observation.executablePath)
    state = [string]$Observation.state
    isMember = [bool]$Observation.isMember
    jobLimitFlags = [int]$Observation.jobLimitFlags
    jobHandleInheritable = [bool]$Observation.jobHandleInheritable
  })
}

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This test requires a real Windows runner; Linux is not evidence for Win32 behavior.'
  }
  if ([string]::IsNullOrWhiteSpace([string]$runnerTemp) -or -not [IO.Directory]::Exists([string]$runnerTemp)) {
    throw 'RUNNER_TEMP must be an existing directory on the Windows runner.'
  }

  $parentSentinelBefore = [Environment]::GetEnvironmentVariable($parentSentinelName, [EnvironmentVariableTarget]::Process)
  [Environment]::SetEnvironmentVariable($parentSentinelName, 'must-not-inherit', [EnvironmentVariableTarget]::Process)
  $parentSentinelChanged = $true

  $runnerTempFull = [IO.Path]::GetFullPath([string]$runnerTemp).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $evidenceFullPath = [IO.Path]::GetFullPath($EvidenceRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $relativeEvidence = [IO.Path]::GetRelativePath($runnerTempFull, $evidenceFullPath)
  if ($relativeEvidence -eq '.' -or [IO.Path]::IsPathRooted($relativeEvidence) -or
      $relativeEvidence -eq '..' -or $relativeEvidence.StartsWith('..' + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
      $relativeEvidence.StartsWith('..' + [IO.Path]::AltDirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'EvidenceRoot must be a distinct child directory under RUNNER_TEMP.'
  }
  if ([IO.Directory]::Exists($evidenceFullPath) -or [IO.File]::Exists($evidenceFullPath)) {
    throw 'EvidenceRoot must be new for this test attempt.'
  }
  $cursor = $runnerTempFull
  $runnerAttributes = [IO.File]::GetAttributes($cursor)
  if (($runnerAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'RUNNER_TEMP may not be a reparse point for this test.'
  }
  $segments = $relativeEvidence.Split([char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar), [StringSplitOptions]::RemoveEmptyEntries)
  if ($segments.Count -eq 0) { throw 'EvidenceRoot path is empty after normalization.' }
  for ($index = 0; $index -lt $segments.Count - 1; $index++) {
    $cursor = [IO.Path]::Combine($cursor, $segments[$index])
    if (-not [IO.Directory]::Exists($cursor)) { throw 'The EvidenceRoot parent directory does not exist under RUNNER_TEMP.' }
    if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'EvidenceRoot crosses a reparse point.'
    }
  }

  [void][IO.Directory]::CreateDirectory($evidenceFullPath)
  $evidenceCreated = $true
  $ownerMarkerPath = Join-Path $evidenceFullPath '.owner'
  Write-Utf8File -Path $ownerMarkerPath -Content $runId
  $scratch = Join-Path $evidenceFullPath ('.scratch-' + $runId)
  [void][IO.Directory]::CreateDirectory($scratch)
  $checks.evidenceRootCreatedAndOwned = $true

  if (-not [IO.File]::Exists($adapterPath)) { throw 'The native Job adapter file was not found beside this test.' }
  $interopLoadedBeforeDotSource = $null -ne ('Morrow.Pilot.WindowsNativeJobInterop' -as [type])
  . $adapterPath
  $interopLoadedByDotSource = $null -ne ('Morrow.Pilot.WindowsNativeJobInterop' -as [type])
  Assert-Check -Name 'dotSourceHasNoInteropSideEffects' -Condition (-not $interopLoadedBeforeDotSource -and -not $interopLoadedByDotSource) -Message 'Dot-sourcing the adapter must not compile interop or create native resources.'
  $pwshPath = Join-Path $PSHOME 'pwsh.exe'
  if (-not [IO.File]::Exists($pwshPath)) { throw 'The current PowerShell host executable was not found.' }
  $explicitEnvironment = Get-ExplicitTestEnvironment

  $outsiderScript = New-TestScript -Name 'outsider.ps1' -Content @'
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'outsider-ready.txt'), [string]$PID)
Start-Sleep -Seconds 120
'@
  $outsider = Start-OwnedPowerShellProcess -Role outsider -ScriptPath $outsiderScript
  Wait-ForCondition -Condition { [IO.File]::Exists((Join-Path $scratch 'outsider-ready.txt')) } -TimeoutMs 10000 -Label 'synthetic outsider startup'
  $observations.Add([pscustomobject]@{
    role = 'outsider'
    processId = [int]$outsider.Id
    launcherProcessId = [int]$PID
    state = 'running'
    image = 'pwsh.exe'
  })
  $checks.syntheticOutsiderStarted = $true

  $resumeMarker = Join-Path $scratch 'resumed-marker.txt'
  $resumeRootScript = New-TestScript -Name 'resume-root.ps1' -Content (
    'if ($args.Count -ne 1 -or $args[0] -cne ' + (ConvertTo-PowerShellLiteral $argvSentinel) + ' -or $env:MORROW_188_UNICODE_SENTINEL -cne ''explicit-λ-東京'' -or $null -ne $env:MORROW_188_PARENT_SENTINEL) { exit 73 }' + [Environment]::NewLine +
    '[IO.File]::WriteAllText(' + (ConvertTo-PowerShellLiteral $resumeMarker) + ', ''root-ran'')' + [Environment]::NewLine +
    'Start-Sleep -Seconds 120'
  )
  $resumeSession = Start-RootSession -ScriptPath $resumeRootScript
  $resumeObservation = $resumeSession.ObserveRoot()
  Assert-InitialSuspendedObservation -Observation $resumeObservation
  $resumeRootProcess = Open-ObservedProcess -Observation $resumeObservation
  $resumeMembers = @($resumeSession.ListMemberIds())
  Assert-Check -Name 'createObserveResumeStop' -Condition ($resumeMembers -contains [uint32]$resumeObservation.processId) -Message 'The root PID must appear in the Job membership query before Resume.'
  $resumeResult = $resumeSession.Resume()
  Assert-Check -Name 'createObserveResumeStop' -Condition ([bool]$resumeResult.resumed -and [int]$resumeResult.previousSuspendCount -eq 1 -and $resumeResult.state -ceq 'resume-requested') -Message 'Resume must consume exactly the initial suspend count and report only a resume request.'
  Wait-ForCondition -Condition { [IO.File]::Exists($resumeMarker) } -TimeoutMs 10000 -Label 'resumed synthetic root marker'
  Assert-Check -Name 'explicitArgvAndUnicodeEnvironmentChecked' -Condition ([IO.File]::ReadAllText($resumeMarker) -ceq 'root-ran') -Message 'The child must receive the explicit argv and Unicode environment without the caller sentinel.'
  Assert-Check -Name 'createObserveResumeStop' -Condition (-not $resumeRootProcess.HasExited) -Message 'The synthetic root should remain alive before StopAndWait.'
  Assert-OutsiderAlive
  Close-ObservedProcess -Process $resumeRootProcess
  $stopResult = $resumeSession.StopAndWait(10000)
  Assert-Check -Name 'createObserveResumeStop' -Condition ([bool]$stopResult.jobEmpty -and @($stopResult.remainingMemberIds).Count -eq 0 -and [bool]$stopResult.rootExited -and $null -ne $stopResult.rootExitCode) -Message 'StopAndWait must report a numerically observed root exit and an empty private Job.'
  $afterStopObservation = $resumeSession.ObserveRoot()
  Assert-Check -Name 'rootExitObserved' -Condition ($afterStopObservation.state -ceq 'exited' -and $null -ne $afterStopObservation.exitCode -and [uint32]$afterStopObservation.exitCode -eq [uint32]$stopResult.rootExitCode) -Message 'Exit code must come from the retained process handle only after it signals.'
  $observations.Add([pscustomobject]@{
    role = 'resumed-root-after-stop'
    processId = [int]$afterStopObservation.processId
    state = [string]$afterStopObservation.state
    exitCode = [uint32]$afterStopObservation.exitCode
    jobEmpty = [bool]$stopResult.jobEmpty
  })
  Assert-OutsiderAlive
  $resumeSession.Dispose()
  [void]$disposedSessions.Add($resumeSession)
  $checks.outsiderPreserved = $true

  $grandchildReadyPath = Join-Path $scratch 'grandchild-ready.json'
  $grandchildBody = @'
$identity = [ordered]@{ processId = $PID; creationTimeUtc = [Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToString('o') }
[IO.File]::WriteAllText(__READY_PATH__, ($identity | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
Start-Sleep -Seconds 120
'@
  $grandchildBody = $grandchildBody.Replace('__READY_PATH__', (ConvertTo-PowerShellLiteral $grandchildReadyPath))
  $grandchildScript = New-TestScript -Name 'grandchild.ps1' -Content $grandchildBody
  $spawnRootBody = @'
if ($args.Count -ne 1 -or $args[0] -cne __ARGV_SENTINEL__ -or $env:MORROW_188_UNICODE_SENTINEL -cne 'explicit-λ-東京' -or $null -ne $env:MORROW_188_PARENT_SENTINEL) { exit 73 }
$info = [Diagnostics.ProcessStartInfo]::new(__PWSH_PATH__)
foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', __GRANDCHILD_PATH__)) { [void]$info.ArgumentList.Add($argument) }
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$child = [Diagnostics.Process]::Start($info)
if ($null -eq $child) { throw 'Synthetic grandchild did not start.' }
$child.Dispose()
'@
  $spawnRootBody = $spawnRootBody.Replace('__ARGV_SENTINEL__', (ConvertTo-PowerShellLiteral $argvSentinel)).Replace('__PWSH_PATH__', (ConvertTo-PowerShellLiteral $pwshPath)).Replace('__GRANDCHILD_PATH__', (ConvertTo-PowerShellLiteral $grandchildScript))
  $spawnRootScript = New-TestScript -Name 'spawn-root.ps1' -Content $spawnRootBody
  $spawnSession = Start-RootSession -ScriptPath $spawnRootScript
  $spawnObservation = $spawnSession.ObserveRoot()
  Assert-InitialSuspendedObservation -Observation $spawnObservation
  $spawnRootProcess = Open-ObservedProcess -Observation $spawnObservation
  [void]$spawnSession.Resume()
  Wait-ForCondition -Condition { [IO.File]::Exists($grandchildReadyPath) } -TimeoutMs 10000 -Label 'synthetic grandchild startup'
  if (-not $spawnRootProcess.WaitForExit(10000)) { throw 'The synthetic root did not exit while leaving its grandchild alive.' }
  $spawnRootExit = $spawnSession.ObserveRoot()
  if ($spawnRootExit.state -cne 'exited' -or $null -eq $spawnRootExit.exitCode) { throw 'The naturally exited root did not yield a handle-observed exit code.' }
  $observations.Add([pscustomobject]@{
    role = 'root-before-grandchild-cleanup'
    processId = [int]$spawnRootExit.processId
    state = [string]$spawnRootExit.state
    exitCode = [uint32]$spawnRootExit.exitCode
    jobMemberIdsReadAfterRootExit = $true
  })
  Close-ObservedProcess -Process $spawnRootProcess
  $grandchildIdentity = Get-Content -LiteralPath $grandchildReadyPath -Raw | ConvertFrom-Json
  $grandchildProcess = [Diagnostics.Process]::GetProcessById([int]$grandchildIdentity.processId)
  [void]$observedProcesses.Add($grandchildProcess)
  $actualGrandchildPath = [string]$grandchildProcess.MainModule.FileName
  $grandchildCreation = $grandchildProcess.StartTime.ToUniversalTime()
  $expectedGrandchildCreation = [DateTime]::Parse(
    [string]$grandchildIdentity.creationTimeUtc,
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::RoundtripKind
  ).ToUniversalTime()
  if (-not [string]::Equals($actualGrandchildPath, $pwshPath, [StringComparison]::OrdinalIgnoreCase) -or
      [Math]::Abs(($grandchildCreation - $expectedGrandchildCreation).TotalSeconds) -gt 2) {
    throw 'The synthetic grandchild handle did not match its readiness record.'
  }
  $grandchildEvidence = [pscustomobject]@{
    role = 'grandchild'
    processId = [int]$grandchildIdentity.processId
    creationTimeUtc = [string]$grandchildIdentity.creationTimeUtc
    image = [IO.Path]::GetFileName($actualGrandchildPath)
    state = 'running'
    jobMemberAfterRootExit = $false
    exitedAfterStop = $false
  }
  [void]$observations.Add($grandchildEvidence)
  $spawnMembers = @($spawnSession.ListMemberIds())
  Assert-Check -Name 'descendantSurvivesRootAndIsJobMember' -Condition (
    [int]$spawnObservation.processId -notin $spawnMembers -and
    [uint32]$grandchildIdentity.processId -in $spawnMembers -and
    -not $grandchildProcess.HasExited
  ) -Message 'After the root exits, its live grandchild must remain observable in the private Job.'
  $grandchildEvidence.jobMemberAfterRootExit = [uint32]$grandchildIdentity.processId -in $spawnMembers
  Assert-OutsiderAlive
  Close-ObservedProcess -Process $grandchildProcess
  $spawnStopResult = $spawnSession.StopAndWait(10000)
  Assert-Check -Name 'descendantStoppedWithJob' -Condition (
    [bool]$spawnStopResult.jobEmpty -and
    @($spawnStopResult.remainingMemberIds).Count -eq 0
  ) -Message 'Stopping the private Job must empty it and stop the exact observed synthetic grandchild.'
  Wait-ForCondition -Condition {
    -not (Test-ObservedIdentityAlive -ProcessId ([int]$grandchildIdentity.processId) -ExecutablePath $pwshPath -CreationTimeUtc ([string]$grandchildIdentity.creationTimeUtc))
  } -TimeoutMs 10000 -Label 'synthetic grandchild termination after Job cleanup'
  $grandchildEvidence.state = 'exited'
  $grandchildEvidence.exitedAfterStop = $true
  Assert-OutsiderAlive
  $spawnSession.Dispose()
  [void]$disposedSessions.Add($spawnSession)

  $disposeMarker = Join-Path $scratch 'disposed-marker.txt'
  $disposeScript = New-TestScript -Name 'dispose-root.ps1' -Content (
    'if ($args.Count -ne 1 -or $args[0] -cne ' + (ConvertTo-PowerShellLiteral $argvSentinel) + ' -or $env:MORROW_188_UNICODE_SENTINEL -cne ''explicit-λ-東京'' -or $null -ne $env:MORROW_188_PARENT_SENTINEL) { exit 73 }' + [Environment]::NewLine +
    '[IO.File]::WriteAllText(' + (ConvertTo-PowerShellLiteral $disposeMarker) + ', ''must-not-run'')'
  )
  $disposeSession = Start-RootSession -ScriptPath $disposeScript
  $disposeObservation = $disposeSession.ObserveRoot()
  Assert-InitialSuspendedObservation -Observation $disposeObservation
  $disposeRootProcess = Open-ObservedProcess -Observation $disposeObservation
  $disposeSession.Dispose()
  $disposeSession.Dispose()
  [void]$disposedSessions.Add($disposeSession)
  Assert-Check -Name 'disposeIsIdempotentAndStopsSuspendedRoot' -Condition (
    $disposeRootProcess.WaitForExit(10000) -and -not [IO.File]::Exists($disposeMarker)
  ) -Message 'Dispose must be idempotent and close its Job so an unresumed root exits without running.'
  $observations.Add([pscustomobject]@{
    role = 'disposed-root'
    processId = [int]$disposeObservation.processId
    state = 'exited'
    exitCode = [int64]$disposeRootProcess.ExitCode
    markerWritten = [IO.File]::Exists($disposeMarker)
  })
  Assert-Throws -Name 'disposed session refuses later observation' -Action { $disposeSession.ObserveRoot() }
  Assert-OutsiderAlive

  $neverRunMarker = Join-Path $scratch 'invalid-executable-marker.txt'
  $missingExecutable = Join-Path $scratch 'missing-synthetic-pwsh.exe'
  Assert-Throws -Name 'invalid executable path' -Action {
    CreateAtomicSuspendedRoot `
      -ExecutablePath $missingExecutable `
      -ArgumentList @('-NoProfile', '-Command', '[IO.File]::WriteAllText(' + (ConvertTo-PowerShellLiteral $neverRunMarker) + ', ''unexpected'')') `
      -Environment $explicitEnvironment `
      -WorkingDirectory $scratch
  }
  Assert-Check -Name 'creationErrorFailsClosed' -Condition (-not [IO.File]::Exists($neverRunMarker)) -Message 'A failed CreateProcessW must not leave a synthetic child able to write its marker.'
  Assert-OutsiderAlive

  $crashMarker = Join-Path $scratch 'consumer-crash-marker.txt'
  $handshakePath = Join-Path $scratch 'consumer-handshake.json'
  $releasePath = Join-Path $scratch 'consumer-release.signal'
  $crashRootScript = New-TestScript -Name 'consumer-crash-root.ps1' -Content (
    'if ($args.Count -ne 1 -or $args[0] -cne ' + (ConvertTo-PowerShellLiteral $argvSentinel) + ' -or $env:MORROW_188_UNICODE_SENTINEL -cne ''explicit-λ-東京'' -or $null -ne $env:MORROW_188_PARENT_SENTINEL) { exit 73 }' + [Environment]::NewLine +
    '[IO.File]::WriteAllText(' + (ConvertTo-PowerShellLiteral $crashMarker) + ', ''must-not-run'')' + [Environment]::NewLine +
    'Start-Sleep -Seconds 120'
  )
  $consumerScriptBody = @'
param([string] $AdapterPath, [string] $ChildScriptPath, [string] $WorkingDirectory, [string] $HandshakePath, [string] $ReleasePath)
$ErrorActionPreference = 'Stop'
. $AdapterPath
$names = @('SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramData', 'PSModulePath', 'DOTNET_ROOT')
$explicit = @{}
foreach ($name in $names) { $value = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::Process); if ($null -ne $value) { $explicit[$name] = [string]$value } }
$explicit['MORROW_188_UNICODE_SENTINEL'] = 'explicit-λ-東京'
$session = CreateAtomicSuspendedRoot -ExecutablePath (Join-Path $PSHOME 'pwsh.exe') -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $ChildScriptPath, 'issue 188 argument with spaces and trailing slash \') -Environment $explicit -WorkingDirectory $WorkingDirectory
$observation = $session.ObserveRoot()
if ($observation.state -cne 'suspended' -or -not $observation.isMember) { throw 'Creation barrier was reached without suspended Job membership.' }
[IO.File]::WriteAllText($HandshakePath, ($observation | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
while (-not [IO.File]::Exists($ReleasePath)) { Start-Sleep -Milliseconds 15 }
$session.Resume() | Out-Null
$session.Dispose()
'@
  $consumerScript = New-TestScript -Name 'consumer.ps1' -Content $consumerScriptBody
  $consumer = Start-OwnedPowerShellProcess -Role consumer -ScriptPath $consumerScript -ExtraArguments @($adapterPath, $crashRootScript, $scratch, $handshakePath, $releasePath)
  Wait-ForCondition -Condition { [IO.File]::Exists($handshakePath) } -TimeoutMs 10000 -Label 'consumer post-return pre-resume barrier'
  $barrierObservation = Get-Content -LiteralPath $handshakePath -Raw | ConvertFrom-Json
  Assert-Check -Name 'consumerDeathAfterReturnBeforeResume' -Condition (
    $barrierObservation.state -ceq 'suspended' -and
    [bool]$barrierObservation.isMember -and
    [bool]$barrierObservation.wasAssociatedAtCreation -and
    $null -eq $barrierObservation.parentProcessId
  ) -Message 'The consumer barrier must prove returned, confirmed Job membership, and pre-Resume suspension.'
  $observations.Add([pscustomobject]@{
    role = 'consumer-death-barrier-root'
    processId = [int]$barrierObservation.processId
    creatorProcessId = [int]$barrierObservation.creatorProcessId
    parentProcessId = $null
    creationTimeUtc = [string]$barrierObservation.creationTimeUtc
    image = [IO.Path]::GetFileName([string]$barrierObservation.executablePath)
    state = [string]$barrierObservation.state
    isMember = [bool]$barrierObservation.isMember
  })
  $barrierRootProcess = Open-ObservedProcess -Observation $barrierObservation
  if ($barrierRootProcess.HasExited) { throw 'The child exited before the consumer-death boundary.' }
  if ($consumer.HasExited) { throw 'The primitive consumer exited before the test killed its exact process handle.' }
  $consumer.Kill()
  if (-not $consumer.WaitForExit(10000)) { throw 'The exact consumer process did not terminate after Kill().' }
  if (-not $barrierRootProcess.WaitForExit(10000)) { throw 'Closing the consumer process did not terminate its suspended Job root.' }
  $observations.Add([pscustomobject]@{
    role = 'consumer-death-barrier-root-after-kill'
    processId = [int]$barrierObservation.processId
    state = 'exited'
    exitCode = [int64]$barrierRootProcess.ExitCode
    markerWritten = [IO.File]::Exists($crashMarker)
  })
  Assert-Check -Name 'consumerDeathAfterReturnBeforeResume' -Condition (-not [IO.File]::Exists($crashMarker)) -Message 'The suspended child must exit without executing its marker after its consumer dies.'
  Assert-OutsiderAlive

  $incompleteChecks = @($checks.Keys | Where-Object { -not [bool]$checks[$_] })
  if ($incompleteChecks.Count -gt 0) {
    throw ('Required own probes did not complete: ' + [string]::Join(', ', $incompleteChecks))
  }
  $outsiderAliveAtTestEnd = -not $outsider.HasExited

} catch {
  $failure = ConvertTo-SafeErrorMessage -Exception $_.Exception
} finally {
  foreach ($session in $sessions) {
    if (-not $disposedSessions.Contains($session)) {
      try {
        $cleanup = $session.StopAndWait(5000)
        if (-not $cleanup.jobEmpty) { [void]$cleanupErrors.Add('A private Job still had members after cleanup timeout.') }
      } catch {
        [void]$cleanupErrors.Add((ConvertTo-SafeErrorMessage -Exception $_.Exception))
      }
      try { $session.Dispose() } catch { [void]$cleanupErrors.Add((ConvertTo-SafeErrorMessage -Exception $_.Exception)) }
    }
  }

  foreach ($process in $ownedProcesses) {
    try {
      if (-not $process.HasExited) {
        $process.Kill()
        if (-not $process.WaitForExit(5000)) { [void]$cleanupErrors.Add('An exact synthetic helper process did not exit after cleanup.') }
      }
    } catch {
      [void]$cleanupErrors.Add((ConvertTo-SafeErrorMessage -Exception $_.Exception))
    }
    foreach ($helper in $helperOutput) {
      if ([int]$helper.processId -eq [int]$process.Id -and $process.HasExited) {
        try { $helper.exitCode = [int]$process.ExitCode } catch { }
      }
    }
    try { $process.Dispose() } catch { [void]$cleanupErrors.Add((ConvertTo-SafeErrorMessage -Exception $_.Exception)) }
  }

  foreach ($process in $observedProcesses) {
    try {
      if (-not $process.HasExited -and -not $process.WaitForExit(5000)) {
        [void]$cleanupErrors.Add('An observed Job member remained active after the owning Job cleanup.')
      }
    } catch {
      [void]$cleanupErrors.Add((ConvertTo-SafeErrorMessage -Exception $_.Exception))
    }
    try { $process.Dispose() } catch { [void]$cleanupErrors.Add((ConvertTo-SafeErrorMessage -Exception $_.Exception)) }
  }

  if ($cleanupErrors.Count -gt 0 -and $null -eq $failure) {
    $failure = 'Cleanup did not fully complete.'
  }

  if ($parentSentinelChanged) {
    try { [Environment]::SetEnvironmentVariable($parentSentinelName, $parentSentinelBefore, [EnvironmentVariableTarget]::Process) } catch {
      [void]$cleanupErrors.Add('The test process environment sentinel could not be restored.')
      if ($null -eq $failure) { $failure = 'The test process environment sentinel could not be restored.' }
    }
  }

  $helperEvidence = [Collections.Generic.List[object]]::new()
  foreach ($helper in $helperOutput) {
    $stdoutText = ''
    $stderrText = ''
    try {
      if (-not $helper.stdoutTask.IsCompleted) { throw 'Synthetic helper stdout was not drained before evidence capture.' }
      $stdoutText = ConvertTo-SafeLogText -Text ([string]$helper.stdoutTask.GetAwaiter().GetResult())
      if (-not $helper.stderrTask.IsCompleted) { throw 'Synthetic helper stderr was not drained before evidence capture.' }
      $stderrText = ConvertTo-SafeLogText -Text ([string]$helper.stderrTask.GetAwaiter().GetResult())
    } catch {
      [void]$cleanupErrors.Add((ConvertTo-SafeErrorMessage -Exception $_.Exception))
      if ($null -eq $failure) { $failure = 'Synthetic helper output could not be retained.' }
    }
    $stdoutName = 'helper-' + [string]$helper.role + '-' + [string]$helper.processId + '.stdout.log'
    $stderrName = 'helper-' + [string]$helper.role + '-' + [string]$helper.processId + '.stderr.log'
    if ($evidenceCreated) {
      try {
        Write-Utf8File -Path (Join-Path $evidenceFullPath $stdoutName) -Content $stdoutText
        Write-Utf8File -Path (Join-Path $evidenceFullPath $stderrName) -Content $stderrText
      } catch {
        [void]$cleanupErrors.Add((ConvertTo-SafeErrorMessage -Exception $_.Exception))
        if ($null -eq $failure) { $failure = 'Synthetic helper logs could not be persisted.' }
      }
    }
    $stdoutHash = $null
    $stderrHash = $null
    if ($evidenceCreated) {
      try { $stdoutHash = (Get-FileHash -LiteralPath (Join-Path $evidenceFullPath $stdoutName) -Algorithm SHA256).Hash.ToLowerInvariant() } catch { }
      try { $stderrHash = (Get-FileHash -LiteralPath (Join-Path $evidenceFullPath $stderrName) -Algorithm SHA256).Hash.ToLowerInvariant() } catch { }
    }
    [void]$helperEvidence.Add([pscustomobject]@{
      role = [string]$helper.role
      processId = [int]$helper.processId
      exitCode = $helper.exitCode
      stdoutFile = $stdoutName
      stdoutSha256 = $stdoutHash
      stderrFile = $stderrName
      stderrSha256 = $stderrHash
    })
  }

  if ($cleanupErrors.Count -gt 0 -and $null -eq $failure) {
    $failure = 'Cleanup did not fully complete.'
  }

  if ($evidenceCreated -and [IO.Directory]::Exists([string]$scratch)) {
    try {
      $ownerMatches = [IO.File]::Exists([string]$ownerMarkerPath) -and [IO.File]::ReadAllText([string]$ownerMarkerPath) -ceq $runId
      $relativeScratch = [IO.Path]::GetRelativePath([string]$evidenceFullPath, [string]$scratch)
      if (-not $ownerMatches -or $relativeScratch -eq '.' -or [IO.Path]::IsPathRooted($relativeScratch) -or
          $relativeScratch -eq '..' -or $relativeScratch.StartsWith('..' + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Scratch ownership could not be proven; generated test files were retained.'
      }
      [IO.Directory]::Delete([string]$scratch, $true)
    } catch {
      [void]$cleanupErrors.Add((ConvertTo-SafeErrorMessage -Exception $_.Exception))
      if ($null -eq $failure) { $failure = 'Generated synthetic scratch files could not be removed.' }
    }
  }

  if ($cleanupErrors.Count -gt 0 -and $null -eq $failure) {
    $failure = 'Cleanup did not fully complete.'
  }

  $adapterHash = $null
  $testHash = $null
  try { $adapterHash = (Get-FileHash -LiteralPath $adapterPath -Algorithm SHA256).Hash.ToLowerInvariant() } catch { }
  try { $testHash = (Get-FileHash -LiteralPath $MyInvocation.MyCommand.Path -Algorithm SHA256).Hash.ToLowerInvariant() } catch { }
  $receipt = [ordered]@{
    schemaVersion = 1
    scope = 'issue-188 native JobObject primitive own Windows probes'
    status = if ($null -eq $failure) { 'passed' } else { 'failed' }
    runId = $runId
    githubRunId = [string]$env:GITHUB_RUN_ID
    githubRunAttempt = [string]$env:GITHUB_RUN_ATTEMPT
    githubSha = [string]$env:GITHUB_SHA
    os = [Environment]::OSVersion.VersionString
    powershell = $PSVersionTable.PSVersion.ToString()
    processArchitecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
    adapterSha256 = $adapterHash
    ownTestSha256 = $testHash
    expectedCommand = 'pwsh -NoProfile -File scripts/pilot/windows-native-job.own.test.ps1 -EvidenceRoot <new child of RUNNER_TEMP>'
    checks = $checks
    observations = @($observations)
    helperProcesses = @($helperEvidence)
    outsiderAliveAtTestEnd = $outsiderAliveAtTestEnd
    appLaunched = $false
    tauriDriverStarted = $false
    edgeLaunched = $false
    webViewLaunched = $false
    guiOpened = $false
    failure = $failure
    cleanupErrors = @($cleanupErrors)
  }

  $receiptJson = ConvertTo-Json -InputObject $receipt -Depth 8 -Compress
  if ($evidenceCreated) {
    try { Write-Utf8File -Path (Join-Path $evidenceFullPath 'receipt.json') -Content $receiptJson } catch {
      $failure = 'Could not persist receipt.json.'
      $receipt.failure = 'Could not persist receipt.json.'
      $receipt.status = 'failed'
      $receiptJson = ConvertTo-Json -InputObject $receipt -Depth 8 -Compress
    }
  }
  [Console]::Out.WriteLine($receiptJson)
}

if ($null -ne $failure) { exit 1 }
exit 0
