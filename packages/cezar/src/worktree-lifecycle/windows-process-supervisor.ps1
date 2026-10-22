param([Parameter(Mandatory=$true)][string]$Payload)

$ErrorActionPreference = 'Stop'
$spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json

Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class CezarWindowsJobSupervisor {
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint STARTF_USESTDHANDLES = 0x00000100;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  const int JobObjectExtendedLimitInformation = 9;
  const int JobObjectBasicAccountingInformation = 1;
  const uint WAIT_OBJECT_0 = 0;
  const uint WAIT_TIMEOUT = 0x102;
  const uint GENERIC_READ = 0x80000000;
  const uint FILE_SHARE_READ = 1;
  const uint OPEN_EXISTING = 3;
  const int STD_INPUT_HANDLE = -10, STD_OUTPUT_HANDLE = -11, STD_ERROR_HANDLE = -12;

  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO { public uint cb; public string lpReserved, lpDesktop, lpTitle; public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }

  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref EXTENDED_LIMIT info, uint length);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr procAttrs, IntPtr threadAttrs, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out ACCOUNTING info, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr attrs, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);

  static void Check(bool ok, string action) { if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), action); }
  static string Quote(string value) { var b = new StringBuilder("\""); int slashes=0; foreach (char c in value) { if (c=='\\') { slashes++; continue; } if (c=='\"') { b.Append('\\', slashes*2+1).Append(c); slashes=0; continue; } b.Append('\\', slashes).Append(c); slashes=0; } b.Append('\\', slashes*2).Append('"'); return b.ToString(); }

  public static int Run(string executable, string command, string cwd, string nonce) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject");
    IntPtr processHandle=IntPtr.Zero, threadHandle=IntPtr.Zero, nul=IntPtr.Zero;
    bool assigned=false;
    try {
      var limits = new EXTENDED_LIMIT(); limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))), "SetInformationJobObject");
      nul = CreateFile("NUL", GENERIC_READ, FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
      if (nul == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Open NUL");
      Check(SetHandleInformation(nul, 1, 1), "Make NUL inheritable");
      var startup = new STARTUPINFO(); startup.cb=(uint)Marshal.SizeOf(typeof(STARTUPINFO)); startup.dwFlags=STARTF_USESTDHANDLES;
      startup.hStdInput=nul; startup.hStdOutput=GetStdHandle(STD_OUTPUT_HANDLE); startup.hStdError=GetStdHandle(STD_ERROR_HANDLE);
      var info = new PROCESS_INFORMATION(); var line = new StringBuilder(Quote(executable)+" -c "+Quote(command));
      if (!CreateProcess(executable, line, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED, IntPtr.Zero, cwd, ref startup, out info)) {
        Console.Error.WriteLine(nonce+":127:quiescent"); return 127;
      }
      processHandle=info.hProcess; threadHandle=info.hThread;
      if (!AssignProcessToJobObject(job, processHandle)) {
        int error=Marshal.GetLastWin32Error(); TerminateProcess(processHandle, 125); WaitForSingleObject(processHandle, 5000);
        throw new System.ComponentModel.Win32Exception(error, "AssignProcessToJobObject");
      }
      assigned=true;
      var controls = new BlockingCollection<string>();
      var reader = new Thread(() => { try { string inputLine; while ((inputLine=Console.ReadLine())!=null) controls.Add(inputLine); } catch {} finally { controls.Add("PARENT_CLOSED"); } }); reader.IsBackground=true; reader.Start();
      string start=null;
      while (start==null && !controls.TryTake(out start, 50)) {}
      if (start != "START") { TerminateJobObject(job, 125); WaitForEmpty(job); Console.Error.WriteLine(nonce+":125:quiescent"); return 125; }
      Check(ResumeThread(threadHandle) != 0xffffffff, "ResumeThread");
      int commandCode=1; bool stopping=false;
      while (true) {
        string control=null;
        if (controls.TryTake(out control, 20) && control!="START") { stopping=true; TerminateJobObject(job, 125); }
        uint status=WaitForSingleObject(processHandle, stopping ? 20u : 0u);
        if (status==WAIT_OBJECT_0) { uint code=1; GetExitCodeProcess(processHandle, out code); commandCode=stopping ? 130 : (int)code; break; }
        if (status!=WAIT_TIMEOUT) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject");
      }
      // Shell completion does not imply tree completion: terminate background descendants.
      TerminateJobObject(job, (uint)commandCode);
      WaitForEmpty(job);
      Console.Error.WriteLine(nonce+":"+commandCode+":quiescent"); return commandCode;
    } finally { if (!assigned && processHandle!=IntPtr.Zero) { TerminateProcess(processHandle, 125); WaitForSingleObject(processHandle, 5000); } if (threadHandle!=IntPtr.Zero) CloseHandle(threadHandle); if (processHandle!=IntPtr.Zero) CloseHandle(processHandle); if (nul!=IntPtr.Zero && nul!=new IntPtr(-1)) CloseHandle(nul); CloseHandle(job); }
  }
  static void WaitForEmpty(IntPtr job) { ACCOUNTING accounting; for (int i=0; i<400; i++) { Check(QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out accounting, (uint)Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero), "QueryInformationJobObject"); if (accounting.ActiveProcesses==0) return; Thread.Sleep(25); } throw new InvalidOperationException("Job process count did not reach zero"); }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
}
'@

try {
  $null = [CezarWindowsJobSupervisor]::Run([string]$spec.executable, [string]$spec.command, [string]$spec.cwd, [string]$spec.nonce)
  exit 0
} catch {
  [Console]::Error.WriteLine("Cezar Windows process supervisor failed: " + $_.Exception.Message)
  exit 125
}
