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
    private sealed class ObservationToken
    {
      internal readonly WindowsNativeProcessCapsule owner;
      internal readonly object session;
      internal readonly long generation;
      internal readonly object[] identitySnapshot;

      internal ObservationToken(WindowsNativeProcessCapsule owner, object session, long generation, object[] identitySnapshot)
      {
        this.owner = owner;
        this.session = session;
        this.generation = generation;
        this.identitySnapshot = (object[])identitySnapshot.Clone();
      }
    }

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
    private long _generation = 1;

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

    private object CaptureObservationToken()
    {
      lock (_sync)
      {
        if (_finished || _completed || _session == null)
          throw new InvalidOperationException("The process capsule is no longer active.");
        return new ObservationToken(this, _session, _generation, new object[]
        {
          _identitySnapshot.processId,
          _identitySnapshot.parentProcessId,
          _identitySnapshot.executablePath,
          _identitySnapshot.executableSha256,
          _identitySnapshot.creationTimeUtc,
          _identitySnapshot.ownerSid
        });
      }
    }

    private object ReadObservationState(object value)
    {
      lock (_sync)
      {
        ObservationToken token = value as ObservationToken;
        if (token == null || !Object.ReferenceEquals(token.owner, this) ||
            _finished || _completed || _session == null ||
            token.generation != _generation || !Object.ReferenceEquals(token.session, _session))
          throw new InvalidOperationException("The process capsule observation is no longer current.");

        Type sessionType = _session.GetType();
        MethodInfo observeRoot = sessionType.GetMethod("ObserveRoot", Type.EmptyTypes);
        MethodInfo listMembers = sessionType.GetMethod("ListMemberIds", Type.EmptyTypes);
        if (observeRoot == null || listMembers == null)
          throw new InvalidOperationException("The owned session does not expose read-only observation.");

        object root = observeRoot.Invoke(_session, null);
        object rawMembers = listMembers.Invoke(_session, null);
        uint[] memberIds = rawMembers as uint[];
        if (root == null || memberIds == null)
          throw new InvalidOperationException("The owned session returned an incomplete observation.");
        var state = new System.Collections.Hashtable();
        state["root"] = root;
        state["memberIds"] = (uint[])memberIds.Clone();
        state["identitySnapshot"] = (object[])token.identitySnapshot.Clone();
        state["generation"] = token.generation;
        return state;
      }
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
          _generation++;
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

# Internal helpers keep assertion normalization and comparison available to
# Observe and Stop without adding a process-control command surface.
function ConvertTo-PilotWindowsNativeProcessAssertionPath {
  param([Parameter(Mandatory)][string] $Path)

  # Assertion paths are normalized lexically only. In particular, do not test
  # whether the asserted image exists or inspect any filesystem attributes.
  if ([string]::IsNullOrWhiteSpace($Path) -or $Path -notmatch '\A[A-Za-z]:\\') {
    throw [FormatException]::new('The assertion path is not a local absolute Windows path.')
  }
  # The colon in the validated drive prefix is required. Apply Windows-invalid
  # filename characters and ASCII controls only to the path remainder.
  $pathRemainder = $Path.Substring(3)
  $forbiddenPathCharacters = [char[]]@('<', '>', ':', '"', '|', '?', '*', '/') +
    [char[]](0..31 | ForEach-Object { [char]$_ })
  if ($pathRemainder.IndexOfAny([char[]]$forbiddenPathCharacters) -ge 0) {
    throw [FormatException]::new('The assertion path contains a noncanonical Windows path character.')
  }

  $segments = $pathRemainder.Split([char[]]@('\'))
  if ($segments.Count -eq 0) {
    throw [FormatException]::new('The assertion path has no path component.')
  }
  foreach ($segment in $segments) {
    if ([string]::IsNullOrEmpty($segment) -or $segment -eq '.' -or $segment -eq '..' -or
        $segment.Contains(':') -or $segment.EndsWith('.') -or $segment.EndsWith(' ')) {
      throw [FormatException]::new('The assertion path contains a noncanonical path component.')
    }
  }

  try {
    $fullPath = [IO.Path]::GetFullPath($Path)
  } catch {
    throw [FormatException]::new('The assertion path cannot be normalized lexically.')
  }
  if (-not [string]::Equals($fullPath, $Path, [StringComparison]::OrdinalIgnoreCase)) {
    throw [FormatException]::new('The assertion path is not in canonical form.')
  }
  return $fullPath
}

function ConvertTo-PilotWindowsNativeProcessAssertionUtcTicks {
  param([Parameter(Mandatory)][string] $Value)

  $iso8601WithZone = '\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,7})?(?:Z|[+-][0-9]{2}:[0-9]{2})\z'
  if ($Value -notmatch $iso8601WithZone) {
    throw [FormatException]::new('The assertion timestamp must be ISO 8601 with an explicit time zone.')
  }
  try {
    $timestamp = [DateTimeOffset]::Parse(
      $Value,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::None
    )
  } catch {
    throw [FormatException]::new('The assertion timestamp is not a valid ISO 8601 instant.')
  }
  return [long]$timestamp.UtcDateTime.Ticks
}

function ConvertTo-PilotWindowsNativeProcessIdentityAssertion {
  [CmdletBinding()]
  param([AllowNull()][object] $IdentityAssertion)

  $normalized = [ordered]@{}
  if ($null -eq $IdentityAssertion) { return ,$normalized }
  if ($IdentityAssertion -isnot [System.Collections.IDictionary]) {
    throw (New-PilotWindowsNativeProcessException `
      -ErrorId 'Morrow.WindowsNativeProcess.InvalidIdentityAssertion' `
      -Stage 'identity-assertion-validation')
  }

  $canonicalNames = @(
    'processId', 'parentProcessId', 'executablePath', 'executableSha256', 'creationTimeUtc', 'ownerSid'
  )
  $canonicalByName = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($name in $canonicalNames) { $canonicalByName.Add($name, $name) }
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)

  # Read the real dictionary Keys property through PSBase so entries named
  # Count or Keys cannot shadow PowerShell's adapted members.
  $assertionKeys = [Collections.Generic.List[object]]::new()
  try {
    foreach ($key in $IdentityAssertion.PSBase.Keys) { $assertionKeys.Add($key) }
  } catch {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidIdentityAssertion' -Stage 'identity-assertion-validation')
  }
  if ($assertionKeys.Count -eq 0) { return ,$normalized }

  $integralTypes = @([byte], [sbyte], [short], [ushort], [int], [uint32], [long], [ulong])
  foreach ($key in $assertionKeys) {
    if ($key -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$key) -or
        -not $canonicalByName.ContainsKey([string]$key) -or -not $seen.Add([string]$key)) {
      throw (New-PilotWindowsNativeProcessException `
        -ErrorId 'Morrow.WindowsNativeProcess.InvalidIdentityAssertion' `
        -Stage 'identity-assertion-validation')
    }

    $name = $canonicalByName[[string]$key]
    try {
      $value = $IdentityAssertion[$key]
    } catch {
      throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.InvalidIdentityAssertion' -Stage 'identity-assertion-validation' -Fields @($name))
    }
    if ($null -eq $value) {
      throw (New-PilotWindowsNativeProcessException `
        -ErrorId 'Morrow.WindowsNativeProcess.InvalidIdentityAssertion' `
        -Stage 'identity-assertion-validation' `
        -Fields @($name))
    }

    switch ($name) {
      'processId' {
        try {
          if ($value.GetType() -notin $integralTypes) { throw 'invalid' }
          $number = [decimal]$value
          if ($number -lt 1 -or $number -gt [int]::MaxValue) { throw 'invalid' }
          $normalized[$name] = [int]$number
        } catch {
          throw (New-PilotWindowsNativeProcessException `
            -ErrorId 'Morrow.WindowsNativeProcess.InvalidIdentityAssertion' `
            -Stage 'identity-assertion-validation' `
            -Fields @($name))
        }
      }
      'parentProcessId' {
        try {
          if ($value.GetType() -notin $integralTypes) { throw 'invalid' }
          $number = [decimal]$value
          if ($number -lt 1 -or $number -gt [int]::MaxValue) { throw 'invalid' }
          $normalized[$name] = [int]$number
        } catch {
          throw (New-PilotWindowsNativeProcessException `
            -ErrorId 'Morrow.WindowsNativeProcess.InvalidIdentityAssertion' `
            -Stage 'identity-assertion-validation' `
            -Fields @($name))
        }
      }
      'executablePath' {
        try {
          if ($value -isnot [string]) { throw 'invalid' }
          $normalized[$name] = ConvertTo-PilotWindowsNativeProcessAssertionPath -Path $value
        } catch {
          throw (New-PilotWindowsNativeProcessException `
            -ErrorId 'Morrow.WindowsNativeProcess.InvalidIdentityAssertion' `
            -Stage 'identity-assertion-validation' `
            -Fields @($name))
        }
      }
      'executableSha256' {
        if ($value -isnot [string] -or $value -notmatch '\A[A-Fa-f0-9]{64}\z') {
          throw (New-PilotWindowsNativeProcessException `
            -ErrorId 'Morrow.WindowsNativeProcess.InvalidIdentityAssertion' `
            -Stage 'identity-assertion-validation' `
            -Fields @($name))
        }
        $normalized[$name] = $value.ToLowerInvariant()
      }
      'creationTimeUtc' {
        try {
          if ($value -isnot [string]) { throw 'invalid' }
          $normalized[$name] = ConvertTo-PilotWindowsNativeProcessAssertionUtcTicks -Value $value
        } catch {
          throw (New-PilotWindowsNativeProcessException `
            -ErrorId 'Morrow.WindowsNativeProcess.InvalidIdentityAssertion' `
            -Stage 'identity-assertion-validation' `
            -Fields @($name))
        }
      }
      'ownerSid' {
        try {
          if ($value -isnot [string] -or [string]::IsNullOrWhiteSpace($value)) { throw 'invalid' }
          $sid = [Security.Principal.SecurityIdentifier]::new($value)
          if ($sid.Value -cne $value) { throw 'noncanonical' }
          $normalized[$name] = $sid.Value
        } catch {
          throw (New-PilotWindowsNativeProcessException `
            -ErrorId 'Morrow.WindowsNativeProcess.InvalidIdentityAssertion' `
            -Stage 'identity-assertion-validation' `
            -Fields @($name))
        }
      }
    }
  }

  return ,$normalized
}

function Compare-PilotWindowsNativeProcessIdentityAssertion {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][System.Collections.IDictionary] $NormalizedAssertion,
    [AllowNull()][object] $ObservedIdentity
  )

  if ($NormalizedAssertion.Count -eq 0) { return }
  if ($null -eq $ObservedIdentity) {
    # The caller classifies an unavailable observation; do not silently pass a
    # nonempty assertion or turn it into an identity mismatch here.
    throw [InvalidOperationException]::new('An observed process identity is required for assertion comparison.')
  }

  $mismatches = [Collections.Generic.List[string]]::new()
  foreach ($name in @(
      'processId', 'parentProcessId', 'executablePath', 'executableSha256', 'creationTimeUtc', 'ownerSid'
    )) {
    if (-not $NormalizedAssertion.Contains($name)) { continue }
    $property = $ObservedIdentity.PSObject.Properties[$name]
    if ($null -eq $property -or $null -eq $property.Value) {
      [void]$mismatches.Add($name)
      continue
    }

    $matches = $false
    try {
      switch ($name) {
        { $_ -in @('processId', 'parentProcessId') } {
          $actual = $property.Value
          $integralTypes = @([byte], [sbyte], [short], [ushort], [int], [uint32], [long], [ulong])
          if ($actual.GetType() -in $integralTypes) {
            $actualNumber = [decimal]$actual
            $matches = ($actualNumber -ge 1 -and $actualNumber -le [int]::MaxValue -and
              [int]$actualNumber -eq [int]$NormalizedAssertion[$name])
          }
          break
        }
        'executablePath' {
          if ($property.Value -is [string]) {
            $actualPath = ConvertTo-PilotWindowsNativeProcessAssertionPath -Path $property.Value
            $matches = [string]::Equals(
              [string]$NormalizedAssertion[$name],
              $actualPath,
              [StringComparison]::OrdinalIgnoreCase
            )
          }
          break
        }
        'executableSha256' {
          if ($property.Value -is [string] -and $property.Value -match '\A[A-Fa-f0-9]{64}\z') {
            $matches = [string]::Equals(
              [string]$NormalizedAssertion[$name],
              $property.Value,
              [StringComparison]::OrdinalIgnoreCase
            )
          }
          break
        }
        'creationTimeUtc' {
          if ($property.Value -is [string]) {
            $actualTicks = ConvertTo-PilotWindowsNativeProcessAssertionUtcTicks -Value $property.Value
            $matches = [long]$NormalizedAssertion[$name] -eq [long]$actualTicks
          }
          break
        }
        'ownerSid' {
          if ($property.Value -is [string]) {
            $actualSid = [Security.Principal.SecurityIdentifier]::new($property.Value)
            $matches = ($actualSid.Value -ceq $property.Value -and
              [string]::Equals([string]$NormalizedAssertion[$name], $actualSid.Value, [StringComparison]::Ordinal))
          }
          break
        }
      }
    } catch {
      $matches = $false
    }
    if (-not $matches) { [void]$mismatches.Add($name) }
  }

  if ($mismatches.Count -gt 0) {
    throw (New-PilotWindowsNativeProcessException `
      -ErrorId 'Morrow.WindowsNativeProcess.IdentityMismatch' `
      -Stage 'identity-assertion-comparison' `
      -Fields $mismatches.ToArray())
  }
}

function ConvertFrom-PilotWindowsNativeProcessObservationMembers {
  param([AllowNull()][object] $MemberIds)

  $ids = [Collections.Generic.List[int]]::new()
  $seen = [Collections.Generic.HashSet[int]]::new()
  $invalidCount = 0
  if ($MemberIds -isnot [Array]) {
    $invalidCount++
  } else {
    $integralTypes = @([byte], [sbyte], [short], [ushort], [int], [uint32], [long], [ulong])
    foreach ($value in $MemberIds) {
      try {
        if ($null -eq $value -or $value.GetType() -notin $integralTypes) { throw 'invalid' }
        $number = [decimal]$value
        if ($number -lt 1 -or $number -gt [int]::MaxValue) { throw 'invalid' }
        $processId = [int]$number
        if ($seen.Add($processId)) { [void]$ids.Add($processId) }
      } catch {
        $invalidCount++
      }
    }
  }

  return [pscustomobject][ordered]@{
    ids = $ids.ToArray()
    invalidCount = $invalidCount
  }
}

function Get-PilotWindowsNativeProcessObservationCimTimeoutSeconds {
  param(
    [Parameter(Mandatory)][Diagnostics.Stopwatch] $Clock,
    [Parameter(Mandatory)][ValidateRange(1, 120000)][int] $DeadlineMilliseconds,
    [ValidateRange(1, 5)][int] $MaximumSeconds = 5
  )

  $remainingMilliseconds = [Math]::Floor($DeadlineMilliseconds - $Clock.Elapsed.TotalMilliseconds)
  if ($remainingMilliseconds -lt 1000) { return 0 }
  return [int][Math]::Min($MaximumSeconds, [Math]::Floor($remainingMilliseconds / 1000.0))
}

function Get-PilotWindowsNativeProcessObservationCimBatch {
  param(
    [AllowEmptyCollection()][Parameter(Mandatory)][int[]] $OwnedProcessIds,
    [Parameter(Mandatory)][Diagnostics.Stopwatch] $Clock,
    [Parameter(Mandatory)][ValidateRange(1, 120000)][int] $DeadlineMilliseconds
  )

  $queryIds = [Collections.Generic.List[int]]::new()
  $seen = [Collections.Generic.HashSet[int]]::new()
  foreach ($processId in $OwnedProcessIds) {
    if ($processId -gt 0 -and $seen.Add($processId)) { [void]$queryIds.Add($processId) }
  }
  $truncated = $queryIds.Count -gt 64
  if ($truncated) {
    $limitedIds = [Collections.Generic.List[int]]::new()
    for ($index = 0; $index -lt 64; $index++) { [void]$limitedIds.Add($queryIds[$index]) }
    $queryIds = $limitedIds
  }
  if ($queryIds.Count -eq 0) {
    return [pscustomobject][ordered]@{ succeeded = $true; rows = @(); queriedIds = @(); truncated = $truncated; failure = $null }
  }

  $timeoutSeconds = Get-PilotWindowsNativeProcessObservationCimTimeoutSeconds `
    -Clock $Clock -DeadlineMilliseconds $DeadlineMilliseconds
  if ($timeoutSeconds -le 0 -or -not (Get-Command Get-CimInstance -ErrorAction SilentlyContinue)) {
    return [pscustomobject][ordered]@{ succeeded = $false; rows = @(); queriedIds = $queryIds.ToArray(); truncated = $truncated; failure = 'deadline-or-command-unavailable' }
  }

  $filter = (@($queryIds | ForEach-Object { 'ProcessId = ' + [string][int]$_ }) -join ' OR ')
  try {
    $rows = @(Get-CimInstance -ClassName Win32_Process -Filter $filter -OperationTimeoutSec $timeoutSeconds -ErrorAction Stop)
    if ($Clock.Elapsed.TotalMilliseconds -ge $DeadlineMilliseconds) {
      return [pscustomobject][ordered]@{ succeeded = $false; rows = @(); queriedIds = $queryIds.ToArray(); truncated = $truncated; failure = 'deadline-exceeded' }
    }
    return [pscustomobject][ordered]@{ succeeded = $true; rows = $rows; queriedIds = $queryIds.ToArray(); truncated = $truncated; failure = $null }
  } catch {
    return [pscustomobject][ordered]@{ succeeded = $false; rows = @(); queriedIds = $queryIds.ToArray(); truncated = $truncated; failure = 'cim-query-failed' }
  }
}

function Get-PilotWindowsNativeProcessObservationCimMetadata {
  param(
    [Parameter(Mandatory)][object] $ProcessRow,
    [Parameter(Mandatory)][int] $ExpectedProcessId
  )

  try {
    $processIdProperty = $ProcessRow.PSObject.Properties['ProcessId']
    if ($null -eq $processIdProperty -or $null -eq $processIdProperty.Value) { return $null }
    $integralTypes = @([byte], [sbyte], [short], [ushort], [int], [uint32], [long], [ulong])
    if ($processIdProperty.Value.GetType() -notin $integralTypes) { return $null }
    $processIdNumber = [decimal]$processIdProperty.Value
    if ($processIdNumber -lt 1 -or $processIdNumber -gt [int]::MaxValue -or [int]$processIdNumber -ne $ExpectedProcessId) { return $null }

    $parentProcessId = $null
    $parentProperty = $ProcessRow.PSObject.Properties['ParentProcessId']
    if ($null -ne $parentProperty -and $null -ne $parentProperty.Value -and
        $parentProperty.Value.GetType() -in $integralTypes) {
      $parentNumber = [decimal]$parentProperty.Value
      if ($parentNumber -ge 1 -and $parentNumber -le [int]::MaxValue) { $parentProcessId = [int]$parentNumber }
    }

    $creationTimeUtc = $null
    $creationProperty = $ProcessRow.PSObject.Properties['CreationDate']
    if ($null -ne $creationProperty -and $null -ne $creationProperty.Value) {
      try {
        if ($creationProperty.Value -is [datetime]) {
          $creationTimeUtc = $creationProperty.Value.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)
        } elseif ($creationProperty.Value -is [string]) {
          $creationTimeUtc = [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$creationProperty.Value).ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)
        }
      } catch { $creationTimeUtc = $null }
    }

    $name = $null
    $nameProperty = $ProcessRow.PSObject.Properties['Name']
    if ($null -ne $nameProperty -and $nameProperty.Value -is [string] -and
        -not [string]::IsNullOrWhiteSpace([string]$nameProperty.Value)) {
      $name = [string]$nameProperty.Value
    }

    return [pscustomobject][ordered]@{
      processId = [int]$processIdNumber
      parentProcessId = $parentProcessId
      name = $name
      creationTimeUtc = $creationTimeUtc
    }
  } catch {
    return $null
  }
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

function Get-PilotWindowsNativeProcessImageProof {
  param(
    [Parameter(Mandatory)][object] $NativeObservation,
    [Parameter(Mandatory)][string] $ExpectedExecutablePath,
    [Parameter(Mandatory)][string] $ExpectedHash
  )

  try {
    $expectedPath = ConvertTo-PilotCanonicalPath -Path $ExpectedExecutablePath
    $nativePath = ConvertTo-PilotCanonicalPath -Path ([string]$NativeObservation.executablePath)
    if (-not [string]::Equals($expectedPath, $nativePath, [StringComparison]::OrdinalIgnoreCase)) { throw 'image mismatch' }
  } catch {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.StartFailed' -Stage 'identity-comparison' -Fields @('executablePath'))
  }
  # Hash only the known validated executable after the suspended process has been created.
  try {
    $freshHash = (Get-FileHash -LiteralPath $expectedPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
  } catch {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.StartFailed' -Stage 'identity-comparison' -Fields @('executableSha256'))
  }
  $freshHash = Confirm-PilotWindowsNativeProcessHash -ExpectedHash $ExpectedHash -ObservedHash $freshHash
  return [pscustomobject][ordered]@{ executablePath = $nativePath; executableSha256 = $freshHash }
}

function Confirm-PilotWindowsNativeProcessHash {
  param(
    [Parameter(Mandatory)][string] $ExpectedHash,
    [Parameter(Mandatory)][string] $ObservedHash
  )

  if ($ExpectedHash -notmatch '^[A-Fa-f0-9]{64}$' -or
      $ObservedHash -notmatch '^[A-Fa-f0-9]{64}$' -or
      -not [string]::Equals($ObservedHash, $ExpectedHash, [StringComparison]::OrdinalIgnoreCase)) {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.StartFailed' -Stage 'identity-comparison' -Fields @('executableSha256'))
  }
  return $ObservedHash.ToLowerInvariant()
}

function Get-PilotWindowsNativeProcessCimRow {
  param(
    [Parameter(Mandatory)][AllowEmptyCollection()][object[]] $ProcessRows,
    [Parameter(Mandatory)][int] $ProcessId
  )

  if ($ProcessRows.Count -ne 1 -or $null -eq $ProcessRows[0]) {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.StartFailed' -Stage 'cim-observation' -Fields @('processId'))
  }
  $process = $ProcessRows[0]
  try {
    $processIdProperty = $process.PSObject.Properties['ProcessId']
    if ($null -eq $processIdProperty -or $null -eq $processIdProperty.Value) { throw 'missing' }
    if ([int]$processIdProperty.Value -ne $ProcessId) { throw 'mismatch' }
  } catch {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.StartFailed' -Stage 'cim-observation' -Fields @('processId'))
  }
  return $process
}

function New-PilotWindowsNativeProcessIdentityFromCim {
  param(
    [Parameter(Mandatory)][object] $ProcessRow,
    [AllowNull()][object] $OwnerResult,
    [Parameter(Mandatory)][object] $NativeObservation,
    [Parameter(Mandatory)][object] $ImageProof
  )

  $invalidFields = [Collections.Generic.List[string]]::new()
  $processId = [int]$ProcessRow.ProcessId
  $parentProcessId = $null
  try {
    $parentProperty = $ProcessRow.PSObject.Properties['ParentProcessId']
    if ($null -eq $parentProperty -or $null -eq $parentProperty.Value) { throw 'missing' }
    $parentProcessId = [int]$parentProperty.Value
    if ($parentProcessId -lt 1) { throw 'invalid' }
  } catch {
    [void]$invalidFields.Add('parentProcessId')
  }

  $creationTimeUtc = $null
  try {
    $creationProperty = $ProcessRow.PSObject.Properties['CreationDate']
    if ($null -eq $creationProperty -or $null -eq $creationProperty.Value) { throw 'missing' }
    $creationValue = $creationProperty.Value
    if ($creationValue -is [datetime]) {
      $cimTime = $creationValue.ToUniversalTime()
    } elseif ($creationValue -is [string] -and -not [string]::IsNullOrEmpty($creationValue)) {
      $cimTime = [System.Management.ManagementDateTimeConverter]::ToDateTime($creationValue).ToUniversalTime()
    } else {
      throw 'invalid'
    }
    $nativeTime = [DateTime]::Parse(
      [string]$NativeObservation.creationTimeUtc,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind
    ).ToUniversalTime()
    if ([Math]::Abs(($nativeTime - $cimTime).Ticks) -gt 20) { throw 'mismatch' }
    $creationTimeUtc = $cimTime.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
  } catch {
    [void]$invalidFields.Add('creationTimeUtc')
  }

  $ownerSid = $null
  try {
    if ($null -eq $OwnerResult) { throw 'missing' }
    $returnValueProperty = $OwnerResult.PSObject.Properties['ReturnValue']
    $sidProperty = $OwnerResult.PSObject.Properties['Sid']
    if ($null -eq $returnValueProperty -or $null -eq $returnValueProperty.Value -or
        $null -eq $sidProperty -or $null -eq $sidProperty.Value) { throw 'missing' }
    $integralTypes = @([byte], [sbyte], [short], [ushort], [int], [uint32], [long], [ulong])
    if ($returnValueProperty.Value.GetType() -notin $integralTypes -or [decimal]$returnValueProperty.Value -ne 0) { throw 'invalid' }
    if ($sidProperty.Value -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$sidProperty.Value)) { throw 'invalid' }
    $ownerSid = [string]$sidProperty.Value
    $sid = [Security.Principal.SecurityIdentifier]::new($ownerSid)
    if ($sid.Value -cne $ownerSid) { throw 'noncanonical' }
  } catch {
    [void]$invalidFields.Add('ownerSid')
  }

  $imagePathProperty = $ImageProof.PSObject.Properties['executablePath']
  $imageHashProperty = $ImageProof.PSObject.Properties['executableSha256']
  if ($null -eq $imagePathProperty -or $null -eq $imageHashProperty -or
      [string]::IsNullOrWhiteSpace([string]$imagePathProperty.Value) -or
      [string]$imageHashProperty.Value -notmatch '^[A-Fa-f0-9]{64}$') {
    [void]$invalidFields.Add('executableSha256')
  }

  # ImageProof already ties the native image to the validated staged path.
  $pathProperty = $ProcessRow.PSObject.Properties['ExecutablePath']
  $cimPath = $null
  if ($null -ne $pathProperty -and $null -ne $pathProperty.Value) {
    if ($pathProperty.Value -isnot [string]) {
      [void]$invalidFields.Add('executablePath')
    } else {
      $cimPath = [string]$pathProperty.Value
    }
  }
  if (-not [string]::IsNullOrEmpty($cimPath)) {
    try {
      $canonicalCimPath = ConvertTo-PilotCanonicalPath -Path $cimPath
      if (-not [string]::Equals($canonicalCimPath, [string]$imagePathProperty.Value, [StringComparison]::OrdinalIgnoreCase)) {
        [void]$invalidFields.Add('executablePath')
      }
    } catch {
      [void]$invalidFields.Add('executablePath')
    }
  }

  if ($invalidFields.Count -gt 0) {
    $uniqueFields = @($invalidFields | Select-Object -Unique)
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.StartFailed' -Stage 'identity-comparison' -Fields $uniqueFields)
  }
  return [pscustomobject][ordered]@{
    processId = $processId
    parentProcessId = $parentProcessId
    executablePath = [string]$imagePathProperty.Value
    executableSha256 = ([string]$imageHashProperty.Value).ToLowerInvariant()
    creationTimeUtc = $creationTimeUtc
    ownerSid = $ownerSid
  }
}

function Get-PilotWindowsNativeProcessObservedIdentity {
  param(
    [Parameter(Mandatory)][object] $NativeObservation,
    [Parameter(Mandatory)][System.Collections.IDictionary] $Descriptor,
    [Parameter(Mandatory)][string] $ExpectedExecutablePath,
    [Parameter(Mandatory)][string] $ExpectedHash
  )

  $imageProof = Get-PilotWindowsNativeProcessImageProof `
    -NativeObservation $NativeObservation `
    -ExpectedExecutablePath $ExpectedExecutablePath `
    -ExpectedHash $ExpectedHash
  try {
    $processRows = @(Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + [string][int]$NativeObservation.processId) -OperationTimeoutSec 5 -ErrorAction Stop)
  } catch {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.StartFailed' -Stage 'cim-observation' -Fields @('processId'))
  }
  # Resolve exactly one row for the retained PID before invoking its owner method.
  $process = Get-PilotWindowsNativeProcessCimRow -ProcessRows $processRows -ProcessId ([int]$NativeObservation.processId)
  try {
    $ownerResult = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -OperationTimeoutSec 5 -ErrorAction Stop
  } catch {
    throw (New-PilotWindowsNativeProcessException -ErrorId 'Morrow.WindowsNativeProcess.StartFailed' -Stage 'cim-observation' -Fields @('ownerSid'))
  }
  $identity = New-PilotWindowsNativeProcessIdentityFromCim `
    -ProcessRow $process `
    -OwnerResult $ownerResult `
    -NativeObservation $NativeObservation `
    -ImageProof $imageProof
  $mismatches = [Collections.Generic.List[string]]::new()
  if ([int]$identity.parentProcessId -ne [int]$Descriptor.expectedParentProcessId) { [void]$mismatches.Add('parentProcessId') }
  if ([string]$identity.ownerSid -cne [string]$Descriptor.expectedOwnerSid) { [void]$mismatches.Add('ownerSid') }
  if ($mismatches.Count -gt 0) {
    throw (New-PilotWindowsNativeProcessException `
      -ErrorId 'Morrow.WindowsNativeProcess.IdentityMismatch' `
      -Stage 'identity-comparison' `
      -Fields $mismatches.ToArray())
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
        -not (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) -or
        -not (Get-Command Invoke-CimMethod -ErrorAction SilentlyContinue)) {
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
      -ExpectedExecutablePath $validatedPaths.executablePath `
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
    Write-Verbose 'Morrow.WindowsNativeProcess.IdentityProof: retained native image, post-create hash, CIM PID/parent/creation/owner, descriptor owner/parent, suspended state, Job membership, and Job policy matched.'

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

function Get-PilotWindowsNativeProcessObservationMembers {
  param(
    [AllowEmptyCollection()][Parameter(Mandatory)][int[]] $BeforeProcessIds,
    [AllowEmptyCollection()][Parameter(Mandatory)][int[]] $AfterProcessIds,
    [AllowEmptyCollection()][Parameter(Mandatory)][int[]] $QueriedProcessIds,
    [Parameter(Mandatory)][object] $RowsById,
    [Parameter(Mandatory)][object] $RowCounts,
    [Parameter(Mandatory)][bool] $CimSucceeded,
    [Parameter(Mandatory)][bool] $BeforeReadSucceeded,
    [Parameter(Mandatory)][bool] $AfterReadSucceeded
  )

  $members = [Collections.Generic.List[object]]::new()
  $beforeSet = [Collections.Generic.HashSet[int]]::new()
  $afterSet = [Collections.Generic.HashSet[int]]::new()
  $querySet = [Collections.Generic.HashSet[int]]::new()
  foreach ($processId in $BeforeProcessIds) { [void]$beforeSet.Add([int]$processId) }
  foreach ($processId in $AfterProcessIds) { [void]$afterSet.Add([int]$processId) }
  foreach ($processId in $QueriedProcessIds) { [void]$querySet.Add([int]$processId) }

  if ($BeforeReadSucceeded -and $AfterReadSucceeded) {
    foreach ($processId in $BeforeProcessIds) {
      if (-not $afterSet.Contains([int]$processId)) {
        [void]$members.Add([pscustomobject][ordered]@{ processId = [int]$processId; state = 'disappeared'; metadata = $null })
        continue
      }
      if (-not $CimSucceeded -or -not $querySet.Contains([int]$processId) -or
          -not $RowCounts.ContainsKey([int]$processId) -or $RowCounts[[int]$processId] -ne 1 -or
          -not $RowsById.ContainsKey([int]$processId)) {
        [void]$members.Add([pscustomobject][ordered]@{ processId = [int]$processId; state = 'unobservable'; metadata = $null })
        continue
      }
      $metadata = Get-PilotWindowsNativeProcessObservationCimMetadata `
        -ProcessRow $RowsById[[int]$processId] -ExpectedProcessId ([int]$processId)
      if ($null -eq $metadata) {
        [void]$members.Add([pscustomobject][ordered]@{ processId = [int]$processId; state = 'unobservable'; metadata = $null })
      } else {
        [void]$members.Add([pscustomobject][ordered]@{ processId = [int]$processId; state = 'observed'; metadata = $metadata })
      }
    }
    foreach ($processId in $AfterProcessIds) {
      if (-not $beforeSet.Contains([int]$processId)) {
        [void]$members.Add([pscustomobject][ordered]@{ processId = [int]$processId; state = 'arrived'; metadata = $null })
      }
    }
  } elseif ($BeforeReadSucceeded) {
    foreach ($processId in $BeforeProcessIds) {
      [void]$members.Add([pscustomobject][ordered]@{ processId = [int]$processId; state = 'unobservable'; metadata = $null })
    }
  } elseif ($AfterReadSucceeded) {
    foreach ($processId in $AfterProcessIds) {
      [void]$members.Add([pscustomobject][ordered]@{ processId = [int]$processId; state = 'unobservable'; metadata = $null })
    }
  }
  return $members.ToArray()
}

function Get-PilotWindowsNativeProcessObservationInventoryStatus {
  param(
    [Parameter(Mandatory)][bool] $SnapshotsAvailable,
    [Parameter(Mandatory)][bool] $CimRowsAvailable,
    [Parameter(Mandatory)][int] $MemberCountBefore,
    [Parameter(Mandatory)][int] $MemberCountAfter,
    [Parameter(Mandatory)][bool] $HasInvalidMembers,
    [Parameter(Mandatory)][bool] $IsTruncated,
    [Parameter(Mandatory)][bool] $HasUnobservableMembers,
    [Parameter(Mandatory)][bool] $HasTransitions,
    [Parameter(Mandatory)][bool] $IdentityUnavailable,
    [Parameter(Mandatory)][bool] $IsConfirmedEmpty
  )

  if (-not $SnapshotsAvailable -or (-not $CimRowsAvailable -and $MemberCountBefore -gt 0)) { return 'unavailable' }
  if ($IsConfirmedEmpty) { return 'empty' }
  if ($HasInvalidMembers -or $IsTruncated -or $HasUnobservableMembers -or $HasTransitions -or $IdentityUnavailable) { return 'partial' }
  return 'available'
}

function Invoke-PilotWindowsNativeProcessObservation {
  param(
    [AllowNull()][object] $Capsule,
    [AllowNull()][object] $IdentityAssertion
  )

  # Validate caller-controlled data before touching the retained session or CIM.
  $normalizedAssertion = ConvertTo-PilotWindowsNativeProcessIdentityAssertion -IdentityAssertion $IdentityAssertion
  $capsuleType = 'Morrow.Pilot.WindowsNativeProcessCapsule' -as [type]
  if ($null -eq $Capsule -or $null -eq $capsuleType -or $Capsule.GetType() -ne $capsuleType) {
    throw (New-PilotWindowsNativeProcessException `
      -ErrorId 'Morrow.WindowsNativeProcess.InvalidCapsule' `
      -Stage 'observe-capsule-validation')
  }

  $privateInstance = [Reflection.BindingFlags]::Instance -bor [Reflection.BindingFlags]::NonPublic
  $captureMethod = $capsuleType.GetMethod('CaptureObservationToken', $privateInstance)
  $readStateMethod = $capsuleType.GetMethod('ReadObservationState', $privateInstance)
  if ($null -eq $captureMethod -or $null -eq $readStateMethod) {
    throw (New-PilotWindowsNativeProcessException `
      -ErrorId 'Morrow.WindowsNativeProcess.InvalidCapsule' `
      -Stage 'observe-capsule-validation')
  }

  $token = $null
  try {
    $token = $captureMethod.Invoke($Capsule, [object[]]@())
  } catch {
    throw (New-PilotWindowsNativeProcessException `
      -ErrorId 'Morrow.WindowsNativeProcess.InvalidCapsule' `
      -Stage 'observe-capsule-validation')
  }

  $beforeState = $null
  $afterState = $null
  $finalState = $null
  $beforeMembers = [pscustomobject]@{ ids = @(); invalidCount = 1 }
  $afterMembers = [pscustomobject]@{ ids = @(); invalidCount = 1 }
  $snapshotIdentity = $null
  $beforeReadSucceeded = $false
  $afterReadSucceeded = $false
  $finalReadSucceeded = $false
  try {
    $beforeState = [pscustomobject]$readStateMethod.Invoke($Capsule, [object[]]@($token))
    $beforeMembers = ConvertFrom-PilotWindowsNativeProcessObservationMembers -MemberIds $beforeState.memberIds
    $snapshot = [object[]]$beforeState.identitySnapshot
    if ($snapshot.Count -eq 6) {
      $snapshotIdentity = [pscustomobject][ordered]@{
        processId = [int]$snapshot[0]
        parentProcessId = [int]$snapshot[1]
        executablePath = [string]$snapshot[2]
        executableSha256 = [string]$snapshot[3]
        creationTimeUtc = [string]$snapshot[4]
        ownerSid = [string]$snapshot[5]
      }
      $beforeReadSucceeded = $true
    }
  } catch {
    $beforeReadSucceeded = $false
  }

  $identityFields = @('processId', 'parentProcessId', 'executablePath', 'executableSha256', 'creationTimeUtc', 'ownerSid')
  $rootPid = if ($null -ne $snapshotIdentity) { [int]$snapshotIdentity.processId } else { 0 }
  $rootBefore = if ($null -ne $beforeState) { $beforeState.root } else { $null }
  $rootBeforeAlive = $null -ne $rootBefore -and [string]$rootBefore.state -ceq 'resume-requested' -and
    [uint32]$rootBefore.processId -eq [uint32]$rootPid -and [bool]$rootBefore.isMember -and
    @($beforeMembers.ids) -contains $rootPid

  # One batched Win32_Process query covers only the pre-proved Job members. The
  # root is first so the hard cap never omits the identity needed for Observe.
  $orderedOwnedIds = [Collections.Generic.List[int]]::new()
  if ($rootPid -gt 0 -and @($beforeMembers.ids) -contains $rootPid) { [void]$orderedOwnedIds.Add($rootPid) }
  foreach ($memberId in $beforeMembers.ids) {
    if ($memberId -ne $rootPid) { [void]$orderedOwnedIds.Add([int]$memberId) }
  }
  $cimClock = [Diagnostics.Stopwatch]::StartNew()
  $cimDeadlineMilliseconds = 8000
  $cimBatch = Get-PilotWindowsNativeProcessObservationCimBatch `
    -OwnedProcessIds $orderedOwnedIds.ToArray() `
    -Clock $cimClock `
    -DeadlineMilliseconds $cimDeadlineMilliseconds

  $rowCounts = [Collections.Generic.Dictionary[int, int]]::new()
  $rowsById = [Collections.Generic.Dictionary[int, object]]::new()
  $querySet = [Collections.Generic.HashSet[int]]::new()
  foreach ($queriedId in $cimBatch.queriedIds) { [void]$querySet.Add([int]$queriedId) }
  if ([bool]$cimBatch.succeeded) {
    foreach ($row in @($cimBatch.rows)) {
      try {
        $pidProperty = $row.PSObject.Properties['ProcessId']
        $integralTypes = @([byte], [sbyte], [short], [ushort], [int], [uint32], [long], [ulong])
        if ($null -eq $pidProperty -or $null -eq $pidProperty.Value -or $pidProperty.Value.GetType() -notin $integralTypes) { continue }
        $pidNumber = [decimal]$pidProperty.Value
        if ($pidNumber -lt 1 -or $pidNumber -gt [int]::MaxValue) { continue }
        $rowPid = [int]$pidNumber
        if (-not $querySet.Contains($rowPid)) { continue }
        if (-not $rowCounts.ContainsKey($rowPid)) { $rowCounts.Add($rowPid, 0) }
        $rowCounts[$rowPid]++
        if ($rowCounts[$rowPid] -eq 1) { $rowsById[$rowPid] = $row }
      } catch { }
    }
  }

  $rootRow = $null
  $ownerResult = $null
  $ownerLookupSucceeded = $false
  $ownerLookupFailed = $false
  $rootRowLookupFailed = $false
  if ($rootBeforeAlive -and [bool]$cimBatch.succeeded -and $querySet.Contains($rootPid) -and
      $rowCounts.ContainsKey($rootPid) -and $rowCounts[$rootPid] -eq 1) {
    $rootRows = [object[]]@($rowsById[$rootPid])
    try {
      $rootRow = Get-PilotWindowsNativeProcessCimRow -ProcessRows $rootRows -ProcessId $rootPid
    } catch {
      $rootRowLookupFailed = $true
      $rootRow = $null
    }
    if ($null -ne $rootRow) {
      try {
        $ownerTimeoutSeconds = Get-PilotWindowsNativeProcessObservationCimTimeoutSeconds `
          -Clock $cimClock -DeadlineMilliseconds $cimDeadlineMilliseconds
        if ($ownerTimeoutSeconds -gt 0 -and (Get-Command Invoke-CimMethod -ErrorAction SilentlyContinue)) {
          $ownerResult = Invoke-CimMethod -InputObject $rootRow -MethodName GetOwnerSid `
            -OperationTimeoutSec $ownerTimeoutSeconds -ErrorAction Stop
          $ownerLookupSucceeded = $cimClock.Elapsed.TotalMilliseconds -lt $cimDeadlineMilliseconds
          if (-not $ownerLookupSucceeded) { $ownerResult = $null }
        } else {
          $ownerLookupFailed = $true
        }
      } catch {
        $ownerLookupFailed = $true
        $ownerResult = $null
      }
    }
  }

  try {
    $afterState = [pscustomobject]$readStateMethod.Invoke($Capsule, [object[]]@($token))
    $afterMembers = ConvertFrom-PilotWindowsNativeProcessObservationMembers -MemberIds $afterState.memberIds
    $afterReadSucceeded = $true
  } catch {
    $afterReadSucceeded = $false
  }

  $identityFromCim = $null
  if ($null -ne $afterState -and $rootBeforeAlive -and [string]$afterState.root.state -ceq 'resume-requested' -and
      [uint32]$afterState.root.processId -eq [uint32]$rootPid -and [bool]$afterState.root.isMember -and
      @($afterMembers.ids) -contains $rootPid -and [bool]$cimBatch.succeeded -and
      $null -ne $rootRow -and $ownerLookupSucceeded) {
    try {
      $imageProof = Get-PilotWindowsNativeProcessImageProof `
        -NativeObservation $afterState.root `
        -ExpectedExecutablePath ([string]$snapshotIdentity.executablePath) `
        -ExpectedHash ([string]$snapshotIdentity.executableSha256)
      $identityFromCim = New-PilotWindowsNativeProcessIdentityFromCim `
        -ProcessRow $rootRow `
        -OwnerResult $ownerResult `
        -NativeObservation $afterState.root `
        -ImageProof $imageProof
      $snapshotAssertion = ConvertTo-PilotWindowsNativeProcessIdentityAssertion -IdentityAssertion ([ordered]@{
        processId = [int]$snapshotIdentity.processId
        parentProcessId = [int]$snapshotIdentity.parentProcessId
        executablePath = [string]$snapshotIdentity.executablePath
        executableSha256 = [string]$snapshotIdentity.executableSha256
        creationTimeUtc = [string]$snapshotIdentity.creationTimeUtc
        ownerSid = [string]$snapshotIdentity.ownerSid
      })
      $null = Compare-PilotWindowsNativeProcessIdentityAssertion `
        -NormalizedAssertion $snapshotAssertion -ObservedIdentity $identityFromCim
    } catch {
      $identityFromCim = $null
      # A mismatch between the retained snapshot and fresh native/CIM proof is
      # an unavailable live proof. Caller assertions are compared only after a
      # complete fresh identity has passed this internal consistency check.
    }
  }

  # The final synchronized read closes the race with Dispose and confirms that
  # the same retained root remains alive in its owned Job before it is fresh.
  try {
    $finalState = [pscustomobject]$readStateMethod.Invoke($Capsule, [object[]]@($token))
    $finalMembers = ConvertFrom-PilotWindowsNativeProcessObservationMembers -MemberIds $finalState.memberIds
    $finalReadSucceeded = $true
  } catch {
    $finalMembers = [pscustomobject]@{ ids = @(); invalidCount = 1 }
    $finalReadSucceeded = $false
  }

  $rootState = 'unavailable'
  $identityStatus = 'unavailable'
  $rootIdentity = $null
  $rootExitCode = $null
  $confirmedExitRoot = $null
  if ($finalReadSucceeded -and $null -ne $finalState -and [string]$finalState.root.state -ceq 'exited' -and
      [uint32]$finalState.root.processId -eq [uint32]$rootPid) { $confirmedExitRoot = $finalState.root }

  $finalRootAliveAndMember = $finalReadSucceeded -and $null -ne $finalState -and
    [string]$finalState.root.state -ceq 'resume-requested' -and
    [uint32]$finalState.root.processId -eq [uint32]$rootPid -and [bool]$finalState.root.isMember -and
    $finalMembers.invalidCount -eq 0 -and @($finalMembers.ids) -contains $rootPid
  $afterRootConsistent = $finalReadSucceeded -and $afterReadSucceeded -and $null -ne $afterState -and
    [string]$afterState.root.state -ceq 'resume-requested' -and
    [uint32]$afterState.root.processId -eq [uint32]$rootPid -and [bool]$afterState.root.isMember -and
    @($afterMembers.ids) -contains $rootPid -and
    [string]::Equals([string]$afterState.root.creationTimeUtc, [string]$finalState.root.creationTimeUtc, [StringComparison]::Ordinal)

  if ($finalRootAliveAndMember -and $afterRootConsistent -and $null -ne $identityFromCim) {
    $rootState = 'alive'
    $identityStatus = 'fresh'
    $rootIdentity = $identityFromCim
  } elseif ($null -ne $confirmedExitRoot -and $null -ne $snapshotIdentity) {
    $rootState = 'exited'
    $identityStatus = 'snapshot'
    $rootIdentity = $snapshotIdentity
    $rootExitCode = if ($null -eq $confirmedExitRoot.exitCode) { $null } else { [uint32]$confirmedExitRoot.exitCode }
  }

  if ($normalizedAssertion.Count -gt 0) {
    if ($identityStatus -eq 'fresh' -or $identityStatus -eq 'snapshot') {
      $null = Compare-PilotWindowsNativeProcessIdentityAssertion `
        -NormalizedAssertion $normalizedAssertion -ObservedIdentity $rootIdentity
    } else {
      $fields = if ($ownerLookupFailed) { @('ownerSid') } elseif ($null -eq $rootRow -or $rootRowLookupFailed) { @('processId') } else { $identityFields }
      throw (New-PilotWindowsNativeProcessException `
        -ErrorId 'Morrow.WindowsNativeProcess.IdentityUnavailable' `
        -Stage 'observe-identity' `
        -Fields $fields)
    }
  }

  $inventoryRowsAvailable = [bool]$cimBatch.succeeded
  $inventoryAfterMembers = if ($finalReadSucceeded) { $finalMembers } else { [pscustomobject]@{ ids = @(); invalidCount = 1 } }
  $inventoryMembers = @(Get-PilotWindowsNativeProcessObservationMembers `
    -BeforeProcessIds ([int[]]$beforeMembers.ids) `
    -AfterProcessIds ([int[]]$inventoryAfterMembers.ids) `
    -QueriedProcessIds ([int[]]$cimBatch.queriedIds) `
    -RowsById $rowsById `
    -RowCounts $rowCounts `
    -CimSucceeded ([bool]$cimBatch.succeeded) `
    -BeforeReadSucceeded $beforeReadSucceeded `
    -AfterReadSucceeded $finalReadSucceeded)
  $inventoryHasUnobservable = @($inventoryMembers | Where-Object { $_.state -eq 'unobservable' }).Count -gt 0
  $inventoryHasTransitions = @($inventoryMembers | Where-Object { $_.state -in @('disappeared', 'arrived') }).Count -gt 0
  $inventoryIsEmpty = $beforeReadSucceeded -and $finalReadSucceeded -and $beforeMembers.invalidCount -eq 0 -and $inventoryAfterMembers.invalidCount -eq 0 -and
    $beforeMembers.ids.Count -eq 0 -and $inventoryAfterMembers.ids.Count -eq 0
  $inventoryStatus = Get-PilotWindowsNativeProcessObservationInventoryStatus `
    -SnapshotsAvailable ($beforeReadSucceeded -and $finalReadSucceeded) `
    -CimRowsAvailable $inventoryRowsAvailable `
    -MemberCountBefore ([int]$beforeMembers.ids.Count) `
    -MemberCountAfter ([int]$inventoryAfterMembers.ids.Count) `
    -HasInvalidMembers ($beforeMembers.invalidCount -gt 0 -or $inventoryAfterMembers.invalidCount -gt 0) `
    -IsTruncated ([bool]$cimBatch.truncated) `
    -HasUnobservableMembers $inventoryHasUnobservable `
    -HasTransitions $inventoryHasTransitions `
    -IdentityUnavailable ($identityStatus -eq 'unavailable') `
    -IsConfirmedEmpty $inventoryIsEmpty

  return [pscustomobject][ordered]@{
    root = [pscustomobject][ordered]@{
      state = $rootState
      identityStatus = $identityStatus
      identityFresh = ($identityStatus -eq 'fresh')
      identity = $rootIdentity
      exitCode = $rootExitCode
    }
    inventory = [pscustomobject][ordered]@{
      status = $inventoryStatus
      isEmpty = $inventoryIsEmpty
      memberCountBefore = if ($beforeReadSucceeded) { $beforeMembers.ids.Count } else { $null }
      memberCountAfter = if ($finalReadSucceeded) { $finalMembers.ids.Count } else { $null }
      members = $inventoryMembers
    }
  }
}

function Observe-WindowsNativeProcess {
  [CmdletBinding()]
  param(
    [AllowNull()][object] $Capsule,
    [AllowNull()][object] $IdentityAssertion
  )

  try {
    # The worker normalizes caller data before touching the retained session or CIM.
    $result = Invoke-PilotWindowsNativeProcessObservation -Capsule $Capsule -IdentityAssertion $IdentityAssertion
    return ,$result
  } catch {
    $caught = $_.Exception
    $errorId = Get-PilotWindowsNativeProcessErrorId -Exception $caught
    $allowedErrorIds = @(
      'Morrow.WindowsNativeProcess.InvalidCapsule',
      'Morrow.WindowsNativeProcess.InvalidIdentityAssertion',
      'Morrow.WindowsNativeProcess.IdentityMismatch',
      'Morrow.WindowsNativeProcess.IdentityUnavailable'
    )
    if ($errorId -notin $allowedErrorIds) { $errorId = 'Morrow.WindowsNativeProcess.IdentityUnavailable' }
    $diagnostics = Get-PilotWindowsNativeProcessDiagnostics -Exception $caught
    if ($null -eq $diagnostics -or $diagnostics -isnot [System.Collections.IDictionary]) {
      $diagnostics = [ordered]@{ stage = 'observe-native-read'; cause = $errorId; fields = @() }
    }
    $category = if ($errorId -eq 'Morrow.WindowsNativeProcess.InvalidIdentityAssertion') {
      [System.Management.Automation.ErrorCategory]::InvalidArgument
    } else {
      [System.Management.Automation.ErrorCategory]::InvalidOperation
    }
    $errorRecord = [System.Management.Automation.ErrorRecord]::new(
      [InvalidOperationException]::new('The Windows native process policy operation failed.'),
      $errorId,
      $category,
      $null
    )
    $errorRecord.Exception.Data['Morrow.WindowsNativeProcess.ErrorId'] = $errorId
    $errorRecord.Exception.Data['Morrow.WindowsNativeProcess.Diagnostics'] = $diagnostics
    $PSCmdlet.ThrowTerminatingError($errorRecord)
  }
}
