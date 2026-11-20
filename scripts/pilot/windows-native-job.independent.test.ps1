[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateNotNullOrEmpty()]
  [string] $EvidenceRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:Checks = [ordered]@{}
$script:Failures = [Collections.Generic.List[string]]::new()
$script:Observations = [Collections.Generic.List[object]]::new()
$script:TrackedProcesses = [Collections.Generic.List[object]]::new()
$script:Sessions = [Collections.Generic.List[object]]::new()
$script:CleanupNotes = [Collections.Generic.List[string]]::new()
$script:Metadata = [ordered]@{}
$script:EvidenceRootFull = $null
$script:RunnerTempFull = $null
$script:AdapterPath = $null
$script:PwshInstallDirectory = $null
$script:PwshPath = $null
$script:FixturePath = $null
$script:FixtureSha256 = $null
$script:ConsumerFixtureSha256 = $null
$script:TestSha256 = $null
$script:AdapterSha256 = $null
$script:RunStartedUtc = [DateTime]::UtcNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
$script:Utf8NoBom = [Text.UTF8Encoding]::new($false)
$script:ParentOnlyKey = 'MORROW_188_PARENT_ONLY_' + [Guid]::NewGuid().ToString('N').ToUpperInvariant()
$script:ParentOnlyValue = [Guid]::NewGuid().ToString('N')
$script:ExpectedUnicodeValue = 'issue188-' + [Guid]::NewGuid().ToString('N') + '-á漢'
$script:EmergencyCleanupUsed = $false
$script:OutstandingProcessIds = [Collections.Generic.List[uint32]]::new()
$script:Outsider = $null
$script:OutsiderReadyPath = $null
$script:OutsiderReleasePath = $null
$script:ReceiptPath = $null
$script:ProcessImageQueryMethod = $null

function Get-SafeMessage {
  param([Parameter(Mandatory)][Exception] $Exception)

  $message = [string]$Exception.Message
  foreach ($sensitivePath in @($script:EvidenceRootFull, $script:RunnerTempFull, $script:AdapterPath, $script:PwshPath, $env:USERPROFILE)) {
    if (-not [string]::IsNullOrWhiteSpace([string]$sensitivePath)) {
      $message = [regex]::Replace(
        $message,
        [regex]::Escape([string]$sensitivePath),
        '<PRIVATE_PATH>',
        [Text.RegularExpressions.RegexOptions]::IgnoreCase
      )
    }
  }
  $message = [regex]::Replace(
    $message,
    '(?i)\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,})',
    '<REDACTED_SECRET>'
  )
  $message = [regex]::Replace($message, '[\r\n\t]+', ' ')
  $message = [regex]::Replace($message, '[^\x20-\x7E]', '?')
  $message = $message.Trim()
  if ($message.Length -gt 240) { $message = $message.Substring(0, 240) }
  return $message
}

function Assert-True {
  param(
    [Parameter(Mandatory)][bool] $Condition,
    [Parameter(Mandatory)][string] $Message
  )
  if (-not $Condition) { throw $Message }
}

function Assert-Equal {
  param(
    [Parameter(Mandatory)] $Actual,
    [Parameter(Mandatory)] $Expected,
    [Parameter(Mandatory)][string] $Message,
    [switch] $IgnoreCase
  )
  if ($Expected -is [string]) {
    $comparison = if ($IgnoreCase) {
      [string]::Compare([string]$Actual, [string]$Expected, [StringComparison]::OrdinalIgnoreCase)
    } else {
      [string]::CompareOrdinal([string]$Actual, [string]$Expected)
    }
    if ($comparison -ne 0) { throw $Message }
  } elseif ($Actual -ne $Expected) {
    throw $Message
  }
}

function Assert-ContainsId {
  param(
    [Parameter(Mandatory)][object[]] $Ids,
    [Parameter(Mandatory)][uint32] $ProcessId,
    [Parameter(Mandatory)][string] $Message
  )
  foreach ($id in $Ids) {
    if ([uint32]$id -eq $ProcessId) { return }
  }
  throw $Message
}

function Assert-DoesNotContainId {
  param(
    [Parameter(Mandatory)][object[]] $Ids,
    [Parameter(Mandatory)][uint32] $ProcessId,
    [Parameter(Mandatory)][string] $Message
  )
  foreach ($id in $Ids) {
    if ([uint32]$id -eq $ProcessId) { throw $Message }
  }
}

function Test-PathExists {
  param([Parameter(Mandatory)][string] $Path)
  return [IO.File]::Exists($Path) -or [IO.Directory]::Exists($Path)
}

function Assert-NoReparseSegments {
  param(
    [Parameter(Mandatory)][string] $Path,
    [Parameter(Mandatory)][string] $Root
  )

  $fullPath = [IO.Path]::GetFullPath($Path)
  $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/'))
  $prefix = $fullRoot + [IO.Path]::DirectorySeparatorChar
  if (-not $fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Evidence paths must remain below RUNNER_TEMP.'
  }

  $relative = $fullPath.Substring($prefix.Length)
  $current = $fullRoot
  foreach ($segment in $relative.Split([char[]]@('\', '/'), [StringSplitOptions]::RemoveEmptyEntries)) {
    $current = [IO.Path]::Combine($current, $segment)
    if (Test-PathExists -Path $current) {
      $attributes = [IO.File]::GetAttributes($current)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'An evidence path crosses a reparse point.'
      }
    }
  }
}

function Write-JsonAtomically {
  param(
    [Parameter(Mandatory)][string] $Path,
    [Parameter(Mandatory)] $Value
  )

  $json = ConvertTo-Json -InputObject $Value -Depth 12 -Compress
  $temporaryPath = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  [IO.File]::WriteAllText($temporaryPath, $json, $script:Utf8NoBom)
  [IO.File]::Move($temporaryPath, $Path)
}

function Read-JsonFile {
  param([Parameter(Mandatory)][string] $Path)
  return (ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Path)) -AsHashtable -Depth 12)
}

function Wait-ForFile {
  param(
    [Parameter(Mandatory)][string] $Path,
    [Parameter(Mandatory)][int] $TimeoutMs,
    [Parameter(Mandatory)][string] $Description
  )

  $watch = [Diagnostics.Stopwatch]::StartNew()
  while ($watch.ElapsedMilliseconds -lt $TimeoutMs) {
    if ([IO.File]::Exists($Path)) { return }
    Start-Sleep -Milliseconds 25
  }
  throw "Timed out waiting for $Description."
}

function New-CaseRoot {
  param([Parameter(Mandatory)][string] $Name)

  $directoryName = $Name + ' with spaces ' + [Guid]::NewGuid().ToString('N')
  $path = Join-Path $script:EvidenceRootFull (Join-Path 'cases' $directoryName)
  Assert-NoReparseSegments -Path $path -Root $script:RunnerTempFull
  [void][IO.Directory]::CreateDirectory($path)
  $ownerPath = Join-Path $path '.issue-188-independent-owner'
  [IO.File]::WriteAllText($ownerPath, [Guid]::NewGuid().ToString('N'), $script:Utf8NoBom)
  foreach ($child in @('temp', 'profile', 'profile\appdata', 'profile\local')) {
    [void][IO.Directory]::CreateDirectory((Join-Path $path $child))
  }
  return $path
}

function New-ExplicitEnvironment {
  param(
    [Parameter(Mandatory)][string] $CaseRoot,
    [Parameter(Mandatory)][string] $ExpectedValue
  )

  $systemRoot = [Environment]::GetEnvironmentVariable('SystemRoot', [EnvironmentVariableTarget]::Process)
  if ([string]::IsNullOrWhiteSpace($systemRoot)) {
    throw 'SystemRoot is required to create a Windows synthetic process.'
  }

  $map = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
  $values = [ordered]@{
    SystemRoot = $systemRoot
    windir = $systemRoot
    SystemDrive = [IO.Path]::GetPathRoot($systemRoot).TrimEnd([char]'\')
    PATH = (Join-Path $systemRoot 'System32') + ';' + $script:PwshInstallDirectory
    TEMP = (Join-Path $CaseRoot 'temp')
    TMP = (Join-Path $CaseRoot 'temp')
    USERPROFILE = (Join-Path $CaseRoot 'profile')
    HOME = (Join-Path $CaseRoot 'profile')
    APPDATA = (Join-Path (Join-Path $CaseRoot 'profile') 'appdata')
    LOCALAPPDATA = (Join-Path (Join-Path $CaseRoot 'profile') 'local')
    PSHOME = $script:PwshInstallDirectory
    PSModulePath = (Join-Path $script:PwshInstallDirectory 'Modules')
    ComSpec = (Join-Path $systemRoot 'System32\cmd.exe')
    RUNNER_TEMP = $script:RunnerTempFull
    MORROW_188_PWSH_PATH = $script:PwshPath
    MORROW_188_EXPECTED_UNICODE = $ExpectedValue
    MORROW_188_CHILD_UNICODE = $ExpectedValue
  }
  foreach ($key in $values.Keys) {
    $map.Add([string]$key, [string]$values[$key])
  }
  return $map
}

function New-TrackedProcessInfo {
  param(
    [Parameter(Mandatory)][string] $ExecutablePath,
    [Parameter(Mandatory)][string[]] $ArgumentList,
    [Parameter(Mandatory)][System.Collections.IDictionary] $Environment,
    [Parameter(Mandatory)][string] $WorkingDirectory
  )

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $ExecutablePath
  $startInfo.WorkingDirectory = $WorkingDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  foreach ($argument in $ArgumentList) {
    [void]$startInfo.ArgumentList.Add([string]$argument)
  }
  $startInfo.Environment.Clear()
  foreach ($key in $Environment.Keys) {
    $startInfo.Environment[[string]$key] = [string]$Environment[$key]
  }
  return $startInfo
}

function Initialize-ProcessImageQuery {
  if ($null -ne $script:ProcessImageQueryMethod) { return }

  $typeName = 'MorrowIssue188IndependentProcessImageNative'
  $apiType = $typeName -as [type]
  if ($null -eq $apiType) {
    $source = @'
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class MorrowIssue188IndependentProcessImageNative
{
  public static string GetFullImagePath(SafeHandle processHandle)
  {
    if (processHandle == null)
      throw new System.ArgumentNullException(nameof(processHandle));

    var path = new StringBuilder(32768);
    uint charactersWritten = (uint)path.Capacity;
    if (!QueryFullProcessImageNameW(processHandle, 0, path, ref charactersWritten))
      throw new Win32Exception(Marshal.GetLastWin32Error(), "QueryFullProcessImageNameW failed for the retained process handle.");
    if (charactersWritten == 0 || charactersWritten > (uint)path.Capacity)
      throw new System.InvalidOperationException("QueryFullProcessImageNameW returned an invalid path length.");

    return path.ToString(0, (int)charactersWritten);
  }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true, EntryPoint = "QueryFullProcessImageNameW")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool QueryFullProcessImageNameW(
    SafeHandle hProcess,
    uint dwFlags,
    StringBuilder lpExeName,
    ref uint lpdwSize);
}
'@
    $apiType = Add-Type -TypeDefinition $source -Language CSharp -PassThru -ErrorAction Stop
  }

  $script:ProcessImageQueryMethod = $apiType.GetMethod(
    'GetFullImagePath',
    [Reflection.BindingFlags]::Public -bor [Reflection.BindingFlags]::Static
  )
  if ($null -eq $script:ProcessImageQueryMethod) {
    throw 'The independent process-image helper did not expose its query method.'
  }
}

function Get-TrackedProcessImagePath {
  param([Parameter(Mandatory)][object] $ProcessHandle)

  if (-not ($ProcessHandle -is [Runtime.InteropServices.SafeHandle])) {
    throw 'The retained Diagnostics.Process.SafeHandle is not valid for image-path verification.'
  }
  if ($ProcessHandle.IsClosed -or $ProcessHandle.IsInvalid) {
    throw 'The retained Diagnostics.Process.SafeHandle is not valid for image-path verification.'
  }

  $imagePath = [string]$script:ProcessImageQueryMethod.Invoke($null, [object[]]@($ProcessHandle))
  if ([string]::IsNullOrWhiteSpace($imagePath)) {
    throw 'QueryFullProcessImageNameW returned an empty image path for a retained process handle.'
  }
  return [IO.Path]::GetFullPath($imagePath)
}

function Add-TrackedProcess {
  param(
    [Parameter(Mandatory)][Diagnostics.Process] $Process,
    [Parameter(Mandatory)][string] $Role
  )

  $record = [pscustomobject]@{
    role = $Role
    process = $Process
    processHandle = $null
    processId = $null
    creationTimeUtc = $null
    imagePath = $null
    exitCode = $null
    emergencyCleanup = $false
  }
  $script:TrackedProcesses.Add($record)

  $Process.Refresh()
  $record.processId = [uint32]$Process.Id
  $record.creationTimeUtc = $Process.StartTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)
  $record.processHandle = $Process.SafeHandle
  $record.imagePath = Get-TrackedProcessImagePath -ProcessHandle $record.processHandle
  return $record
}

function Start-TrackedProcess {
  param(
    [Parameter(Mandatory)][string] $ExecutablePath,
    [Parameter(Mandatory)][string[]] $ArgumentList,
    [Parameter(Mandatory)][System.Collections.IDictionary] $Environment,
    [Parameter(Mandatory)][string] $WorkingDirectory,
    [Parameter(Mandatory)][string] $Role
  )

  $startInfo = New-TrackedProcessInfo -ExecutablePath $ExecutablePath -ArgumentList $ArgumentList -Environment $Environment -WorkingDirectory $WorkingDirectory
  $process = [Diagnostics.Process]::Start($startInfo)
  if ($null -eq $process) { throw ('The {0} fixture process did not start.' -f $Role) }
  return (Add-TrackedProcess -Process $process -Role $Role)
}

function Open-TrackedProcessById {
  param(
    [Parameter(Mandatory)][uint32] $ProcessId,
    [Parameter(Mandatory)][string] $Role
  )

  $process = [Diagnostics.Process]::GetProcessById([int]$ProcessId)
  return (Add-TrackedProcess -Process $process -Role $Role)
}

function Assert-TrackedProcessMatches {
  param(
    [Parameter(Mandatory)][psobject] $Record,
    [Parameter(Mandatory)][uint32] $ExpectedId,
    [Parameter(Mandatory)][string] $ExpectedPath
  )

  Assert-Equal -Actual $Record.processId -Expected $ExpectedId -Message 'The retained process handle PID differed from the expected fixture PID.'
  Assert-Equal -Actual $Record.imagePath -Expected ([IO.Path]::GetFullPath($ExpectedPath)) -IgnoreCase -Message 'The retained process handle image path differed from the synthetic executable.'
  $created = [DateTime]::Parse(
    [string]$Record.creationTimeUtc,
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::RoundtripKind
  ).ToUniversalTime()
  Assert-True -Condition ($created -gt [DateTime]::UtcNow.AddMinutes(-30)) -Message 'A retained process handle has an implausible creation time.'
}

function Assert-CreationTimesMatch {
  param(
    [Parameter(Mandatory)][string] $ObservedUtc,
    [Parameter(Mandatory)][string] $HandleUtc
  )

  $observed = [DateTime]::Parse($ObservedUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
  $handle = [DateTime]::Parse($HandleUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
  Assert-True -Condition ([Math]::Abs(($observed - $handle).TotalSeconds) -lt 2) -Message 'The process handle referred to a different process generation.'
}

function Test-ProcessAlive {
  param([Parameter(Mandatory)][psobject] $Record)
  $Record.process.Refresh()
  return (-not $Record.process.HasExited)
}

function Wait-ForProcessExit {
  param(
    [Parameter(Mandatory)][psobject] $Record,
    [Parameter(Mandatory)][int] $TimeoutMs,
    [Parameter(Mandatory)][string] $Description
  )

  if (-not $Record.process.WaitForExit($TimeoutMs)) {
    throw "Timed out waiting for $Description to exit."
  }
  $Record.exitCode = [int64]$Record.process.ExitCode
}

function Test-IsObjectDisposedException {
  param([Parameter(Mandatory)][System.Management.Automation.ErrorRecord] $ErrorRecord)

  $exception = $ErrorRecord.Exception
  while ($null -ne $exception) {
    if ($exception -is [ObjectDisposedException]) { return $true }
    $exception = $exception.InnerException
  }
  return $false
}

function Get-FixtureArgumentList {
  param(
    [Parameter(Mandatory)][string] $Role,
    [Parameter(Mandatory)][string] $CaseRoot,
    [Parameter(Mandatory)][string] $Nonce
  )

  return [string[]]@(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-File',
    $script:FixturePath,
    $Role,
    $CaseRoot,
    $Nonce,
    $script:ParentOnlyKey
  )
}

function New-RootSession {
  param(
    [Parameter(Mandatory)][string] $CaseRoot,
    [Parameter(Mandatory)][string] $Role,
    [Parameter(Mandatory)][string] $Nonce
  )

  $environment = New-ExplicitEnvironment -CaseRoot $CaseRoot -ExpectedValue $script:ExpectedUnicodeValue
  $createArguments = @{
    ExecutablePath = $script:PwshPath
    ArgumentList = (Get-FixtureArgumentList -Role $Role -CaseRoot $CaseRoot -Nonce $Nonce)
    Environment = $environment
    WorkingDirectory = $CaseRoot
  }
  $session = CreateAtomicSuspendedRoot @createArguments
  $script:Sessions.Add($session)
  return [pscustomobject]@{
    session = $session
    environment = $environment
  }
}

function Assert-SuspendedRoot {
  param(
    [Parameter(Mandatory)][psobject] $Session,
    [Parameter(Mandatory)][uint32] $ExpectedCreatorProcessId
  )

  $observation = $Session.session.ObserveRoot()
  Assert-Equal -Actual ([string]$observation.state) -Expected 'suspended' -Message 'The newly created root was not still suspended.'
  Assert-Equal -Actual ([uint32]$observation.creatorProcessId) -Expected $ExpectedCreatorProcessId -Message 'The native creator PID did not match the consumer process.'
  Assert-True -Condition ($null -eq $observation.parentProcessId) -Message 'This primitive must leave parentProcessId unset for the later CIM facade.'
  Assert-True -Condition ([uint32]$observation.processId -gt 0) -Message 'The root process ID was not observed.'
  Assert-True -Condition ([bool]$observation.isMember) -Message 'The suspended root was not observed in its private Job.'
  Assert-True -Condition ([bool]$observation.wasAssociatedAtCreation) -Message 'The root was not marked as associated at creation.'
  Assert-Equal -Actual ([uint32]$observation.jobLimitFlags) -Expected ([uint32]0x2000) -Message 'The private Job did not have exactly KILL_ON_JOB_CLOSE.'
  Assert-True -Condition (-not [bool]$observation.jobHandleInheritable) -Message 'The private Job handle was inheritable.'
  Assert-True -Condition (-not [string]::IsNullOrWhiteSpace([string]$observation.executablePath)) -Message 'The root image path was not observed from its process handle.'
  Assert-Equal -Actual ([string]$observation.executablePath) -Expected $script:PwshPath -IgnoreCase -Message 'The root image path did not match the synthetic PowerShell executable.'
  $created = [DateTime]::Parse(
    [string]$observation.creationTimeUtc,
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::RoundtripKind
  ).ToUniversalTime()
  Assert-True -Condition ($created -gt [DateTime]::UtcNow.AddMinutes(-30)) -Message 'The root creation time was not a recent observed value.'

  $members = @($Session.session.ListMemberIds() | ForEach-Object { [uint32]$_ })
  Assert-ContainsId -Ids $members -ProcessId ([uint32]$observation.processId) -Message 'The suspended root was absent from the private Job member list.'
  $script:Observations.Add([ordered]@{
    phase = 'created-suspended'
    processId = [uint32]$observation.processId
    creatorProcessId = [uint32]$observation.creatorProcessId
    creationTimeUtc = [string]$observation.creationTimeUtc
    memberIds = $members
    isMember = [bool]$observation.isMember
    wasAssociatedAtCreation = [bool]$observation.wasAssociatedAtCreation
    jobLimitFlags = [uint32]$observation.jobLimitFlags
    jobHandleInheritable = [bool]$observation.jobHandleInheritable
  })
  return [pscustomobject]@{
    observation = $observation
    memberIds = $members
  }
}

function Close-TrackedProcess {
  param(
    [Parameter(Mandatory)][psobject] $Record,
    [Parameter(Mandatory)][bool] $IsOutsider
  )

  if (Test-ProcessAlive -Record $Record) {
    if ($IsOutsider -and $null -ne $script:OutsiderReleasePath) {
      try {
        Write-JsonAtomically -Path $script:OutsiderReleasePath -Value ([ordered]@{ release = $true })
      } catch { }
      if ($Record.process.WaitForExit(3000)) {
        $Record.exitCode = [int64]$Record.process.ExitCode
      }
    }
  }

  if (Test-ProcessAlive -Record $Record) {
    $script:EmergencyCleanupUsed = $true
    $Record.emergencyCleanup = $true
    try {
      $Record.process.Kill()
      if ($Record.process.WaitForExit(5000)) {
        $Record.exitCode = [int64]$Record.process.ExitCode
        $script:Failures.Add(('Emergency cleanup was required for the exact retained {0} handle.' -f $Record.role))
      } else {
        $script:OutstandingProcessIds.Add([uint32]$Record.processId)
        $script:Failures.Add(('Emergency cleanup could not stop exact fixture PID {0}.' -f $Record.processId))
      }
    } catch {
      $script:OutstandingProcessIds.Add([uint32]$Record.processId)
      $script:Failures.Add(('Emergency cleanup failed for the exact retained {0} handle.' -f $Record.role))
    }
  }
}

function Close-ScenarioResources {
  param(
    [Parameter(Mandatory)][int] $SessionStart,
    [Parameter(Mandatory)][int] $ProcessStart
  )

  for ($index = $SessionStart; $index -lt $script:Sessions.Count; $index++) {
    $session = $script:Sessions[$index]
    try {
      $cleanup = $session.StopAndWait(5000)
      if (-not [bool]$cleanup.jobEmpty) {
        $script:Failures.Add('A private Job did not empty during scenario cleanup.')
      }
    } catch {
      if (-not (Test-IsObjectDisposedException -ErrorRecord $_)) {
        $script:Failures.Add('StopAndWait failed during scenario cleanup before proving the Job empty.')
      }
      try { $session.Dispose() } catch {
        $script:Failures.Add('A private Job could not be disposed during scenario cleanup.')
      }
    }
  }

  for ($index = $ProcessStart; $index -lt $script:TrackedProcesses.Count; $index++) {
    $record = $script:TrackedProcesses[$index]
    if ([string]$record.role -ne 'outsider') {
      Close-TrackedProcess -Record $record -IsOutsider $false
    }
  }

  for ($index = $SessionStart; $index -lt $script:Sessions.Count; $index++) {
    try { $script:Sessions[$index].Dispose() } catch { }
  }
}

function Invoke-Scenario {
  param(
    [Parameter(Mandatory)][string] $Name,
    [Parameter(Mandatory)][scriptblock] $Action
  )

  $sessionStart = $script:Sessions.Count
  $processStart = $script:TrackedProcesses.Count
  $scenarioFailed = $false
  $scenarioMessage = $null
  try {
    & $Action | Out-Null
  } catch {
    $scenarioFailed = $true
    $scenarioMessage = Get-SafeMessage -Exception $_.Exception
  } finally {
    $failureCountBeforeCleanup = $script:Failures.Count
    Close-ScenarioResources -SessionStart $sessionStart -ProcessStart $processStart
    if ($script:Failures.Count -gt $failureCountBeforeCleanup) {
      $scenarioFailed = $true
      if ([string]::IsNullOrWhiteSpace($scenarioMessage)) { $scenarioMessage = 'Scenario cleanup required a forced fallback or did not prove empty state.' }
    }
  }

  if ($scenarioFailed) {
    $script:Checks[$Name] = [ordered]@{ status = 'failed'; message = $scenarioMessage }
    $message = if ([string]::IsNullOrWhiteSpace($scenarioMessage)) { 'Scenario failed.' } else { $scenarioMessage }
    $script:Failures.Add(('{0}: {1}' -f $Name, $message))
    [Console]::Error.WriteLine(('FAIL {0}: {1}' -f $Name, $message))
  } else {
    $script:Checks[$Name] = [ordered]@{ status = 'passed' }
  }
}

function Write-TestFixture {
  $fixture = @'
param(
  [Parameter(Position = 0)][ValidateSet('root-hold', 'root-exits-before-neto', 'neto-hold', 'leaf-hold', 'outsider-hold')][string] $Role,
  [Parameter(Position = 1)][string] $CaseRoot,
  [Parameter(Position = 2)][string] $Nonce,
  [Parameter(Position = 3)][string] $ParentOnlyKey
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-FixtureJson {
  param([string] $Path, $Value)
  $json = ConvertTo-Json -InputObject $Value -Depth 8 -Compress
  $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
  [IO.File]::Move($temporary, $Path)
}

function Wait-ForRelease {
  param([string] $Path)
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while ($watch.ElapsedMilliseconds -lt 120000) {
    if ([IO.File]::Exists($Path)) { return }
    Start-Sleep -Milliseconds 30
  }
  throw 'The synthetic fixture release deadline expired.'
}

function Get-EnvironmentReceipt {
  param([string] $FixtureRole)
  $process = Get-Process -Id $PID
  $expected = [Environment]::GetEnvironmentVariable('MORROW_188_EXPECTED_UNICODE', [EnvironmentVariableTarget]::Process)
  $actual = [Environment]::GetEnvironmentVariable('MORROW_188_CHILD_UNICODE', [EnvironmentVariableTarget]::Process)
  return [ordered]@{
    role = $FixtureRole
    processId = [uint32]$PID
    creationTimeUtc = $process.StartTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    expectedUnicodePresent = ($null -ne $expected -and $actual -ceq $expected)
    parentOnlyPresent = (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($ParentOnlyKey, [EnvironmentVariableTarget]::Process)))
  }
}

try {
  $releasePath = Join-Path $CaseRoot ('release-' + $Nonce + '.signal')
  $entryPath = Join-Path $CaseRoot ($Role + '-' + $Nonce + '.entry.json')
  Write-FixtureJson -Path $entryPath -Value (Get-EnvironmentReceipt -FixtureRole $Role)

  if ($Role -in @('root-hold', 'root-exits-before-neto')) {
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = [Environment]::GetEnvironmentVariable('MORROW_188_PWSH_PATH', [EnvironmentVariableTarget]::Process)
    $startInfo.WorkingDirectory = [Environment]::GetEnvironmentVariable('TEMP', [EnvironmentVariableTarget]::Process)
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    foreach ($argument in @(
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', $PSCommandPath,
      'neto-hold', $CaseRoot, $Nonce, $ParentOnlyKey
    )) {
      [void]$startInfo.ArgumentList.Add([string]$argument)
    }
    $neto = [Diagnostics.Process]::Start($startInfo)
    if ($null -eq $neto) { throw 'The root could not start its synthetic neto.' }
    $netoStart = $neto.StartTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    $netoId = [uint32]$neto.Id
    $neto.Dispose()

    $netoReceiptPath = Join-Path $CaseRoot ('neto-hold-' + $Nonce + '.entry.json')
    $netoWatch = [Diagnostics.Stopwatch]::StartNew()
    while (-not [IO.File]::Exists($netoReceiptPath) -and $netoWatch.ElapsedMilliseconds -lt 10000) {
      Start-Sleep -Milliseconds 25
    }
    if (-not [IO.File]::Exists($netoReceiptPath)) { throw 'The synthetic neto did not enter its hold fixture.' }
    Write-FixtureJson -Path (Join-Path $CaseRoot ('neto-process-' + $Nonce + '.json')) -Value ([ordered]@{
      processId = $netoId
      creationTimeUtc = $netoStart
    })

    if ($Role -eq 'root-exits-before-neto') { exit 37 }
  }

  if ($Role -in @('root-hold', 'neto-hold', 'leaf-hold', 'outsider-hold')) {
    Wait-ForRelease -Path $releasePath
  }
} catch {
  $errorPath = Join-Path $CaseRoot ('fixture-error-' + $Role + '-' + $Nonce + '.json')
  try {
    Write-FixtureJson -Path $errorPath -Value ([ordered]@{
      role = $Role
      errorType = $_.Exception.GetType().FullName
    })
  } catch { }
  exit 91
}
'@

    $fixturePath = Join-Path $script:EvidenceRootFull 'fixture\synthetic-process-fixture.ps1'
  [IO.File]::WriteAllText($fixturePath, $fixture, $script:Utf8NoBom)
  $script:FixturePath = $fixturePath
  $script:FixtureSha256 = (Get-FileHash -LiteralPath $fixturePath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function New-ConsumerFixture {
  param(
    [Parameter(Mandatory)][string] $Path,
    [Parameter(Mandatory)][string] $AdapterPath,
    [Parameter(Mandatory)][string] $FixturePath
  )

  $consumer = @'
param(
  [Parameter(Position = 0)][string] $AdapterPath,
  [Parameter(Position = 1)][string] $FixturePath,
  [Parameter(Position = 2)][string] $CaseRoot,
  [Parameter(Position = 3)][string] $Nonce,
  [Parameter(Position = 4)][string] $ParentOnlyKey,
  [Parameter(Position = 5)][string] $ReadyPath,
  [Parameter(Position = 6)][string] $ReleasePath,
  [Parameter(Position = 7)][string] $ReleaseToken,
  [Parameter(Position = 8)][string] $ResumedPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$session = $null

function Write-ConsumerJson {
  param([string] $Path, $Value)
  $json = ConvertTo-Json -InputObject $Value -Depth 12 -Compress
  $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
  [IO.File]::Move($temporary, $Path)
}

try {
  . $AdapterPath
  $environment = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($name in @(
    'SystemRoot', 'windir', 'SystemDrive', 'PATH', 'TEMP', 'TMP', 'USERPROFILE',
    'HOME', 'APPDATA', 'LOCALAPPDATA', 'PSHOME', 'PSModulePath', 'ComSpec',
    'RUNNER_TEMP', 'MORROW_188_PWSH_PATH', 'MORROW_188_EXPECTED_UNICODE',
    'MORROW_188_CHILD_UNICODE'
  )) {
    $value = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::Process)
    if ($null -ne $value) { $environment.Add($name, $value) }
  }

  $arguments = [string[]]@(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', $FixturePath,
    'leaf-hold', $CaseRoot, $Nonce, $ParentOnlyKey
  )
  $createArguments = @{
    ExecutablePath = [Environment]::GetEnvironmentVariable('MORROW_188_PWSH_PATH', [EnvironmentVariableTarget]::Process)
    ArgumentList = $arguments
    Environment = $environment
    WorkingDirectory = $CaseRoot
  }
  $session = CreateAtomicSuspendedRoot @createArguments

  $observation = $session.ObserveRoot()
  $members = @($session.ListMemberIds() | ForEach-Object { [uint32]$_ })
  Write-ConsumerJson -Path $ReadyPath -Value ([ordered]@{
    consumerProcessId = [uint32]$PID
    observation = $observation
    memberIds = $members
  })

  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ([IO.File]::Exists($ReleasePath)) {
      if ([IO.File]::ReadAllText($ReleasePath) -cne $ReleaseToken) {
        throw 'The pre-resume release token did not match.'
      }
      $resume = $session.Resume()
      Write-ConsumerJson -Path $ResumedPath -Value ([ordered]@{
        resumed = [bool]$resume.resumed
        rootProcessId = [uint32]$resume.rootProcessId
        previousSuspendCount = [uint32]$resume.previousSuspendCount
        state = [string]$resume.state
      })
      throw 'The test observer released the consumer instead of killing it at the barrier.'
    }
    Start-Sleep -Milliseconds 25
  }
  throw 'The external barrier observer did not terminate the consumer.'
} catch {
  $errorPath = Join-Path $CaseRoot ('consumer-error-' + $Nonce + '.json')
  try {
    Write-ConsumerJson -Path $errorPath -Value ([ordered]@{
      errorType = $_.Exception.GetType().FullName
    })
  } catch { }
  if ($null -ne $session) {
    try { $session.Dispose() } catch { }
  }
  exit 91
}
'@

  [IO.File]::WriteAllText($Path, $consumer, $script:Utf8NoBom)
  $script:ConsumerFixtureSha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Start-Outsider {
  $caseRoot = New-CaseRoot -Name 'outsider'
  $nonce = [Guid]::NewGuid().ToString('N')
  $environment = New-ExplicitEnvironment -CaseRoot $caseRoot -ExpectedValue $script:ExpectedUnicodeValue
  $arguments = Get-FixtureArgumentList -Role 'outsider-hold' -CaseRoot $caseRoot -Nonce $nonce
  $processArguments = @{
    ExecutablePath = $script:PwshPath
    ArgumentList = $arguments
    Environment = $environment
    WorkingDirectory = $caseRoot
    Role = 'outsider'
  }
  $record = Start-TrackedProcess @processArguments
  $script:Outsider = $record
  $script:OutsiderReadyPath = Join-Path $caseRoot ('outsider-hold-' + $nonce + '.entry.json')
  $script:OutsiderReleasePath = Join-Path $caseRoot ('release-' + $nonce + '.signal')
  Wait-ForFile -Path $script:OutsiderReadyPath -TimeoutMs 10000 -Description 'the outsider fixture'
  Assert-True -Condition (Test-ProcessAlive -Record $record) -Message 'The outsider exited before containment checks began.'
  return $record
}

function Test-InitialSessionAndStop {
  $caseRoot = New-CaseRoot -Name 'root-neto-stop'
  $nonce = [Guid]::NewGuid().ToString('N')
  $created = New-RootSession -CaseRoot $caseRoot -Role 'root-hold' -Nonce $nonce
  $session = $created.session
  $initial = Assert-SuspendedRoot -Session $created -ExpectedCreatorProcessId ([uint32]$PID)
  $root = Open-TrackedProcessById -ProcessId ([uint32]$initial.observation.processId) -Role 'root'
  Assert-TrackedProcessMatches -Record $root -ExpectedId ([uint32]$initial.observation.processId) -ExpectedPath $script:PwshPath
  Assert-CreationTimesMatch -ObservedUtc ([string]$initial.observation.creationTimeUtc) -HandleUtc ([string]$root.creationTimeUtc)

  Assert-DoesNotContainId -Ids $initial.memberIds -ProcessId ([uint32]$script:Outsider.processId) -Message 'The outsider appeared in the private Job member list.'
  Assert-True -Condition (Test-ProcessAlive -Record $script:Outsider) -Message 'The outsider was not alive before resume.'

  $resume = $session.Resume()
  Assert-True -Condition ([bool]$resume.resumed) -Message 'Resume did not report success.'
  Assert-Equal -Actual ([uint32]$resume.rootProcessId) -Expected ([uint32]$initial.observation.processId) -Message 'Resume targeted a different root PID.'
  Assert-Equal -Actual ([uint32]$resume.previousSuspendCount) -Expected ([uint32]1) -Message 'Resume did not release exactly the initial suspension.'
  Assert-Equal -Actual ([string]$resume.state) -Expected 'resume-requested' -Message 'Resume returned an unexpected state.'
  $script:Observations.Add([ordered]@{
    phase = 'resume-requested'
    processId = [uint32]$resume.rootProcessId
    previousSuspendCount = [uint32]$resume.previousSuspendCount
    state = [string]$resume.state
  })

  $rootEntryPath = Join-Path $caseRoot ('root-hold-' + $nonce + '.entry.json')
  $netoEntryPath = Join-Path $caseRoot ('neto-hold-' + $nonce + '.entry.json')
  $netoProcessReceiptPath = Join-Path $caseRoot ('neto-process-' + $nonce + '.json')
  Wait-ForFile -Path $rootEntryPath -TimeoutMs 10000 -Description 'root execution after resume'
  Wait-ForFile -Path $netoEntryPath -TimeoutMs 10000 -Description 'the neto process'
  Wait-ForFile -Path $netoProcessReceiptPath -TimeoutMs 10000 -Description 'the neto process receipt'
  $rootEntry = Read-JsonFile -Path $rootEntryPath
  $netoEntry = Read-JsonFile -Path $netoEntryPath
  $netoProcessReceipt = Read-JsonFile -Path $netoProcessReceiptPath
  Assert-True -Condition ([bool]$rootEntry.expectedUnicodePresent -and [bool]$netoEntry.expectedUnicodePresent) -Message 'The complete Unicode environment block did not reach the synthetic tree.'
  Assert-True -Condition (-not [bool]$rootEntry.parentOnlyPresent -and -not [bool]$netoEntry.parentOnlyPresent) -Message 'A parent-only environment variable leaked into the synthetic tree.'
  Assert-Equal -Actual ([uint32]$netoEntry.processId) -Expected ([uint32]$netoProcessReceipt.processId) -Message 'The child fixture PID differed from the root-held process handle PID.'
  Assert-CreationTimesMatch -ObservedUtc ([string]$netoEntry.creationTimeUtc) -HandleUtc ([string]$netoProcessReceipt.creationTimeUtc)
  $netoRecord = Open-TrackedProcessById -ProcessId ([uint32]$netoEntry.processId) -Role 'neto'
  Assert-TrackedProcessMatches -Record $netoRecord -ExpectedId ([uint32]$netoEntry.processId) -ExpectedPath $script:PwshPath
  Assert-CreationTimesMatch -ObservedUtc ([string]$netoEntry.creationTimeUtc) -HandleUtc ([string]$netoRecord.creationTimeUtc)

  $members = @($session.ListMemberIds() | ForEach-Object { [uint32]$_ })
  Assert-ContainsId -Ids $members -ProcessId ([uint32]$root.processId) -Message 'The resumed root disappeared from the Job while it was holding.'
  Assert-ContainsId -Ids $members -ProcessId ([uint32]$netoRecord.processId) -Message 'The neto was not contained in the root Job.'
  Assert-DoesNotContainId -Ids $members -ProcessId ([uint32]$script:Outsider.processId) -Message 'The outsider was included in the private Job.'
  Assert-True -Condition (Test-ProcessAlive -Record $script:Outsider) -Message 'The outsider exited before StopAndWait.'

  $duplicateResumeRefused = $false
  try { $session.Resume() | Out-Null } catch { $duplicateResumeRefused = $true }
  Assert-True -Condition $duplicateResumeRefused -Message 'A second Resume call was not refused.'
  Assert-True -Condition (Test-ProcessAlive -Record $root) -Message 'A duplicate Resume attempt changed the live root.'

  $stop = $session.StopAndWait()
  Assert-True -Condition ([bool]$stop.jobEmpty) -Message 'StopAndWait did not prove the private Job empty.'
  Assert-Equal -Actual (@($stop.remainingMemberIds).Count) -Expected 0 -Message 'StopAndWait returned remaining Job members.'
  Assert-True -Condition ([bool]$stop.rootExited) -Message 'StopAndWait did not observe the retained root exit.'
  Assert-True -Condition (-not [bool]$stop.timedOut) -Message 'StopAndWait timed out.'
  Assert-True -Condition ($null -ne $stop.rootExitCode) -Message 'StopAndWait omitted the root exit code observed from its retained handle.'
  $script:Observations.Add([ordered]@{
    phase = 'stop-root-neto'
    jobEmpty = [bool]$stop.jobEmpty
    remainingMemberIds = @($stop.remainingMemberIds | ForEach-Object { [uint32]$_ })
    rootExited = [bool]$stop.rootExited
    rootExitCode = [uint32]$stop.rootExitCode
    timedOut = [bool]$stop.timedOut
  })
  Wait-ForProcessExit -Record $root -TimeoutMs 5000 -Description 'the stopped root'
  Wait-ForProcessExit -Record $netoRecord -TimeoutMs 5000 -Description 'the stopped neto'
  $after = $session.ObserveRoot()
  Assert-Equal -Actual ([string]$after.state) -Expected 'exited' -Message 'The retained root handle did not report exit after stop.'
  Assert-Equal -Actual ([uint32]$after.exitCode) -Expected ([uint32]$stop.rootExitCode) -Message 'The observed root exit code changed between handle reads.'
  $repeatStop = $session.StopAndWait(10000)
  Assert-True -Condition ([bool]$repeatStop.jobEmpty -and -not [bool]$repeatStop.timedOut) -Message 'A repeated StopAndWait did not preserve the empty result.'
  Assert-Equal -Actual ([uint32]$repeatStop.rootExitCode) -Expected ([uint32]$stop.rootExitCode) -Message 'A repeated StopAndWait changed the observed root exit code.'
  Assert-True -Condition (Test-ProcessAlive -Record $script:Outsider) -Message 'Stopping the private Job terminated the outsider.'
  $script:CleanupNotes.Add('root-neto-stop: Job empty; outsider remained alive.')
}

function Test-RootExitsBeforeNeto {
  $caseRoot = New-CaseRoot -Name 'root-exits-first'
  $nonce = [Guid]::NewGuid().ToString('N')
  $created = New-RootSession -CaseRoot $caseRoot -Role 'root-exits-before-neto' -Nonce $nonce
  $session = $created.session
  $initial = Assert-SuspendedRoot -Session $created -ExpectedCreatorProcessId ([uint32]$PID)
  $root = Open-TrackedProcessById -ProcessId ([uint32]$initial.observation.processId) -Role 'root-exits-first'
  $resume = $session.Resume()
  Assert-True -Condition ([bool]$resume.resumed) -Message 'Resume failed for the root-exit scenario.'

  $netoEntryPath = Join-Path $caseRoot ('neto-hold-' + $nonce + '.entry.json')
  $netoProcessReceiptPath = Join-Path $caseRoot ('neto-process-' + $nonce + '.json')
  Wait-ForFile -Path $netoEntryPath -TimeoutMs 10000 -Description 'the neto before root exit'
  Wait-ForFile -Path $netoProcessReceiptPath -TimeoutMs 10000 -Description 'the neto process receipt before root exit'
  $netoEntry = Read-JsonFile -Path $netoEntryPath
  $netoProcessReceipt = Read-JsonFile -Path $netoProcessReceiptPath
  Assert-Equal -Actual ([uint32]$netoEntry.processId) -Expected ([uint32]$netoProcessReceipt.processId) -Message 'The child fixture PID differed from the root-held process handle PID.'
  Assert-CreationTimesMatch -ObservedUtc ([string]$netoEntry.creationTimeUtc) -HandleUtc ([string]$netoProcessReceipt.creationTimeUtc)
  $netoRecord = Open-TrackedProcessById -ProcessId ([uint32]$netoEntry.processId) -Role 'neto-after-root-exit'
  Wait-ForProcessExit -Record $root -TimeoutMs 10000 -Description 'the root that exits before the neto'
  Assert-Equal -Actual ([uint32]$root.exitCode) -Expected ([uint32]37) -Message 'The synthetic root did not return its known natural exit code.'
  $observed = $session.ObserveRoot()
  Assert-Equal -Actual ([string]$observed.state) -Expected 'exited' -Message 'The root exit was not observed through its retained handle.'
  Assert-True -Condition ([bool]$observed.wasAssociatedAtCreation) -Message 'The root lost its creation-time Job association receipt.'
  Assert-Equal -Actual ([uint32]$observed.exitCode) -Expected ([uint32]37) -Message 'The root exit code was not read from its retained process handle.'
  $script:Observations.Add([ordered]@{
    phase = 'root-exited-neto-active'
    processId = [uint32]$observed.processId
    creatorProcessId = [uint32]$observed.creatorProcessId
    state = [string]$observed.state
    exitCode = [uint32]$observed.exitCode
    wasAssociatedAtCreation = [bool]$observed.wasAssociatedAtCreation
    memberIds = @($session.ListMemberIds() | ForEach-Object { [uint32]$_ })
  })

  $members = @($session.ListMemberIds() | ForEach-Object { [uint32]$_ })
  Assert-ContainsId -Ids $members -ProcessId ([uint32]$netoRecord.processId) -Message 'The neto was not observed after its root exited.'
  Assert-DoesNotContainId -Ids $members -ProcessId ([uint32]$script:Outsider.processId) -Message 'The outsider appeared after the root exited.'
  Assert-True -Condition (Test-ProcessAlive -Record $netoRecord) -Message 'The neto exited with its parent instead of remaining in the Job.'

  $stop = $session.StopAndWait(10000)
  Assert-True -Condition ([bool]$stop.jobEmpty -and -not [bool]$stop.timedOut) -Message 'StopAndWait did not empty the Job after the root exited.'
  Assert-Equal -Actual (@($stop.remainingMemberIds).Count) -Expected 0 -Message 'The neto remained in the Job after StopAndWait.'
  Assert-True -Condition ([bool]$stop.rootExited) -Message 'StopAndWait did not retain the root exit observation.'
  Assert-Equal -Actual ([uint32]$stop.rootExitCode) -Expected ([uint32]37) -Message 'StopAndWait did not preserve the root exit code.'
  $script:Observations.Add([ordered]@{
    phase = 'stop-after-root-exit'
    jobEmpty = [bool]$stop.jobEmpty
    remainingMemberIds = @($stop.remainingMemberIds | ForEach-Object { [uint32]$_ })
    rootExited = [bool]$stop.rootExited
    rootExitCode = [uint32]$stop.rootExitCode
    timedOut = [bool]$stop.timedOut
  })
  Wait-ForProcessExit -Record $netoRecord -TimeoutMs 5000 -Description 'the neto remaining after its root exited'
  Assert-True -Condition (Test-ProcessAlive -Record $script:Outsider) -Message 'Stopping the Job after root exit terminated the outsider.'
  $script:CleanupNotes.Add('root-exits-first: neto remained contained and was stopped; outsider remained alive.')
}

function Test-DisposeFailSafe {
  $caseRoot = New-CaseRoot -Name 'dispose-suspended'
  $nonce = [Guid]::NewGuid().ToString('N')
  $created = New-RootSession -CaseRoot $caseRoot -Role 'leaf-hold' -Nonce $nonce
  $session = $created.session
  $initial = Assert-SuspendedRoot -Session $created -ExpectedCreatorProcessId ([uint32]$PID)
  $root = Open-TrackedProcessById -ProcessId ([uint32]$initial.observation.processId) -Role 'root-dispose'
  $entryPath = Join-Path $caseRoot ('leaf-hold-' + $nonce + '.entry.json')

  $session.Dispose()
  $session.Dispose()
  Wait-ForProcessExit -Record $root -TimeoutMs 5000 -Description 'the suspended root after Dispose'
  Assert-True -Condition (-not [IO.File]::Exists($entryPath)) -Message 'Dispose allowed the suspended root to execute its fixture.'
  Assert-True -Condition ($null -ne $root.exitCode) -Message 'The external process handle did not observe the disposed root exit code.'
  Assert-Equal -Actual ([int64]$root.process.ExitCode) -Expected ([int64]$root.exitCode) -Message 'The process handle exit code was not stable after Dispose.'
  Assert-True -Condition (Test-ProcessAlive -Record $script:Outsider) -Message 'Dispose terminated the outsider.'
  $script:CleanupNotes.Add('dispose: idempotent disposal closed the private Job and stopped its suspended root.')
}

function Test-CreateFailure {
  $caseRoot = New-CaseRoot -Name 'create-failure'
  $missingExecutable = Join-Path $caseRoot 'missing executable that must not exist.exe'
  $environment = New-ExplicitEnvironment -CaseRoot $caseRoot -ExpectedValue $script:ExpectedUnicodeValue
  $threw = $false
  try {
    $createArguments = @{
      ExecutablePath = $missingExecutable
      ArgumentList = [string[]]@()
      Environment = $environment
      WorkingDirectory = $caseRoot
    }
    CreateAtomicSuspendedRoot @createArguments | Out-Null
  } catch {
    $threw = $true
    $script:Metadata['createFailureErrorType'] = $_.Exception.GetType().FullName
  }
  Assert-True -Condition $threw -Message 'CreateAtomicSuspendedRoot returned a session for a missing executable.'
  Assert-Equal -Actual ([IO.Directory]::GetFiles($caseRoot, '*.entry.json').Count) -Expected 0 -Message 'The failed create path unexpectedly ran a fixture.'
  Assert-True -Condition (Test-ProcessAlive -Record $script:Outsider) -Message 'The creation failure changed the unrelated outsider.'
  $script:CleanupNotes.Add('create-failure: missing executable failed closed without an observed fixture.')
}

function Test-ConsumerDeathBeforeResume {
  $caseRoot = New-CaseRoot -Name 'consumer-death-before-resume'
  $nonce = [Guid]::NewGuid().ToString('N')
  $readyPath = Join-Path $caseRoot 'consumer-contained-before-resume.json'
  $releasePath = Join-Path $caseRoot 'consumer-release.signal'
  $releaseToken = [Guid]::NewGuid().ToString('N')
  $resumedPath = Join-Path $caseRoot 'consumer-resumed.json'
  $consumerScript = Join-Path $caseRoot 'synthetic-consumer.ps1'
  New-ConsumerFixture -Path $consumerScript -AdapterPath $script:AdapterPath -FixturePath $script:FixturePath

  $environment = New-ExplicitEnvironment -CaseRoot $caseRoot -ExpectedValue $script:ExpectedUnicodeValue
  $consumerArguments = [string[]]@(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', $consumerScript,
    $script:AdapterPath, $script:FixturePath, $caseRoot, $nonce, $script:ParentOnlyKey,
    $readyPath, $releasePath, $releaseToken, $resumedPath
  )
  $processArguments = @{
    ExecutablePath = $script:PwshPath
    ArgumentList = $consumerArguments
    Environment = $environment
    WorkingDirectory = $caseRoot
    Role = 'consumer-controller'
  }
  $consumer = Start-TrackedProcess @processArguments

  Wait-ForFile -Path $readyPath -TimeoutMs 15000 -Description 'the post-return pre-resume containment barrier'
  $barrier = Read-JsonFile -Path $readyPath
  Assert-Equal -Actual ([uint32]$barrier.consumerProcessId) -Expected ([uint32]$consumer.processId) -Message 'The barrier receipt came from a different consumer.'
  $observation = $barrier.observation
  Assert-Equal -Actual ([string]$observation.state) -Expected 'suspended' -Message 'The root was not suspended at the consumer-death barrier.'
  Assert-True -Condition ([bool]$observation.isMember -and [bool]$observation.wasAssociatedAtCreation) -Message 'The barrier did not follow confirmed Job membership.'
  Assert-Equal -Actual ([string]$observation.executablePath) -Expected $script:PwshPath -IgnoreCase -Message 'The barrier observation did not identify the synthetic PowerShell executable.'
  Assert-Equal -Actual ([uint32]$observation.creatorProcessId) -Expected ([uint32]$consumer.processId) -Message 'The root was not created by the consumer being terminated.'
  Assert-Equal -Actual ([uint32]$observation.jobLimitFlags) -Expected ([uint32]0x2000) -Message 'The barrier Job flags were not KILL_ON_JOB_CLOSE only.'
  Assert-True -Condition (-not [bool]$observation.jobHandleInheritable) -Message 'The barrier Job handle was inheritable.'
  Assert-ContainsId -Ids @($barrier.memberIds) -ProcessId ([uint32]$observation.processId) -Message 'The suspended root was missing from the barrier member list.'
  Assert-DoesNotContainId -Ids @($barrier.memberIds) -ProcessId ([uint32]$script:Outsider.processId) -Message 'The outsider was in the barrier Job.'
  $script:Observations.Add([ordered]@{
    phase = 'consumer-death-pre-resume'
    consumerProcessId = [uint32]$barrier.consumerProcessId
    processId = [uint32]$observation.processId
    creatorProcessId = [uint32]$observation.creatorProcessId
    creationTimeUtc = [string]$observation.creationTimeUtc
    memberIds = @($barrier.memberIds | ForEach-Object { [uint32]$_ })
    isMember = [bool]$observation.isMember
    wasAssociatedAtCreation = [bool]$observation.wasAssociatedAtCreation
    jobLimitFlags = [uint32]$observation.jobLimitFlags
    jobHandleInheritable = [bool]$observation.jobHandleInheritable
  })

  $suspendedRoot = Open-TrackedProcessById -ProcessId ([uint32]$observation.processId) -Role 'suspended-root-at-crash'
  Assert-TrackedProcessMatches -Record $suspendedRoot -ExpectedId ([uint32]$observation.processId) -ExpectedPath $script:PwshPath
  Assert-CreationTimesMatch -ObservedUtc ([string]$observation.creationTimeUtc) -HandleUtc ([string]$suspendedRoot.creationTimeUtc)
  Assert-True -Condition (Test-ProcessAlive -Record $script:Outsider) -Message 'The outsider was already dead before consumer termination.'
  Assert-True -Condition (-not [IO.File]::Exists($releasePath)) -Message 'The consumer was released before the crash injection.'

  $script:CleanupNotes.Add('consumer-death: terminating only the exact consumer process handle at the pre-resume barrier.')
  $consumer.process.Kill()
  Wait-ForProcessExit -Record $consumer -TimeoutMs 5000 -Description 'the exact synthetic consumer process'
  Wait-ForProcessExit -Record $suspendedRoot -TimeoutMs 10000 -Description 'the contained suspended root after consumer death'

  $executionMarker = Join-Path $caseRoot ('leaf-hold-' + $nonce + '.entry.json')
  Assert-True -Condition (-not [IO.File]::Exists($executionMarker)) -Message 'The suspended root executed after the consumer died before Resume.'
  Assert-True -Condition (-not [IO.File]::Exists($resumedPath)) -Message 'The consumer resumed its root before the outer observer killed it.'
  Assert-True -Condition (Test-ProcessAlive -Record $script:Outsider) -Message 'Consumer death terminated the outsider.'
  $script:Metadata['consumerExitCode'] = $consumer.exitCode
  $script:Metadata['suspendedRootExitCode'] = $suspendedRoot.exitCode
  $script:CleanupNotes.Add('consumer-death: root handle signaled without fixture execution; outsider survived.')
}

function Close-AllResources {
  foreach ($session in $script:Sessions) {
    try {
      $cleanup = $session.StopAndWait(5000)
      if (-not [bool]$cleanup.jobEmpty) {
        $script:Failures.Add('A private Job was not empty during final cleanup.')
      }
    } catch {
      if (-not (Test-IsObjectDisposedException -ErrorRecord $_)) {
        $script:Failures.Add('StopAndWait failed during final cleanup before proving the Job empty.')
      }
      try { $session.Dispose() } catch {
        $script:Failures.Add('A private Job could not be disposed during final cleanup.')
      }
    }
  }

  foreach ($record in $script:TrackedProcesses) {
    Close-TrackedProcess -Record $record -IsOutsider ([string]$record.role -eq 'outsider')
  }

  foreach ($record in $script:TrackedProcesses) {
    try { $record.process.Dispose() } catch { }
  }
  foreach ($session in $script:Sessions) {
    try { $session.Dispose() } catch { }
  }

  if (-not [string]::IsNullOrWhiteSpace($script:ParentOnlyKey)) {
    [Environment]::SetEnvironmentVariable($script:ParentOnlyKey, $null, [EnvironmentVariableTarget]::Process)
  }
}

function Get-CheckFailures {
  return @($script:Checks.GetEnumerator() | Where-Object {
    $_.Value -is [System.Collections.IDictionary] -and $_.Value.Contains('status') -and $_.Value['status'] -eq 'failed'
  })
}

function Write-FinalReceipt {
  if ([string]::IsNullOrWhiteSpace($script:EvidenceRootFull)) {
    [Console]::Out.WriteLine('{"schemaVersion":1,"issue":188,"status":"failed","evidenceAvailable":false}')
    return
  }

  $failed = ($script:Failures.Count -gt 0) -or ((Get-CheckFailures).Count -gt 0)
  $status = if ($failed) { 'failed' } else { 'passed' }
  $receipt = [ordered]@{
    schemaVersion = 1
    issue = 188
    status = $status
    startedAtUtc = $script:RunStartedUtc
    completedAtUtc = [DateTime]::UtcNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    sourceRevision = $env:GITHUB_SHA
    workflowRunId = $env:GITHUB_RUN_ID
    workflowRunAttempt = $env:GITHUB_RUN_ATTEMPT
    operatingSystemVersion = [Environment]::OSVersion.Version.ToString()
    windowsBuild = [Environment]::GetEnvironmentVariable('WindowsBuildLabEx', [EnvironmentVariableTarget]::Process)
    powershellVersion = $PSVersionTable.PSVersion.ToString()
    powershellEdition = $PSVersionTable.PSEdition
    sourceSha256 = $script:AdapterSha256
    independentTestSha256 = $script:TestSha256
    fixtureSha256 = $script:FixtureSha256
    consumerFixtureSha256 = $script:ConsumerFixtureSha256
    pids = @($script:TrackedProcesses | ForEach-Object {
      [ordered]@{
        role = $_.role
        processId = $_.processId
        creationTimeUtc = $_.creationTimeUtc
        image = [IO.Path]::GetFileName([string]$_.imagePath)
        exitCode = $_.exitCode
        emergencyCleanup = $_.emergencyCleanup
      }
    })
    metadata = $script:Metadata
    observations = @($script:Observations)
    checks = $script:Checks
    cleanup = [ordered]@{
      notes = @($script:CleanupNotes)
      emergencyCleanupUsed = $script:EmergencyCleanupUsed
      outstandingProcessIds = @($script:OutstandingProcessIds)
    }
    failures = @($script:Failures)
  }
  try {
    Write-JsonAtomically -Path $script:ReceiptPath -Value $receipt
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $receipt -Depth 16 -Compress))
  } catch {
    [Console]::Error.WriteLine('FAIL receipt: unable to write the sanitized independent receipt.')
    [Console]::Out.WriteLine('{"schemaVersion":1,"issue":188,"status":"failed","receiptWriteFailed":true}')
    $script:Failures.Add('The independent receipt could not be written.')
  }
}

$runFailed = $false
try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This independent native Job probe must run on Windows CI.'
  }
  Initialize-ProcessImageQuery
  if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
    throw 'RUNNER_TEMP is required for independent evidence.'
  }

  $script:RunnerTempFull = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd([char[]]@('\', '/'))
  $requestedRoot = [IO.Path]::GetFullPath($EvidenceRoot)
  $runnerPrefix = $script:RunnerTempFull + [IO.Path]::DirectorySeparatorChar
  if (-not $requestedRoot.StartsWith($runnerPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'EvidenceRoot must be a new directory beneath RUNNER_TEMP.'
  }
  Assert-NoReparseSegments -Path $requestedRoot -Root $script:RunnerTempFull
  if (Test-PathExists -Path $requestedRoot) {
    throw 'EvidenceRoot must not already exist; refusing to overwrite evidence.'
  }
  [void][IO.Directory]::CreateDirectory($requestedRoot)
  $script:EvidenceRootFull = $requestedRoot
  $script:ReceiptPath = Join-Path $script:EvidenceRootFull 'windows-native-job.independent.receipt.json'

  [IO.File]::WriteAllText(
    (Join-Path $script:EvidenceRootFull '.issue-188-independent-owner'),
    [Guid]::NewGuid().ToString('N'),
    $script:Utf8NoBom
  )

  $script:AdapterPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'windows-native-job.ps1'))
  if (-not [IO.File]::Exists($script:AdapterPath)) {
    throw 'The staged adapter sibling windows-native-job.ps1 is missing.'
  }
  $script:AdapterSha256 = (Get-FileHash -LiteralPath $script:AdapterPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $script:TestSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()

  $script:PwshInstallDirectory = $PSHOME
  $script:PwshPath = [IO.Path]::GetFullPath((Join-Path $PSHOME 'pwsh.exe'))
  if (-not [IO.File]::Exists($script:PwshPath)) {
    throw 'The running PowerShell installation did not contain pwsh.exe in PSHOME.'
  }

  $fixtureDirectory = Join-Path $script:EvidenceRootFull 'fixture'
  [void][IO.Directory]::CreateDirectory($fixtureDirectory)
  Write-TestFixture
  [Environment]::SetEnvironmentVariable($script:ParentOnlyKey, $script:ParentOnlyValue, [EnvironmentVariableTarget]::Process)

  . $script:AdapterPath
  Assert-True -Condition (Test-Path -LiteralPath $script:AdapterPath -PathType Leaf) -Message 'The frozen adapter could not be read.'

  $setupFailed = $false
  try {
    $null = Start-Outsider
    $script:Checks['outsider-setup'] = [ordered]@{ status = 'passed' }
  } catch {
    $setupFailed = $true
    $safeMessage = Get-SafeMessage -Exception $_.Exception
    $script:Checks['outsider-setup'] = [ordered]@{ status = 'failed'; message = $safeMessage }
    $script:Failures.Add(('outsider-setup: {0}' -f $safeMessage))
    [Console]::Error.WriteLine(('FAIL outsider-setup: {0}' -f $safeMessage))
  }

  if (-not $setupFailed -and $null -ne $script:Outsider) {
    Invoke-Scenario -Name 'suspended-create-resume-stop-root-neto-outsider' -Action { Test-InitialSessionAndStop }
    Invoke-Scenario -Name 'root-exits-before-neto-remains-contained' -Action { Test-RootExitsBeforeNeto }
    Invoke-Scenario -Name 'dispose-idempotent-fail-safe' -Action { Test-DisposeFailSafe }
    Invoke-Scenario -Name 'create-failure-fails-closed' -Action { Test-CreateFailure }
    Invoke-Scenario -Name 'consumer-death-after-containment-before-resume' -Action { Test-ConsumerDeathBeforeResume }
  }
} catch {
  $runFailed = $true
  $safeMessage = Get-SafeMessage -Exception $_.Exception
  $script:Failures.Add(('setup: {0}' -f $safeMessage))
  [Console]::Error.WriteLine(('FAIL setup: {0}' -f $safeMessage))
} finally {
  try { Close-AllResources } catch {
    $script:Failures.Add('Final cleanup raised an unhandled error.')
    [Console]::Error.WriteLine('FAIL cleanup: final cleanup raised an unhandled error.')
  }
  Write-FinalReceipt
}

if ($runFailed -or $script:Failures.Count -gt 0 -or (Get-CheckFailures).Count -gt 0) {
  exit 1
}

exit 0
