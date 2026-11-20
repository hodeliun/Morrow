function Get-PilotWindowsNativeProcessCapsuleSource {
  @'
using System;
using System.Collections.Generic;
using System.Reflection;

namespace Morrow.Pilot
{
  public sealed class WindowsNativeProcessCleanupSnapshot
  {
    public bool jobEmpty { get; private set; }
    public bool rootExited { get; private set; }
    public uint? exitCode { get; private set; }

    internal WindowsNativeProcessCleanupSnapshot(bool jobEmpty, bool rootExited, uint? exitCode)
    {
      this.jobEmpty = jobEmpty;
      this.rootExited = rootExited;
      this.exitCode = exitCode;
    }

    internal WindowsNativeProcessCleanupSnapshot Copy()
    {
      return new WindowsNativeProcessCleanupSnapshot(jobEmpty, rootExited, exitCode);
    }
  }

  public sealed class WindowsNativeProcessCapsule
  {
    private sealed class IdentitySnapshot
    {
      internal readonly int processId;
      internal readonly int parentProcessId;
      internal readonly string executablePath;
      internal readonly string executableSha256;
      internal readonly string creationTimeUtc;
      internal readonly string ownerSid;

      internal IdentitySnapshot(object[] values)
      {
        if (values == null || values.Length != 6)
          throw new ArgumentException("The observed identity tuple is incomplete.", "values");
        processId = (int)values[0];
        parentProcessId = (int)values[1];
        executablePath = (string)values[2];
        executableSha256 = (string)values[3];
        creationTimeUtc = (string)values[4];
        ownerSid = (string)values[5];
        if (String.IsNullOrEmpty(executablePath) || String.IsNullOrEmpty(executableSha256) ||
            String.IsNullOrEmpty(creationTimeUtc) || String.IsNullOrEmpty(ownerSid))
          throw new ArgumentException("The observed identity tuple is incomplete.", "values");
      }
    }

    private const string DiagnosticsKey = "Morrow.WindowsNativeProcess.Diagnostics";
    private readonly object _sync = new object();
    private readonly IdentitySnapshot _identitySnapshot;
    private object _session;
    private bool _finished;
    private bool _completed;
    private bool _lastJobEmpty;
    private bool _lastRootExited;
    private uint? _lastExitCode;

    private WindowsNativeProcessCapsule(object session, object[] identitySnapshot)
    {
      if (session == null) throw new ArgumentNullException("session");
      Type nativeSessionType = null;
      foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
      {
        Type candidate = assembly.GetType("Morrow.Pilot.WindowsNativeJobSession", false);
        if (candidate != null)
        {
          nativeSessionType = candidate;
          break;
        }
      }
      if (nativeSessionType == null || session.GetType() != nativeSessionType)
        throw new ArgumentException("Only the native Job session type can be captured.", "session");
      _identitySnapshot = new IdentitySnapshot(identitySnapshot);
      _session = session;
    }

    public WindowsNativeProcessCleanupSnapshot Dispose()
    {
      lock (_sync)
      {
        if (_completed)
          return new WindowsNativeProcessCleanupSnapshot(_lastJobEmpty, _lastRootExited, _lastExitCode);
        if (_finished)
          throw CleanupIncomplete();

        Exception failure = null;
        object rawResult = null;
        try
        {
          MethodInfo stop = _session.GetType().GetMethod("StopAndWait", new Type[] { typeof(int) });
          if (stop == null)
            throw new InvalidOperationException("The owned session does not expose its bounded cleanup operation.");
          rawResult = stop.Invoke(_session, new object[] { 10000 });
          if (rawResult == null)
            throw new InvalidOperationException("The owned session returned no cleanup result.");

          Type resultType = rawResult.GetType();
          PropertyInfo jobEmpty = resultType.GetProperty("jobEmpty");
          PropertyInfo rootExited = resultType.GetProperty("rootExited");
          PropertyInfo exitCode = resultType.GetProperty("rootExitCode");
          if (jobEmpty == null || rootExited == null || exitCode == null)
            throw new InvalidOperationException("The owned session returned an incomplete cleanup result.");

          _lastJobEmpty = (bool)jobEmpty.GetValue(rawResult, null);
          _lastRootExited = (bool)rootExited.GetValue(rawResult, null);
          object exitValue = exitCode.GetValue(rawResult, null);
          _lastExitCode = exitValue == null ? (uint?)null : Convert.ToUInt32(exitValue);
          _completed = _lastJobEmpty && _lastRootExited;
          if (!_completed)
            failure = new InvalidOperationException("The owned Job cleanup did not reach its verified terminal state.");
        }
        catch (Exception exception)
        {
          failure = exception;
        }
        finally
        {
          try
          {
            if (_session != null)
            {
              MethodInfo dispose = _session.GetType().GetMethod("Dispose", Type.EmptyTypes);
              if (dispose == null)
                throw new InvalidOperationException("The owned session does not expose disposal.");
              dispose.Invoke(_session, null);
            }
          }
          catch (Exception exception)
          {
            if (failure == null) failure = exception;
          }
          _session = null;
          _finished = true;
        }

        if (failure != null || !_completed)
        {
          _completed = false;
          throw CleanupIncomplete();
        }
        return new WindowsNativeProcessCleanupSnapshot(_lastJobEmpty, _lastRootExited, _lastExitCode);
      }
    }

    private Exception CleanupIncomplete()
    {
      var diagnostics = new Dictionary<string, object>();
      diagnostics["stage"] = "cleanup";
      diagnostics["cause"] = "Morrow.WindowsNativeProcess.CleanupIncomplete";
      diagnostics["fields"] = new string[0];
      diagnostics["cleanup"] = new Dictionary<string, object>
      {
        { "attempted", true },
        { "jobEmpty", _lastJobEmpty },
        { "rootExited", _lastRootExited },
        { "disposeFailed", true }
      };
      var exception = new InvalidOperationException("The owned process Job cleanup could not be confirmed.");
      exception.Data[DiagnosticsKey] = diagnostics;
      return exception;
    }
  }
}
'@
}

function Initialize-PilotWindowsNativeProcessCapsuleInterop {
  if ($null -eq ('Morrow.Pilot.WindowsNativeProcessCapsule' -as [type])) {
    Add-Type -TypeDefinition (Get-PilotWindowsNativeProcessCapsuleSource) -Language CSharp -ErrorAction Stop
  }
  if ($null -eq ('Morrow.Pilot.WindowsNativeProcessCapsule' -as [type])) {
    throw 'The private Windows process capsule type did not load.'
  }
}

function New-PilotWindowsNativeProcessException {
  param(
    [Parameter(Mandatory)][string] $ErrorId,
    [Parameter(Mandatory)][string] $Stage,
    [string[]] $Fields = @(),
    [object] $Cleanup,
    [string] $OriginalErrorId
  )

  $diagnostics = [ordered]@{
    stage = $Stage
    cause = $ErrorId
    fields = @($Fields)
  }
  if ($null -ne $Cleanup) { $diagnostics.cleanup = $Cleanup }
  if (-not [string]::IsNullOrWhiteSpace($OriginalErrorId)) { $diagnostics.originalErrorId = $OriginalErrorId }

  $exception = [InvalidOperationException]::new('The Windows native process policy operation failed.')
  $exception.Data['Morrow.WindowsNativeProcess.ErrorId'] = $ErrorId
  $exception.Data['Morrow.WindowsNativeProcess.Diagnostics'] = $diagnostics
  return $exception
}

function Get-PilotWindowsNativeProcessErrorId {
  param([Parameter(Mandatory)][Exception] $Exception)

  $current = $Exception
  for ($depth = 0; $null -ne $current -and $depth -lt 8; $depth++) {
    if ($current.Data.Contains('Morrow.WindowsNativeProcess.ErrorId')) {
      return [string]$current.Data['Morrow.WindowsNativeProcess.ErrorId']
    }
    $current = $current.InnerException
  }
  return 'Morrow.WindowsNativeProcess.StartFailed'
}

function Get-PilotWindowsNativeProcessDiagnostics {
  param([Parameter(Mandatory)][Exception] $Exception)

  $current = $Exception
  for ($depth = 0; $null -ne $current -and $depth -lt 8; $depth++) {
    if ($current.Data.Contains('Morrow.WindowsNativeProcess.Diagnostics')) {
      return $current.Data['Morrow.WindowsNativeProcess.Diagnostics']
    }
    $current = $current.InnerException
  }
  return $null
}

function Get-PilotWindowsNativeProcessDescriptor {
  param([AllowNull()][object] $Descriptor)

  if ($Descriptor -isnot [System.Collections.IDictionary]) {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'descriptor-validation')
  }

  $required = @(
    'executablePath', 'executableSha256', 'argumentList', 'workingDirectory',
    'profilePath', 'environment', 'expectedParentProcessId', 'expectedOwnerSid'
  )
  $allowed = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($name in $required) { [void]$allowed.Add($name) }
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $fields = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::OrdinalIgnoreCase)

  foreach ($key in $Descriptor.Keys) {
    if ($key -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$key) -or -not $allowed.Contains([string]$key) -or -not $seen.Add([string]$key)) {
      throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'descriptor-validation')
    }
    $fields.Add([string]$key, $Descriptor[$key])
  }
  foreach ($name in $required) {
    if (-not $fields.ContainsKey($name)) {
      throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'descriptor-validation' -Fields @($name))
    }
  }

  foreach ($name in @('executablePath', 'workingDirectory', 'profilePath', 'executableSha256', 'expectedOwnerSid')) {
    $value = $fields[$name]
    if ($value -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$value) -or ([string]$value).IndexOfAny([char[]]@([char]0, [char]10, [char]13)) -ge 0) {
      throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'descriptor-validation' -Fields @($name))
    }
  }

  if ([string]$fields.executableSha256 -notmatch '^[A-Fa-f0-9]{64}$') {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'descriptor-validation' -Fields @('executableSha256'))
  }
  $fields.executableSha256 = ([string]$fields.executableSha256).ToLowerInvariant()

  $arguments = $fields.argumentList
  if ($null -eq $arguments -or $arguments -is [string] -or $arguments -isnot [System.Collections.IList]) {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'descriptor-validation' -Fields @('argumentList'))
  }
  $normalizedArguments = [Collections.Generic.List[string]]::new()
  foreach ($argument in $arguments) {
    if ($argument -isnot [string] -or ([string]$argument).IndexOf([char]0) -ge 0) {
      throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'descriptor-validation' -Fields @('argumentList'))
    }
    [void]$normalizedArguments.Add([string]$argument)
  }
  $fields.argumentList = $normalizedArguments.ToArray()

  $parentValue = $fields.expectedParentProcessId
  $parentType = if ($null -eq $parentValue) { $null } else { $parentValue.GetType() }
  $integralTypes = @([byte], [sbyte], [short], [ushort], [int], [uint32], [long], [ulong])
  if ($null -eq $parentType -or $parentType -notin $integralTypes) {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'descriptor-validation' -Fields @('expectedParentProcessId'))
  }
  try { $parentDecimal = [decimal]$parentValue } catch {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'descriptor-validation' -Fields @('expectedParentProcessId'))
  }
  if ($parentDecimal -lt 1 -or $parentDecimal -gt [int]::MaxValue) {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'descriptor-validation' -Fields @('expectedParentProcessId'))
  }
  $fields.expectedParentProcessId = [int]$parentDecimal

  try {
    $sid = [Security.Principal.SecurityIdentifier]::new([string]$fields.expectedOwnerSid)
    if ($sid.Value -cne [string]$fields.expectedOwnerSid) { throw 'noncanonical' }
  } catch {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'descriptor-validation' -Fields @('expectedOwnerSid'))
  }

  $environment = $fields.environment
  if ($environment -isnot [System.Collections.IDictionary]) {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'descriptor-validation' -Fields @('environment'))
  }
  $environmentNames = @('SYSTEMROOT', 'WINDIR', 'PATH', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOME')
  $environmentAllowed = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($name in $environmentNames) { [void]$environmentAllowed.Add($name) }
  $environmentSeen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $environmentMap = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($key in $environment.Keys) {
    if ($key -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$key) -or -not $environmentAllowed.Contains([string]$key) -or -not $environmentSeen.Add([string]$key)) {
      throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'descriptor-validation' -Fields @('environment'))
    }
    $value = $environment[$key]
    if ($value -isnot [string] -or ([string]$value).IndexOfAny([char[]]@([char]0, [char]10, [char]13)) -ge 0 -or [string]$key -match '=') {
      throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'descriptor-validation' -Fields @('environment'))
    }
    $environmentMap.Add([string]$key, [string]$value)
  }
  foreach ($name in @('SYSTEMROOT', 'WINDIR', 'PATH', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP')) {
    if (-not $environmentMap.ContainsKey($name)) {
      throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'descriptor-validation' -Fields @('environment'))
    }
  }
  $fields.environment = $environmentMap
  return $fields
}

function Test-PilotWindowsNativeProcessPathUnder {
  param(
    [Parameter(Mandatory)][string] $Path,
    [Parameter(Mandatory)][string] $Root
  )

  $relative = [IO.Path]::GetRelativePath($Root, $Path)
  if ([string]::IsNullOrWhiteSpace($relative) -or $relative -eq '.' -or [IO.Path]::IsPathRooted($relative) -or
      $relative -eq '..' -or $relative.StartsWith('..\', [StringComparison]::Ordinal) -or
      $relative.StartsWith('../', [StringComparison]::Ordinal)) {
    return $false
  }
  return $true
}

function Get-PilotWindowsNativeProcessValidatedPaths {
  param([Parameter(Mandatory)][System.Collections.IDictionary] $Descriptor)

  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.StartFailed' -Stage 'platform-preflight')
  }
  if (-not (Get-Command ConvertTo-PilotCanonicalPath -ErrorAction SilentlyContinue) -or
      -not (Get-Command Get-PilotTemporaryPathProof -ErrorAction SilentlyContinue)) {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.StartFailed' -Stage 'dependency-preflight')
  }

  $runnerTempValue = [Environment]::GetEnvironmentVariable('RUNNER_TEMP', [EnvironmentVariableTarget]::Process)
  if ([string]::IsNullOrWhiteSpace($runnerTempValue)) {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'path-validation' -Fields @('RUNNER_TEMP'))
  }
  try {
    $runnerTemp = ConvertTo-PilotCanonicalPath -Path $runnerTempValue
    $executablePath = ConvertTo-PilotCanonicalPath -Path ([string]$Descriptor.executablePath)
    $workingDirectory = ConvertTo-PilotCanonicalPath -Path ([string]$Descriptor.workingDirectory)
    $profilePath = ConvertTo-PilotCanonicalPath -Path ([string]$Descriptor.profilePath)
  } catch {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'path-validation' -Fields @('executablePath', 'workingDirectory', 'profilePath'))
  }

  if (-not [IO.File]::Exists($executablePath) -or [IO.Path]::GetExtension($executablePath) -ine '.exe' -or
      -not [IO.Directory]::Exists($workingDirectory) -or -not [IO.Directory]::Exists($profilePath)) {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'path-validation' -Fields @('executablePath', 'workingDirectory', 'profilePath'))
  }
  foreach ($entry in @(
      @{ path = $executablePath; name = 'executablePath' },
      @{ path = $workingDirectory; name = 'workingDirectory' },
      @{ path = $profilePath; name = 'profilePath' }
    )) {
    try { [void](Get-PilotTemporaryPathProof -Path $entry.path -RunnerTemp $runnerTemp) } catch {
      throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'path-containment' -Fields @($entry.name))
    }
  }
  $executableDirectory = [IO.Path]::GetDirectoryName($executablePath)
  if ($executableDirectory.Contains(';')) {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'path-validation' -Fields @('executablePath'))
  }

  $windowsDirectoryValue = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
  if ([string]::IsNullOrWhiteSpace($windowsDirectoryValue)) {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.StartFailed' -Stage 'system-path-resolution')
  }
  try {
    $windowsDirectory = ConvertTo-PilotCanonicalPath -Path $windowsDirectoryValue
    $system32 = ConvertTo-PilotCanonicalPath -Path ([IO.Path]::Combine($windowsDirectory, 'System32'))
  } catch {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.StartFailed' -Stage 'system-path-resolution')
  }
  if (-not [IO.Directory]::Exists($system32)) {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.StartFailed' -Stage 'system-path-resolution')
  }

  $environment = $Descriptor.environment
  try {
    $systemRootValue = ConvertTo-PilotCanonicalPath -Path $environment['SYSTEMROOT']
    $windirValue = ConvertTo-PilotCanonicalPath -Path $environment['WINDIR']
  } catch {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'environment-validation' -Fields @('SYSTEMROOT', 'WINDIR'))
  }
  if (-not [string]::Equals($windowsDirectory, $systemRootValue, [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals($windowsDirectory, $windirValue, [StringComparison]::OrdinalIgnoreCase)) {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'environment-validation' -Fields @('SYSTEMROOT', 'WINDIR'))
  }
  if ($system32.Contains(';')) {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'environment-validation' -Fields @('PATH'))
  }
  $expectedPath = $system32 + ';' + $executableDirectory
  if (-not [string]::Equals([string]$environment['PATH'], $expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'environment-validation' -Fields @('PATH'))
  }
  if (-not [string]::Equals([string]$environment['USERPROFILE'], $profilePath, [StringComparison]::OrdinalIgnoreCase) -or
      ($environment.ContainsKey('HOME') -and -not [string]::Equals([string]$environment['HOME'], $profilePath, [StringComparison]::OrdinalIgnoreCase))) {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'environment-validation' -Fields @('USERPROFILE', 'HOME'))
  }
  $profileDirectories = @('APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP')
  $profilePaths = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($name in $profileDirectories) {
    try {
      $path = ConvertTo-PilotCanonicalPath -Path $environment[$name]
    } catch {
      throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'environment-path-validation' -Fields @($name))
    }
    if (-not [IO.Directory]::Exists($path) -or -not (Test-PilotWindowsNativeProcessPathUnder -Path $path -Root $profilePath)) {
      throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'environment-path-containment' -Fields @($name))
    }
    try { [void](Get-PilotTemporaryPathProof -Path $path -RunnerTemp $runnerTemp) } catch {
      throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'environment-path-containment' -Fields @($name))
    }
    $profilePaths.Add($name, $path)
  }
  $hash = (Get-FileHash -LiteralPath $executablePath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
  if (-not [string]::Equals($hash, [string]$Descriptor.executableSha256, [StringComparison]::OrdinalIgnoreCase)) {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidDescriptor' -Stage 'executable-hash-validation' -Fields @('executableSha256'))
  }

  return [pscustomobject]@{
    runnerTemp = $runnerTemp
    executablePath = $executablePath
    workingDirectory = $workingDirectory
    profilePath = $profilePath
    windowsDirectory = $windowsDirectory
    system32 = $system32
    executableSha256 = $hash
  }
}

function Get-PilotWindowsNativeProcessObservedIdentity {
  param(
    [Parameter(Mandatory)][object] $NativeObservation,
    [Parameter(Mandatory)][System.Collections.IDictionary] $Descriptor,
    [Parameter(Mandatory)][string] $ExpectedHash
  )

  if (-not (Get-Command Get-WindowsProcessOwnershipIdentity -ErrorAction SilentlyContinue)) {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.StartFailed' -Stage 'identity-dependency')
  }
  try {
    $identity = Get-WindowsProcessOwnershipIdentity -ProcessId ([int]$NativeObservation.processId)
  } catch {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.StartFailed' -Stage 'cim-observation')
  }

  $mismatches = [Collections.Generic.List[string]]::new()
  if ([int]$identity.processId -ne [int]$NativeObservation.processId) { [void]$mismatches.Add('processId') }
  try {
    $expectedPath = ConvertTo-PilotCanonicalPath -Path ([string]$Descriptor.executablePath)
    $nativePath = ConvertTo-PilotCanonicalPath -Path ([string]$NativeObservation.executablePath)
    $cimPath = ConvertTo-PilotCanonicalPath -Path ([string]$identity.executablePath)
    if (-not [string]::Equals($expectedPath, $nativePath, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($expectedPath, $cimPath, [StringComparison]::OrdinalIgnoreCase)) {
      [void]$mismatches.Add('executablePath')
    }
  } catch { [void]$mismatches.Add('executablePath') }
  try {
    $nativeTime = [DateTime]::Parse([string]$NativeObservation.creationTimeUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
    $cimTime = [DateTime]::Parse([string]$identity.creationTimeUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
    if ([Math]::Abs(($nativeTime - $cimTime).Ticks) -gt 20) { [void]$mismatches.Add('creationTimeUtc') }
  } catch { [void]$mismatches.Add('creationTimeUtc') }
  if (-not [string]::Equals([string]$identity.executableSha256, $ExpectedHash, [StringComparison]::OrdinalIgnoreCase)) {
    [void]$mismatches.Add('executableSha256')
  }
  if ([int]$identity.parentProcessId -ne [int]$Descriptor.expectedParentProcessId) { [void]$mismatches.Add('parentProcessId') }
  if ([string]$identity.ownerSid -cne [string]$Descriptor.expectedOwnerSid) { [void]$mismatches.Add('ownerSid') }
  if ($mismatches.Count -gt 0) {
    $errorId = if ($mismatches.Contains('ownerSid') -or $mismatches.Contains('parentProcessId')) {
      'Morrow.WindowsNativeProcess.IdentityMismatch'
    } else {
      'Morrow.WindowsNativeProcess.StartFailed'
    }
    throw (New-PilotWindowsNativeProcessException -ErrorId $errorId -Stage 'identity-comparison' -Fields $mismatches.ToArray())
  }
  return $identity
}

function Start-WindowsNativeProcess {
  [CmdletBinding()]
  param(
    [AllowNull()][object] $Descriptor
  )

  $stage = 'descriptor-validation'
  $session = $null
  $capsule = $null
  try {
    $descriptorMap = Get-PilotWindowsNativeProcessDescriptor -Descriptor $Descriptor
    $stage = 'path-validation'
    $validatedPaths = Get-PilotWindowsNativeProcessValidatedPaths -Descriptor $descriptorMap

    if (-not (Get-Command CreateAtomicSuspendedRoot -ErrorAction SilentlyContinue) -or
        -not (Get-Command Get-WindowsProcessOwnershipIdentity -ErrorAction SilentlyContinue)) {
      throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.StartFailed' -Stage 'dependency-preflight')
    }
    $stage = 'suspended-create'
    $environment = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($key in $descriptorMap.environment.Keys) { $environment.Add([string]$key, [string]$descriptorMap.environment[$key]) }
    $session = CreateAtomicSuspendedRoot `
      -ExecutablePath $validatedPaths.executablePath `
      -ArgumentList ([string[]]$descriptorMap.argumentList) `
      -Environment $environment `
      -WorkingDirectory $validatedPaths.workingDirectory
    $stage = 'native-observation'
    $nativeObservation = $session.ObserveRoot()
    if ($null -eq $nativeObservation -or
        [string]$nativeObservation.state -cne 'suspended' -or
        -not [bool]$nativeObservation.isMember -or
        -not [bool]$nativeObservation.wasAssociatedAtCreation -or
        [uint32]$nativeObservation.jobLimitFlags -ne [uint32]8192 -or
        [bool]$nativeObservation.jobHandleInheritable) {
      throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.StartFailed' -Stage 'native-observation' -Fields @('state', 'membership', 'jobPolicy'))
    }

    $stage = 'job-membership'
    $members = @($session.ListMemberIds())
    $rootMember = $false
    foreach ($memberId in $members) {
      if ([uint32]$memberId -eq [uint32]$nativeObservation.processId) { $rootMember = $true; break }
    }
    if (-not $rootMember) {
      throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.StartFailed' -Stage 'job-membership' -Fields @('processId'))
    }

    $stage = 'identity-comparison'
    $observedIdentity = Get-PilotWindowsNativeProcessObservedIdentity `
      -NativeObservation $nativeObservation `
      -Descriptor $descriptorMap `
      -ExpectedHash $validatedPaths.executableSha256
    Initialize-PilotWindowsNativeProcessCapsuleInterop
    $nativeSessionType = 'Morrow.Pilot.WindowsNativeJobSession' -as [type]
    if ($null -eq $nativeSessionType -or $session.GetType() -ne $nativeSessionType) {
      throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.StartFailed' -Stage 'capsule-create')
    }
    $capsuleType = 'Morrow.Pilot.WindowsNativeProcessCapsule' -as [type]
    $constructor = $capsuleType.GetConstructor(
      [Reflection.BindingFlags]::Instance -bor [Reflection.BindingFlags]::NonPublic,
      $null,
      [type[]]@([object], [object[]]),
      $null
    )
    if ($null -eq $constructor) {
      throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.StartFailed' -Stage 'capsule-create')
    }
    $identitySnapshot = [object[]]@(
      [int]$observedIdentity.processId,
      [int]$observedIdentity.parentProcessId,
      [string]$observedIdentity.executablePath,
      [string]$observedIdentity.executableSha256,
      [string]$observedIdentity.creationTimeUtc,
      [string]$observedIdentity.ownerSid
    )
    $constructorArguments = [object[]]::new(2)
    $constructorArguments[0] = $session
    $constructorArguments[1] = $identitySnapshot
    $capsule = $constructor.Invoke($constructorArguments)
    Write-Verbose 'Morrow.WindowsNativeProcess.IdentityProof: native and CIM identity tuple, descriptor owner and parent, suspended state, Job membership, and Job policy matched.'

    $stage = 'resume'
    $resume = $session.Resume()
    if ($null -eq $resume -or -not [bool]$resume.resumed -or
        [uint32]$resume.rootProcessId -ne [uint32]$nativeObservation.processId -or
        [uint32]$resume.previousSuspendCount -ne [uint32]1 -or
        [string]$resume.state -cne 'resume-requested') {
      throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.StartFailed' -Stage 'resume' -Fields @('resumeResult'))
    }
    try { Write-Verbose 'Morrow.WindowsNativeProcess.Resume: internal resume succeeded with previous suspend count one.' } catch { }

    $session = $null
    return ,$capsule
  } catch {
    $caught = $_.Exception
    $originalId = Get-PilotWindowsNativeProcessErrorId -Exception $caught
    $caughtDiagnostics = Get-PilotWindowsNativeProcessDiagnostics -Exception $caught
    $failedStage = if ($null -ne $caughtDiagnostics -and $caughtDiagnostics.stage) { [string]$caughtDiagnostics.stage } else { $stage }
    $fields = if ($null -ne $caughtDiagnostics -and $caughtDiagnostics.fields) { @($caughtDiagnostics.fields) } else { @() }
    $cleanup = $null
    $disposeFailed = $false
    if ($null -ne $capsule) {
      try {
        $cleanupResult = $capsule.Dispose()
        $cleanup = [ordered]@{ attempted = $true; jobEmpty = [bool]$cleanupResult.jobEmpty; rootExited = [bool]$cleanupResult.rootExited }
      } catch {
        $disposeFailed = $true
        $cleanupException = $_.Exception
        $cleanupDiagnostics = Get-PilotWindowsNativeProcessDiagnostics -Exception $cleanupException
        if ($null -ne $cleanupDiagnostics -and $cleanupDiagnostics['cleanup']) {
          $cleanup = $cleanupDiagnostics['cleanup']
          if ($cleanup -is [System.Collections.IDictionary]) { $cleanup['disposeFailed'] = $true }
        } else {
          $cleanup = [ordered]@{ attempted = $true; jobEmpty = $false; rootExited = $false; disposeFailed = $true }
        }
      }
      $session = $null
    } elseif ($null -ne $session) {
      $cleanup = [ordered]@{ attempted = $true; jobEmpty = $false; rootExited = $false }
      try {
        $stop = $session.StopAndWait(10000)
        $cleanup = [ordered]@{ attempted = $true; jobEmpty = [bool]$stop.jobEmpty; rootExited = [bool]$stop.rootExited }
        try { $session.Dispose() } catch {
          $disposeFailed = $true
          $cleanup['disposeFailed'] = $true
        }
      } catch {
        try { $session.Dispose() } catch {
          $disposeFailed = $true
          $cleanup['disposeFailed'] = $true
        }
      }
      $session = $null
    }
    $errorId = if ($originalId -in @(
        'Morrow.WindowsNativeProcess.InvalidDescriptor',
        'Morrow.WindowsNativeProcess.IdentityMismatch',
        'Morrow.WindowsNativeProcess.StartFailed'
      )) { $originalId } else { 'Morrow.WindowsNativeProcess.StartFailed' }
    $cleanupDisposeFailed = $false
    if ($cleanup -is [System.Collections.IDictionary] -and $cleanup.Contains('disposeFailed')) {
      $cleanupDisposeFailed = [bool]$cleanup['disposeFailed']
    }
    if ($null -ne $cleanup -and (-not [bool]$cleanup['jobEmpty'] -or -not [bool]$cleanup['rootExited'] -or $disposeFailed -or $cleanupDisposeFailed)) {
      $errorId = 'Morrow.WindowsNativeProcess.CleanupIncomplete'
      $failedStage = 'cleanup'
    }
    $diagnostics = [ordered]@{
      stage = $failedStage
      cause = $originalId
      fields = @($fields)
    }
    if ($null -ne $cleanup) { $diagnostics.cleanup = $cleanup }
    if ($errorId -eq 'Morrow.WindowsNativeProcess.CleanupIncomplete') { $diagnostics.originalErrorId = $originalId }
    $errorRecord = [System.Management.Automation.ErrorRecord]::new(
      [InvalidOperationException]::new('The Windows native process policy operation failed.'),
      $errorId,
      [System.Management.Automation.ErrorCategory]::InvalidOperation,
      $null
    )
    $errorRecord.Exception.Data['Morrow.WindowsNativeProcess.Diagnostics'] = $diagnostics
    $PSCmdlet.ThrowTerminatingError($errorRecord)
  }
}
