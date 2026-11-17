function Get-PilotWindowsNativeJobInteropSource {
  @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace Morrow.Pilot
{
  public sealed class NativeRootObservation
  {
    public uint processId { get; set; }
    public uint creatorProcessId { get; set; }
    public uint? parentProcessId { get; set; }
    public string executablePath { get; set; }
    public string creationTimeUtc { get; set; }
    public bool isMember { get; set; }
    public bool wasAssociatedAtCreation { get; set; }
    public string state { get; set; }
    public uint? exitCode { get; set; }
    public uint jobLimitFlags { get; set; }
    public bool jobHandleInheritable { get; set; }
  }

  public sealed class NativeResumeResult
  {
    public bool resumed { get; set; }
    public uint rootProcessId { get; set; }
    public uint previousSuspendCount { get; set; }
    public string state { get; set; }
  }

  public sealed class NativeStopResult
  {
    public bool jobEmpty { get; set; }
    public uint[] remainingMemberIds { get; set; }
    public bool rootExited { get; set; }
    public uint? rootExitCode { get; set; }
    public bool timedOut { get; set; }
  }

  internal sealed class OwnedKernelHandle : SafeHandleZeroOrMinusOneIsInvalid
  {
    private OwnedKernelHandle() : base(true) { }

    internal OwnedKernelHandle(IntPtr value) : base(true)
    {
      SetHandle(value);
    }

    protected override bool ReleaseHandle()
    {
      return NativeMethods.CloseHandle(handle);
    }
  }

  public sealed class WindowsNativeJobSession : IDisposable
  {
    private readonly object _sync = new object();
    private readonly OwnedKernelHandle _job;
    private OwnedKernelHandle _process;
    private OwnedKernelHandle _primaryThread;
    private readonly uint _processId;
    private readonly uint _creatorProcessId;
    private readonly uint _jobLimitFlags;
    private readonly bool _jobHandleInheritable;
    private bool _resumeRequested;
    private bool _stopRequested;
    private bool _disposed;
    private bool _rootExited;
    private uint? _rootExitCode;
    private string _executablePath;
    private string _creationTimeUtc;

    internal WindowsNativeJobSession(
      OwnedKernelHandle job,
      OwnedKernelHandle process,
      OwnedKernelHandle primaryThread,
      uint processId,
      uint creatorProcessId,
      uint jobLimitFlags,
      bool jobHandleInheritable)
    {
      if (job == null) throw new ArgumentNullException("job");
      if (process == null) throw new ArgumentNullException("process");
      if (primaryThread == null) throw new ArgumentNullException("primaryThread");
      _job = job;
      _process = process;
      _primaryThread = primaryThread;
      _processId = processId;
      _creatorProcessId = creatorProcessId;
      _jobLimitFlags = jobLimitFlags;
      _jobHandleInheritable = jobHandleInheritable;
    }

    public NativeRootObservation ObserveRoot()
    {
      lock (_sync)
      {
        EnsureUsable();
        bool exited = CacheRootExitIfSignaled();
        if (!exited)
          CaptureRootIdentity();
        bool inJob = !exited && IsProcessInJob(_process, _job);
        string state = exited ? "exited" : (_resumeRequested ? "resume-requested" : "suspended");

        return new NativeRootObservation
        {
          processId = _processId,
          creatorProcessId = _creatorProcessId,
          parentProcessId = null,
          executablePath = _executablePath,
          creationTimeUtc = _creationTimeUtc,
          isMember = inJob,
          wasAssociatedAtCreation = true,
          state = state,
          exitCode = exited ? _rootExitCode : null,
          jobLimitFlags = _jobLimitFlags,
          jobHandleInheritable = _jobHandleInheritable
        };
      }
    }

    public uint[] ListMemberIds()
    {
      lock (_sync)
      {
        EnsureUsable();
        CacheRootExitIfSignaled();
        return QueryMemberIds(_job);
      }
    }

    public NativeResumeResult Resume()
    {
      lock (_sync)
      {
        EnsureUsable();
        if (_stopRequested)
          throw new InvalidOperationException("The Job has already entered stop cleanup.");
        if (_resumeRequested)
          throw new InvalidOperationException("The retained primary thread has already been resumed.");
        if (CacheRootExitIfSignaled())
          throw new InvalidOperationException("The suspended root exited before Resume was requested.");
        if (!IsProcessInJob(_process, _job))
          throw new InvalidOperationException("The retained root is no longer associated with its private Job.");

        uint previous = NativeMethods.ResumeThread(_primaryThread.DangerousGetHandle());
        if (previous == NativeMethods.InvalidResumeCount)
          throw LastError("ResumeThread failed for the retained primary thread.");
        if (previous != 1)
        {
          _stopRequested = true;
          TerminateOwnedJobBestEffort();
          throw new InvalidOperationException("The retained primary thread did not have the expected initial suspend count of one.");
        }

        _resumeRequested = true;
        return new NativeResumeResult
        {
          resumed = true,
          rootProcessId = _processId,
          previousSuspendCount = previous,
          state = "resume-requested"
        };
      }
    }

    public NativeStopResult StopAndWait()
    {
      return StopAndWait(10000);
    }

    public NativeStopResult StopAndWait(int timeoutMs)
    {
      if (timeoutMs < 0 || timeoutMs > 120000)
        throw new ArgumentOutOfRangeException("timeoutMs", "Timeout must be between zero and 120000 milliseconds.");

      lock (_sync)
      {
        EnsureUsable();
        if (!_stopRequested)
        {
          if (!NativeMethods.TerminateJobObject(_job.DangerousGetHandle(), NativeMethods.CleanupExitCode))
            throw LastError("TerminateJobObject failed for the private Job.");
          _stopRequested = true;
        }

        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (true)
        {
          bool rootExited = CacheRootExitIfSignaled();
          uint[] remaining = QueryMemberIds(_job);
          uint? rootExitCode = rootExited ? _rootExitCode : null;
          if (remaining.Length == 0)
          {
            return new NativeStopResult
            {
              jobEmpty = true,
              remainingMemberIds = remaining,
              rootExited = rootExited,
              rootExitCode = rootExitCode,
              timedOut = false
            };
          }

          int remainingMs = (int)Math.Max(0, Math.Min(int.MaxValue, (deadline - DateTime.UtcNow).TotalMilliseconds));
          if (remainingMs == 0)
          {
            return new NativeStopResult
            {
              jobEmpty = false,
              remainingMemberIds = remaining,
              rootExited = rootExited,
              rootExitCode = rootExitCode,
              timedOut = true
            };
          }
          Thread.Sleep(Math.Min(25, remainingMs));
        }
      }
    }

    public void Dispose()
    {
      lock (_sync)
      {
        if (_disposed)
          return;
        _disposed = true;

        // Closing the last private Job handle is the fail-safe cleanup path.
        TerminateOwnedJobBestEffort();
        _job.Dispose();
        if (_primaryThread != null)
        {
          _primaryThread.Dispose();
          _primaryThread = null;
        }
        if (_process != null)
        {
          _process.Dispose();
          _process = null;
        }
      }
    }

    internal void CleanupFailedCreation()
    {
      lock (_sync)
      {
        if (_disposed)
          return;
        try
        {
          if (_process != null && !_process.IsClosed && !_process.IsInvalid)
            NativeMethods.TerminateProcess(_process.DangerousGetHandle(), NativeMethods.CleanupExitCode);
        }
        catch { }
        TerminateOwnedJobBestEffort();
        if (_process != null && !_process.IsClosed && !_process.IsInvalid)
          NativeMethods.WaitForSingleObject(_process.DangerousGetHandle(), 5000);
      }
      Dispose();
    }

    private void EnsureUsable()
    {
      if (_disposed)
        throw new ObjectDisposedException("WindowsNativeJobSession");
    }

    private void TerminateOwnedJobBestEffort()
    {
      try
      {
        if (!_job.IsClosed && !_job.IsInvalid)
          NativeMethods.TerminateJobObject(_job.DangerousGetHandle(), NativeMethods.CleanupExitCode);
      }
      catch { }
    }

    private static bool IsProcessInJob(OwnedKernelHandle process, OwnedKernelHandle job)
    {
      bool inJob;
      if (!NativeMethods.IsProcessInJob(process.DangerousGetHandle(), job.DangerousGetHandle(), out inJob))
        throw LastError("IsProcessInJob failed for the retained root.");
      return inJob;
    }

    private bool CacheRootExitIfSignaled()
    {
      if (_rootExited)
        return true;
      if (_process == null || !IsSignaled(_process))
        return false;

      CaptureRootIdentity();
      _rootExitCode = ReadExitCode(_process);
      _rootExited = true;

      // Once the signaled root's identity and code are cached, closing these
      // exact handles lets Job membership queries report the remaining live tree.
      _process.Dispose();
      _process = null;
      if (_primaryThread != null)
      {
        _primaryThread.Dispose();
        _primaryThread = null;
      }
      return true;
    }

    private void CaptureRootIdentity()
    {
      if (_executablePath == null)
        _executablePath = ReadImagePath(_process);
      if (_creationTimeUtc == null)
        _creationTimeUtc = ReadCreationTimeUtc(_process);
    }

    private static bool IsSignaled(OwnedKernelHandle handle)
    {
      uint wait = NativeMethods.WaitForSingleObject(handle.DangerousGetHandle(), 0);
      if (wait == NativeMethods.WaitObject0)
        return true;
      if (wait == NativeMethods.WaitTimeout)
        return false;
      throw LastError("WaitForSingleObject failed while observing a retained handle.");
    }

    private static uint ReadExitCode(OwnedKernelHandle process)
    {
      uint exitCode;
      if (!NativeMethods.GetExitCodeProcess(process.DangerousGetHandle(), out exitCode))
        throw LastError("GetExitCodeProcess failed for the retained root.");
      return exitCode;
    }

    private static string ReadImagePath(OwnedKernelHandle process)
    {
      StringBuilder path = new StringBuilder(32768);
      uint capacity = (uint)path.Capacity;
      if (!NativeMethods.QueryFullProcessImageNameW(process.DangerousGetHandle(), 0, path, ref capacity))
        throw LastError("QueryFullProcessImageNameW failed for the retained root.");
      return path.ToString();
    }

    private static string ReadCreationTimeUtc(OwnedKernelHandle process)
    {
      NativeMethods.FILETIME creation;
      NativeMethods.FILETIME exit;
      NativeMethods.FILETIME kernel;
      NativeMethods.FILETIME user;
      if (!NativeMethods.GetProcessTimes(process.DangerousGetHandle(), out creation, out exit, out kernel, out user))
        throw LastError("GetProcessTimes failed for the retained root.");
      long ticks = ((long)creation.dwHighDateTime << 32) | creation.dwLowDateTime;
      return DateTime.FromFileTimeUtc(ticks).ToString("o", CultureInfo.InvariantCulture);
    }

    private static uint[] QueryMemberIds(OwnedKernelHandle job)
    {
      int capacity = 16;
      for (int attempt = 0; attempt < 12; attempt++)
      {
        int bytes = checked(8 + checked(capacity * IntPtr.Size));
        IntPtr buffer = Marshal.AllocHGlobal(bytes);
        try
        {
          for (int offset = 0; offset < bytes; offset += IntPtr.Size)
            Marshal.WriteIntPtr(buffer, offset, IntPtr.Zero);

          uint returned;
          bool ok = NativeMethods.QueryInformationJobObject(
            job.DangerousGetHandle(),
            NativeMethods.JobObjectBasicProcessIdList,
            buffer,
            (uint)bytes,
            out returned);

          if (!ok)
          {
            int error = Marshal.GetLastWin32Error();
            if (error == NativeMethods.ErrorMoreData || error == NativeMethods.ErrorInsufficientBuffer)
            {
              int assigned = Math.Max(0, Marshal.ReadInt32(buffer, 0));
              capacity = GrowCapacity(capacity, assigned);
              continue;
            }
            throw new Win32Exception(error, "QueryInformationJobObject failed for the private Job.");
          }

          int assignedCount = Marshal.ReadInt32(buffer, 0);
          int listedCount = Marshal.ReadInt32(buffer, 4);
          if (assignedCount < 0 || listedCount < 0 || listedCount > capacity)
          {
            capacity = GrowCapacity(capacity, Math.Max(assignedCount, listedCount));
            continue;
          }
          if (listedCount < assignedCount)
          {
            capacity = GrowCapacity(capacity, assignedCount);
            continue;
          }

          List<uint> ids = new List<uint>(listedCount);
          for (int index = 0; index < listedCount; index++)
          {
            int offset = checked(8 + checked(index * IntPtr.Size));
            ulong raw = IntPtr.Size == 8
              ? unchecked((ulong)Marshal.ReadInt64(buffer, offset))
              : unchecked((uint)Marshal.ReadInt32(buffer, offset));
            if (raw == 0 || raw > uint.MaxValue)
              throw new InvalidOperationException("The Job returned an invalid process identifier.");
            ids.Add((uint)raw);
          }
          ids.Sort();
          for (int index = ids.Count - 1; index > 0; index--)
            if (ids[index] == ids[index - 1]) ids.RemoveAt(index);
          return ids.ToArray();
        }
        finally
        {
          Marshal.FreeHGlobal(buffer);
        }
      }

      throw new InvalidOperationException("The Job membership list kept changing while its buffer was resized.");
    }

    private static int GrowCapacity(int current, int observed)
    {
      long doubled = Math.Max((long)current * 2, (long)observed * 2);
      if (doubled < current + 1L) doubled = current + 1L;
      if (doubled > 1048576)
        throw new InvalidOperationException("The Job membership list exceeds the supported observation bound.");
      return (int)doubled;
    }

    private static Exception LastError(string message)
    {
      return new Win32Exception(Marshal.GetLastWin32Error(), message);
    }
  }

  public static class WindowsNativeJobInterop
  {
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint ProcThreadAttributeJobList = 0x0006000D;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint HandleFlagInherit = 0x00000001;
    private const int JobObjectExtendedLimitInformation = 9;

    public static WindowsNativeJobSession CreateAtomicSuspendedRoot(
      string executablePath,
      string[] argumentList,
      IDictionary<string, string> environment,
      string workingDirectory)
    {
      ValidateInputs(executablePath, argumentList, environment, workingDirectory);

      uint creatorProcessId = NativeMethods.GetCurrentProcessId();
      IntPtr rawJob = NativeMethods.CreateJobObjectW(IntPtr.Zero, null);
      if (rawJob == IntPtr.Zero)
        throw LastError("CreateJobObjectW failed for the private Job.");

      OwnedKernelHandle job = new OwnedKernelHandle(rawJob);
      OwnedKernelHandle process = null;
      OwnedKernelHandle primaryThread = null;
      WindowsNativeJobSession session = null;
      IntPtr attributeList = IntPtr.Zero;
      IntPtr jobListValue = IntPtr.Zero;
      IntPtr environmentBlock = IntPtr.Zero;
      bool attributeListInitialized = false;

      try
      {
        SetPrivateJobLimits(job);
        uint actualJobFlags = ReadJobLimitFlags(job);
        if (actualJobFlags != JobObjectLimitKillOnJobClose)
          throw new InvalidOperationException("The private Job has unexpected limit flags.");

        uint jobHandleFlags;
        if (!NativeMethods.GetHandleInformation(job.DangerousGetHandle(), out jobHandleFlags))
          throw LastError("GetHandleInformation failed for the private Job handle.");
        bool jobHandleInheritable = (jobHandleFlags & HandleFlagInherit) != 0;
        if (jobHandleInheritable)
          throw new InvalidOperationException("The private Job handle is unexpectedly inheritable.");

        IntPtr requiredSize = IntPtr.Zero;
        bool initializedWithNull = NativeMethods.InitializeProcThreadAttributeList(
          IntPtr.Zero, 1, 0, ref requiredSize);
        if (initializedWithNull || requiredSize == IntPtr.Zero)
          throw new InvalidOperationException("InitializeProcThreadAttributeList did not report the required buffer size.");

        attributeList = Marshal.AllocHGlobal(requiredSize);
        if (!NativeMethods.InitializeProcThreadAttributeList(attributeList, 1, 0, ref requiredSize))
          throw LastError("InitializeProcThreadAttributeList failed.");
        attributeListInitialized = true;

        jobListValue = Marshal.AllocHGlobal(IntPtr.Size);
        Marshal.WriteIntPtr(jobListValue, job.DangerousGetHandle());
        if (!NativeMethods.UpdateProcThreadAttribute(
          attributeList,
          0,
          new IntPtr(unchecked((long)ProcThreadAttributeJobList)),
          jobListValue,
          new UIntPtr((uint)IntPtr.Size),
          IntPtr.Zero,
          IntPtr.Zero))
          throw LastError("UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_JOB_LIST) failed.");

        string[] entries = BuildEnvironmentEntries(environment);
        string environmentText = String.Join("\0", entries) + "\0";
        environmentBlock = Marshal.StringToHGlobalUni(environmentText);

        string commandLineText = BuildCommandLine(executablePath, argumentList);
        StringBuilder mutableCommandLine = new StringBuilder(commandLineText);
        STARTUPINFOEX startup = new STARTUPINFOEX();
        startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
        startup.lpAttributeList = attributeList;

        PROCESS_INFORMATION processInformation;
        bool created = NativeMethods.CreateProcessW(
          executablePath,
          mutableCommandLine,
          IntPtr.Zero,
          IntPtr.Zero,
          false,
          ExtendedStartupInfoPresent | CreateSuspended | CreateUnicodeEnvironment,
          environmentBlock,
          workingDirectory,
          ref startup,
          out processInformation);
        if (!created)
          throw LastError("CreateProcessW failed while creating the root atomically in its Job.");

        process = new OwnedKernelHandle(processInformation.hProcess);
        primaryThread = new OwnedKernelHandle(processInformation.hThread);
        if (process.IsInvalid || primaryThread.IsInvalid)
          throw new InvalidOperationException("CreateProcessW returned an invalid process or primary-thread handle.");

        session = new WindowsNativeJobSession(
          job,
          process,
          primaryThread,
          processInformation.dwProcessId,
          creatorProcessId,
          actualJobFlags,
          jobHandleInheritable);

        // Transfer ownership to the session before checking the observable postcondition.
        job = null;
        process = null;
        primaryThread = null;

        NativeRootObservation observation = session.ObserveRoot();
        uint[] members = session.ListMemberIds();
        if (!observation.isMember || observation.state != "suspended" ||
            Array.IndexOf(members, observation.processId) < 0)
          throw new InvalidOperationException("The returned root was not observably suspended and associated with its private Job.");

        return session;
      }
      catch
      {
        if (session != null)
        {
          session.CleanupFailedCreation();
        }
        else
        {
          CleanupPartialCreation(job, process, primaryThread);
        }
        throw;
      }
      finally
      {
        if (attributeListInitialized)
          NativeMethods.DeleteProcThreadAttributeList(attributeList);
        if (attributeList != IntPtr.Zero)
          Marshal.FreeHGlobal(attributeList);
        if (jobListValue != IntPtr.Zero)
          Marshal.FreeHGlobal(jobListValue);
        if (environmentBlock != IntPtr.Zero)
          Marshal.FreeHGlobal(environmentBlock);
      }
    }

    private static void ValidateInputs(
      string executablePath,
      string[] argumentList,
      IDictionary<string, string> environment,
      string workingDirectory)
    {
      if (String.IsNullOrWhiteSpace(executablePath) || executablePath.IndexOf('\0') >= 0 || !Path.IsPathFullyQualified(executablePath))
        throw new ArgumentException("ExecutablePath must be a fully qualified Windows path without NUL characters.", "executablePath");
      if (String.IsNullOrWhiteSpace(workingDirectory) || workingDirectory.IndexOf('\0') >= 0 || !Path.IsPathFullyQualified(workingDirectory))
        throw new ArgumentException("WorkingDirectory must be a fully qualified Windows path without NUL characters.", "workingDirectory");
      if (argumentList == null)
        throw new ArgumentNullException("argumentList");
      if (environment == null)
        throw new ArgumentNullException("environment");
      foreach (string argument in argumentList)
      {
        if (argument == null || argument.IndexOf('\0') >= 0)
          throw new ArgumentException("ArgumentList entries must be non-null strings without NUL characters.", "argumentList");
      }
    }

    private static string[] BuildEnvironmentEntries(IDictionary<string, string> environment)
    {
      SortedDictionary<string, string> sorted = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      foreach (KeyValuePair<string, string> pair in environment)
      {
        if (String.IsNullOrWhiteSpace(pair.Key) || pair.Key.IndexOf('=') >= 0 || pair.Key.IndexOf('\0') >= 0)
          throw new ArgumentException("Environment names must be non-empty and may not contain '=' or NUL.", "environment");
        if (pair.Value == null || pair.Value.IndexOf('\0') >= 0)
          throw new ArgumentException("Environment values must be non-null and may not contain NUL.", "environment");
        if (sorted.ContainsKey(pair.Key))
          throw new ArgumentException("Environment names must be unique without regard to case.", "environment");
        sorted.Add(pair.Key, pair.Value);
      }

      List<string> entries = new List<string>(sorted.Count);
      foreach (KeyValuePair<string, string> pair in sorted)
        entries.Add(pair.Key + "=" + pair.Value);
      return entries.ToArray();
    }

    private static string BuildCommandLine(string executablePath, string[] argumentList)
    {
      StringBuilder line = new StringBuilder();
      line.Append(QuoteArgument(executablePath));
      foreach (string argument in argumentList)
      {
        line.Append(' ');
        line.Append(QuoteArgument(argument));
      }
      return line.ToString();
    }

    private static string QuoteArgument(string value)
    {
      StringBuilder quoted = new StringBuilder();
      quoted.Append('"');
      int backslashes = 0;
      foreach (char character in value)
      {
        if (character == '\\')
        {
          backslashes++;
          continue;
        }
        if (character == '"')
        {
          quoted.Append('\\', checked(backslashes * 2 + 1));
          quoted.Append('"');
          backslashes = 0;
          continue;
        }
        if (backslashes > 0)
        {
          quoted.Append('\\', backslashes);
          backslashes = 0;
        }
        quoted.Append(character);
      }
      if (backslashes > 0)
        quoted.Append('\\', checked(backslashes * 2));
      quoted.Append('"');
      return quoted.ToString();
    }

    private static void SetPrivateJobLimits(OwnedKernelHandle job)
    {
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      info.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
      if (!NativeMethods.SetInformationJobObject(
        job.DangerousGetHandle(),
        JobObjectExtendedLimitInformation,
        ref info,
        (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
        throw LastError("SetInformationJobObject failed while enabling KILL_ON_JOB_CLOSE.");
    }

    private static uint ReadJobLimitFlags(OwnedKernelHandle job)
    {
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION info;
      uint returned;
      if (!NativeMethods.QueryInformationJobObject(
        job.DangerousGetHandle(),
        JobObjectExtendedLimitInformation,
        out info,
        (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)),
        out returned))
        throw LastError("QueryInformationJobObject failed while verifying Job limits.");
      return info.BasicLimitInformation.LimitFlags;
    }

    private static void CleanupPartialCreation(
      OwnedKernelHandle job,
      OwnedKernelHandle process,
      OwnedKernelHandle primaryThread)
    {
      if (job != null && !job.IsInvalid && !job.IsClosed)
      {
        try { NativeMethods.TerminateJobObject(job.DangerousGetHandle(), NativeMethods.CleanupExitCode); }
        catch { }
      }
      if (process != null && !process.IsInvalid && !process.IsClosed)
      {
        // This is the exact PROCESS_INFORMATION handle created by this call, never a caller PID.
        try { NativeMethods.TerminateProcess(process.DangerousGetHandle(), NativeMethods.CleanupExitCode); }
        catch { }
      }
      if (job != null) job.Dispose();
      if (primaryThread != null) primaryThread.Dispose();
      if (process != null)
      {
        try { NativeMethods.WaitForSingleObject(process.DangerousGetHandle(), 5000); }
        catch { }
        process.Dispose();
      }
    }

    private static Exception LastError(string message)
    {
      return new Win32Exception(Marshal.GetLastWin32Error(), message);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct STARTUPINFO
    {
      public uint cb;
      public string lpReserved;
      public string lpDesktop;
      public string lpTitle;
      public uint dwX;
      public uint dwY;
      public uint dwXSize;
      public uint dwYSize;
      public uint dwXCountChars;
      public uint dwYCountChars;
      public uint dwFillAttribute;
      public uint dwFlags;
      public ushort wShowWindow;
      public ushort cbReserved2;
      public IntPtr lpReserved2;
      public IntPtr hStdInput;
      public IntPtr hStdOutput;
      public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct STARTUPINFOEX
    {
      public STARTUPINFO StartupInfo;
      public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PROCESS_INFORMATION
    {
      public IntPtr hProcess;
      public IntPtr hThread;
      public uint dwProcessId;
      public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
      public long PerProcessUserTimeLimit;
      public long PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize;
      public UIntPtr MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass;
      public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct IO_COUNTERS
    {
      public ulong ReadOperationCount;
      public ulong WriteOperationCount;
      public ulong OtherOperationCount;
      public ulong ReadTransferCount;
      public ulong WriteTransferCount;
      public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit;
      public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed;
      public UIntPtr PeakJobMemoryUsed;
    }
  }

  internal static class NativeMethods
  {
    internal const uint InvalidResumeCount = 0xFFFFFFFF;
    internal const uint CleanupExitCode = 0xE0030188;
    internal const uint WaitObject0 = 0x00000000;
    internal const uint WaitTimeout = 0x00000102;
    internal const int ErrorMoreData = 234;
    internal const int ErrorInsufficientBuffer = 122;
    internal const int JobObjectBasicProcessIdList = 3;

    [StructLayout(LayoutKind.Sequential)]
    internal struct FILETIME
    {
      public uint dwLowDateTime;
      public uint dwHighDateTime;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "SetInformationJobObject")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetInformationJobObject(IntPtr hJob, int jobObjectInformationClass, ref WindowsNativeJobInterop.JOBOBJECT_EXTENDED_LIMIT_INFORMATION jobObjectInformation, uint cbJobObjectInformationLength);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "QueryInformationJobObject")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool QueryInformationJobObject(IntPtr hJob, int jobObjectInformationClass, out WindowsNativeJobInterop.JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInformation, uint cbJobObjectInformationLength, out uint lpReturnLength);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "QueryInformationJobObject")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool QueryInformationJobObject(IntPtr hJob, int jobObjectInformationClass, IntPtr lpJobObjectInformation, uint cbJobObjectInformationLength, out uint lpReturnLength);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "InitializeProcThreadAttributeList")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, uint dwFlags, ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "UpdateProcThreadAttribute")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr attribute, IntPtr lpValue, UIntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "DeleteProcThreadAttributeList")]
    internal static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateProcessW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CreateProcessW(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, [MarshalAs(UnmanagedType.Bool)] bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref WindowsNativeJobInterop.STARTUPINFOEX lpStartupInfo, out WindowsNativeJobInterop.PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "ResumeThread")]
    internal static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "TerminateJobObject")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "TerminateProcess")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "IsProcessInJob")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool IsProcessInJob(IntPtr processHandle, IntPtr jobHandle, [MarshalAs(UnmanagedType.Bool)] out bool result);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "QueryFullProcessImageNameW", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool QueryFullProcessImageNameW(IntPtr hProcess, uint dwFlags, StringBuilder lpExeName, ref uint lpdwSize);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "GetProcessTimes")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetProcessTimes(IntPtr hProcess, out FILETIME lpCreationTime, out FILETIME lpExitTime, out FILETIME lpKernelTime, out FILETIME lpUserTime);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "GetExitCodeProcess")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "WaitForSingleObject")]
    internal static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "GetHandleInformation")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetHandleInformation(IntPtr hObject, out uint lpdwFlags);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "GetCurrentProcessId")]
    internal static extern uint GetCurrentProcessId();

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "CloseHandle")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(IntPtr hObject);
  }
}
'@
}

function Initialize-PilotWindowsNativeJobInterop {
  if ($null -eq ('Morrow.Pilot.WindowsNativeJobInterop' -as [type])) {
    $source = Get-PilotWindowsNativeJobInteropSource
    Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
  }
  if ($null -eq ('Morrow.Pilot.WindowsNativeJobInterop' -as [type])) {
    throw 'The inline Windows native Job interop type did not load.'
  }
}

function CreateAtomicSuspendedRoot {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string] $ExecutablePath,
    [Parameter(Mandatory)][AllowEmptyCollection()][ValidateNotNull()][string[]] $ArgumentList,
    [Parameter(Mandatory)][ValidateNotNull()][System.Collections.IDictionary] $Environment,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string] $WorkingDirectory
  )

  Initialize-PilotWindowsNativeJobInterop
  $environmentMap = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($key in $Environment.Keys) {
    if ($null -eq $key -or $null -eq $Environment[$key]) {
      throw 'Environment keys and values must be non-null strings.'
    }
    $environmentMap.Add([string]$key, [string]$Environment[$key])
  }
  return [Morrow.Pilot.WindowsNativeJobInterop]::CreateAtomicSuspendedRoot(
    $ExecutablePath,
    [string[]]$ArgumentList,
    $environmentMap,
    $WorkingDirectory
  )
}
