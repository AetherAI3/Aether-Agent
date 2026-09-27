// The PowerShell warden program, as a string. It is spawned once per managed
// group and holds a Windows Job Object handle for that group's lifetime.
//
// Why a PowerShell child at all: this package ships with ZERO runtime
// dependencies and must stay that way, so there is no native addon to call
// CreateJobObject/AssignProcessToJobObject. PowerShell's Add-Type compiles a
// tiny C# P/Invoke shim in-process, which is the dependency-free way to reach
// kernel32 from Node on Windows.
//
// The job is created with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, so if the warden
// ever dies — crash, daemon exit, machine going down — the OS tears down every
// process still in the job. That is the containment guarantee: a managed group
// cannot outlive the warden that owns it.
//
// Protocol: line-delimited JSON on stdio. Each request is one JSON object with
// an `op`; each reply is one JSON object with `ok` plus op-specific fields.

export const WARDEN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AetherJob {
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
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
  struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }
  const int JobObjectExtendedLimitInformation = 9;
  const int JobObjectBasicProcessIdList = 3;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
  const uint PROCESS_TERMINATE = 0x0001;
  const uint PROCESS_SET_QUOTA = 0x0100;

  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr h, int c, IntPtr info, uint len);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr h, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool TerminateJobObject(IntPtr h, uint code);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool QueryInformationJobObject(IntPtr h, int c, IntPtr info, uint len, IntPtr ret);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool CloseHandle(IntPtr h);

  static IntPtr job = IntPtr.Zero;

  public static void Create(string name) {
    job = CreateJobObject(IntPtr.Zero, name);
    if (job == IntPtr.Zero) throw new Exception("CreateJobObject failed: " + Marshal.GetLastWin32Error());
    var ext = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    ext.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    int len = Marshal.SizeOf(ext);
    IntPtr p = Marshal.AllocHGlobal(len);
    try {
      Marshal.StructureToPtr(ext, p, false);
      if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, p, (uint)len))
        throw new Exception("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(p); }
  }
  public static void Assign(int pid) {
    IntPtr h = OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, false, (uint)pid);
    if (h == IntPtr.Zero) throw new Exception("OpenProcess failed: " + Marshal.GetLastWin32Error());
    try {
      if (!AssignProcessToJobObject(job, h))
        throw new Exception("AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error());
    } finally { CloseHandle(h); }
  }
  public static void Terminate() {
    if (job != IntPtr.Zero) TerminateJobObject(job, 1);
  }
  public static int[] ListPids() {
    if (job == IntPtr.Zero) return new int[0];
    int entry = IntPtr.Size;
    int cap = 1024;
    int size = 8 + entry * cap;
    IntPtr buf = Marshal.AllocHGlobal(size);
    try {
      if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, buf, (uint)size, IntPtr.Zero))
        return new int[0];
      int n = Marshal.ReadInt32(buf, 4);
      if (n < 0) n = 0;
      if (n > cap) n = cap;
      int[] pids = new int[n];
      for (int i = 0; i < n; i++) {
        IntPtr v = Marshal.ReadIntPtr(buf, 8 + i * entry);
        pids[i] = (int)v.ToInt64();
      }
      return pids;
    } finally { Marshal.FreeHGlobal(buf); }
  }
}
"@

$stdin = [Console]::In
while (($line = $stdin.ReadLine()) -ne $null) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $resp = $null
  try {
    $msg = $line | ConvertFrom-Json
    switch ([string]$msg.op) {
      'ping'      { $resp = @{ ok = $true; op = 'ping' } }
      'create'    { [AetherJob]::Create([string]$msg.name); $resp = @{ ok = $true; op = 'create'; name = [string]$msg.name } }
      'assign'    { [AetherJob]::Assign([int]$msg.pid); $resp = @{ ok = $true; op = 'assign'; pid = [int]$msg.pid } }
      'list'      { $pids = [AetherJob]::ListPids(); $resp = @{ ok = $true; op = 'list'; pids = @($pids) } }
      'terminate' { [AetherJob]::Terminate(); $resp = @{ ok = $true; op = 'terminate' } }
      default     { $resp = @{ ok = $false; op = [string]$msg.op; error = 'unknown op' } }
    }
  } catch {
    $resp = @{ ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
`;
