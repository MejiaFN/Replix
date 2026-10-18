# Replix background helper. Prints one JSON object per line:
#   {"t":"fg", ...}   the foreground window (process, title, rect, fullscreen) when it changes
#   {"t":"pad","b":N} XInput button bitmask for the first connected controller when it changes
# Exits on its own when the Replix process (-ParentPid) is gone.
param([int]$ParentPid = 0)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class RxWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct XGAMEPAD { public ushort wButtons; public byte bLT; public byte bRT; public short sLX, sLY, sRX, sRY; }
  [StructLayout(LayoutKind.Sequential)] public struct XSTATE { public uint dwPacketNumber; public XGAMEPAD Gamepad; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("xinput1_4.dll")] public static extern uint XInputGetState(uint i, out XSTATE s);
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
}
"@
[RxWin]::SetProcessDPIAware() | Out-Null

$lastFg = ''
$lastPad = -1
$tick = 0
while ($true) {
  # Controller: poll every 50 ms
  $b = 0
  for ($i = 0; $i -lt 4; $i++) {
    $s = New-Object RxWin+XSTATE
    if ([RxWin]::XInputGetState($i, [ref]$s) -eq 0) { $b = [int]$s.Gamepad.wButtons; break }
  }
  if ($b -ne $lastPad) { $lastPad = $b; [Console]::Out.WriteLine('{"t":"pad","b":' + $b + '}'); [Console]::Out.Flush() }

  # Foreground window: every 1 s
  if ($tick % 20 -eq 0) {
    if ($ParentPid -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit }
    $h = [RxWin]::GetForegroundWindow()
    $procId = [uint32]0
    [RxWin]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
    $r = New-Object RxWin+RECT
    [RxWin]::GetWindowRect($h, [ref]$r) | Out-Null
    $mi = New-Object RxWin+MONITORINFO
    $mi.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($mi)
    [RxWin]::GetMonitorInfo([RxWin]::MonitorFromWindow($h, 2), [ref]$mi) | Out-Null
    $m = $mi.rcMonitor
    $full = ($r.L -le $m.L -and $r.T -le $m.T -and $r.R -ge $m.R -and $r.B -ge $m.B)
    $name = ''
    try { $name = (Get-Process -Id $procId).ProcessName } catch {}
    $o = [ordered]@{ t = 'fg'; pid = $procId; exe = $name; title = [RxWin]::Title($h);
      x = $r.L; y = $r.T; w = $r.R - $r.L; h = $r.B - $r.T;
      mx = $m.L; my = $m.T; mw = $m.R - $m.L; mh = $m.B - $m.T; full = $full }
    $j = $o | ConvertTo-Json -Compress
    if ($j -ne $lastFg) { $lastFg = $j; [Console]::Out.WriteLine($j); [Console]::Out.Flush() }
  }
  $tick++
  Start-Sleep -Milliseconds 50
}
