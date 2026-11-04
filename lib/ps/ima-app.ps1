# dsh-ima - ima desktop client helper (Windows, ASCII-only on purpose)
#
# PowerShell 5.1 decodes .ps1 with the ANSI code page, so any non-ASCII literal in
# this file corrupts parsing on non-English Windows. Keep it ASCII; all Chinese
# user-facing wording lives in lib/app.js.
#
# Safety model - verify before acting, because typing into the wrong window is
# destructive and silent:
#   1. SetProcessDPIAware() before any coordinate math, otherwise GetWindowRect
#      returns logical pixels while the window lives in physical pixels and every
#      derived click point is offset.
#   2. WindowFromPoint + PID ownership check BEFORE clicking: refuse if the point
#      does not belong to the ima process.
#   3. GetForegroundWindow + PID check BEFORE every keystroke: refuse if ima does
#      not own the foreground.
#   4. Report what was actually verified (foregroundVerified / pointPid) instead of
#      assuming the intent succeeded, and offer -DryRun to rehearse without acting.
#
# Actions:
#   status - process count / real window handle / visibility / executable path
#   ensure - start ima if needed, wait for a window, force it visible
#   open   - ensure + focus, optionally open a URL (via imacopilot:// deep link)
#   ask    - focus, verify ownership, click composer, paste question, press Enter
#            (delivers only; cannot read the answer back - see lib/app.js)
#
# Output: exactly one line of JSON on stdout.
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('status', 'ensure', 'open', 'ask')]
  [string]$Action,

  [string]$Url = '',
  [string]$Question = '',
  [string]$Executable = '',
  [int]$LaunchTimeoutMs = 20000,
  [int]$SettleMs = 1200,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# MUST come before any coordinate math: without it GetWindowRect/SetCursorPos speak
# in virtualized (logical) pixels while the window really lives in physical pixels.
Add-Type -AssemblyName System.Windows.Forms
if (-not ('DshImaWin32' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DshImaWin32 {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder buffer, int maxCount);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int width, int height, bool repaint);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

  public static uint PidOfWindow(IntPtr hWnd) {
    uint pid;
    GetWindowThreadProcessId(hWnd, out pid);
    return pid;
  }

  public static uint ThreadOfWindow(IntPtr hWnd) {
    uint pid;
    return GetWindowThreadProcessId(hWnd, out pid);
  }

  public static IntPtr FindWindowForProcess(uint targetPid) {
    IntPtr found = IntPtr.Zero;
    int bestArea = 0;
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (pid != targetPid) return true;
      RECT rect;
      if (!GetWindowRect(hWnd, out rect)) return true;
      int width = rect.Right - rect.Left;
      int height = rect.Bottom - rect.Top;
      if (width < 400 || height < 300) return true;
      StringBuilder name = new StringBuilder(256);
      GetClassName(hWnd, name, 256);
      if (name.ToString().IndexOf("Chrome_WidgetWin_1", StringComparison.Ordinal) < 0) return true;
      int area = width * height;
      if (area > bestArea) { bestArea = area; found = hWnd; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
}
# MUST run after the type exists, and before any coordinate math: without DPI
# awareness GetWindowRect/SetCursorPos speak logical pixels while the window really
# lives in physical pixels (this mismatch is what misdirected the 2026-11-04 click).
try { [void][DshImaWin32]::SetProcessDPIAware() } catch { }

function Emit($obj) {
  ($obj | ConvertTo-Json -Compress -Depth 6)
}

function Get-ImaProcesses {
  @(Get-Process -Name 'ima.copilot' -ErrorAction SilentlyContinue)
}

function Get-ImaPids {
  @(Get-ImaProcesses | ForEach-Object { [uint32]$_.Id })
}

function Find-ImaWindow {
  $best = [IntPtr]::Zero
  $bestArea = 0
  foreach ($proc in Get-ImaProcesses) {
    $handle = [DshImaWin32]::FindWindowForProcess([uint32]$proc.Id)
    if ($handle -eq [IntPtr]::Zero) { continue }
    $rect = New-Object DshImaWin32+RECT
    if (-not [DshImaWin32]::GetWindowRect($handle, [ref]$rect)) { continue }
    $area = ($rect.Right - $rect.Left) * ($rect.Bottom - $rect.Top)
    if ($area -gt $bestArea) { $bestArea = $area; $best = $handle }
  }
  return $best
}

function Resolve-Exe {
  if ($Executable -and (Test-Path -LiteralPath $Executable)) { return $Executable }
  $proc = Get-ImaProcesses | Where-Object { $_.Path } | Select-Object -First 1
  if ($proc) { return $proc.Path }
  foreach ($candidate in @(
      (Join-Path $env:LOCALAPPDATA 'Programs\ima\ima.copilot.exe'),
      'C:\Program Files\Tencent\ima\ima.copilot.exe',
      'C:\Program Files (x86)\Tencent\ima\ima.copilot.exe')) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return ''
}

function Get-Status {
  $procs = Get-ImaProcesses
  $handle = Find-ImaWindow
  $rect = New-Object DshImaWin32+RECT
  $hasRect = $false
  $visible = $false
  $minimized = $false
  if ($handle -ne [IntPtr]::Zero) {
    $hasRect = [DshImaWin32]::GetWindowRect($handle, [ref]$rect)
    $visible = [DshImaWin32]::IsWindowVisible($handle)
    $minimized = [DshImaWin32]::IsIconic($handle)
  }
  return [ordered]@{
    ok = $true
    action = 'status'
    running = ($procs.Count -gt 0)
    processCount = $procs.Count
    windowHandle = [int64]$handle
    hasWindow = ($handle -ne [IntPtr]::Zero)
    visible = $visible
    minimized = $minimized
    rect = ($(if ($hasRect) { [ordered]@{ left = $rect.Left; top = $rect.Top; width = ($rect.Right - $rect.Left); height = ($rect.Bottom - $rect.Top) } } else { $null }))
    executable = (Resolve-Exe)
  }
}

function Bring-ToFront([IntPtr]$handle) {
  # SetForegroundWindow alone is refused while another app owns the foreground
  # (Windows foreground lock). AttachThreadInput into the foreground thread, plus a
  # brief topmost toggle, is the combination that actually raises the window.
  [void][DshImaWin32]::ShowWindow($handle, 5)
  [void][DshImaWin32]::ShowWindow($handle, 9)
  $foreground = [DshImaWin32]::GetForegroundWindow()
  $myThread = [DshImaWin32]::GetCurrentThreadId()
  if ($foreground -ne [IntPtr]::Zero) {
    $fgThread = [DshImaWin32]::ThreadOfWindow($foreground)
    if ($fgThread -ne 0 -and $fgThread -ne $myThread) {
      [void][DshImaWin32]::AttachThreadInput($fgThread, $myThread, $true)
      [void][DshImaWin32]::BringWindowToTop($handle)
      [void][DshImaWin32]::SetForegroundWindow($handle)
      [void][DshImaWin32]::AttachThreadInput($fgThread, $myThread, $false)
    }
  }
  [void][DshImaWin32]::SetForegroundWindow($handle)
  $SWP_NOSIZE = 0x0001
  $SWP_NOMOVE = 0x0002
  $SWP_SHOWWINDOW = 0x0040
  [void][DshImaWin32]::SetWindowPos($handle, [IntPtr](-1), 0, 0, 0, 0, ($SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_SHOWWINDOW))
  [void][DshImaWin32]::SetWindowPos($handle, [IntPtr](-2), 0, 0, 0, 0, ($SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_SHOWWINDOW))
  [void][DshImaWin32]::SetForegroundWindow($handle)
  Start-Sleep -Milliseconds 300
}

function Show-ImaWindow([IntPtr]$handle) {
  if ($handle -eq [IntPtr]::Zero) { throw 'no ima window handle found (process not running?)' }
  Bring-ToFront $handle
}

function Ensure-Running {
  $status = Get-Status
  if ($status.hasWindow) {
    Show-ImaWindow ([IntPtr]$status.windowHandle)
    [void](Ensure-WindowOnScreen ([IntPtr]$status.windowHandle))
    return (Get-Status)
  }
  $exe = Resolve-Exe
  if (-not $exe) { throw 'ima.copilot.exe not found; set app.executable in the dsh-ima config' }
  # Launch the exe in BOTH cases: not running (start it) and running-but-windowless
  # (a second launch is what makes the tray instance surface its window).
  Start-Process -FilePath $exe | Out-Null
  $deadline = (Get-Date).AddMilliseconds($LaunchTimeoutMs)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
    $now = Get-Status
    if ($now.hasWindow) {
      Show-ImaWindow ([IntPtr]$now.windowHandle)
      [void](Ensure-WindowOnScreen ([IntPtr]$now.windowHandle))
      return (Get-Status)
    }
  }
  throw "ima is running but exposes no Chrome_WidgetWin_1 window within ${LaunchTimeoutMs}ms (it may sit in the tray; click its tray icon once, then retry)"
}

function Ensure-WindowOnScreen([IntPtr]$handle) {
  # The tray/restore dance can leave the window mostly below the screen edge
  # (observed: rect -64,1639 on a 3200x2000 screen). A click point derived from such
  # a rect lands outside the window - and outside the screen - so move it back in
  # first and report it instead of pretending the geometry is fine.
  $rect = New-Object DshImaWin32+RECT
  if (-not [DshImaWin32]::GetWindowRect($handle, [ref]$rect)) { return $false }
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $winLeft = [Math]::Max($rect.Left, $bounds.Left)
  $winTop = [Math]::Max($rect.Top, $bounds.Top)
  $winRight = [Math]::Min($rect.Right, $bounds.Right)
  $winBottom = [Math]::Min($rect.Bottom, $bounds.Bottom)
  $visibleW = [Math]::Max(0, $winRight - $winLeft)
  $visibleH = [Math]::Max(0, $winBottom - $winTop)
  $area = [Math]::Max(1, ($rect.Right - $rect.Left) * ($rect.Bottom - $rect.Top))
  $visibleRatio = ($visibleW * $visibleH) / $area
  if ($visibleRatio -ge 0.6) { return $false }

  $width = [Math]::Min($rect.Right - $rect.Left, [int]($bounds.Width * 0.8))
  $height = [Math]::Min($rect.Bottom - $rect.Top, [int]($bounds.Height * 0.85))
  $x = $bounds.Left + [int](($bounds.Width - $width) / 2)
  $y = $bounds.Top + [int](($bounds.Height - $height) / 2)
  [void][DshImaWin32]::MoveWindow($handle, $x, $y, $width, $height, $true)
  Start-Sleep -Milliseconds 400
  return $true
}

function Assert-PointBelongsToIma([int]$x, [int]$y) {
  $point = New-Object DshImaWin32+POINT
  $point.X = $x
  $point.Y = $y
  $hwnd = [DshImaWin32]::WindowFromPoint($point)
  if ($hwnd -eq [IntPtr]::Zero) { throw "no window at ($x,$y)" }
  $pidAtPoint = [DshImaWin32]::PidOfWindow($hwnd)
  if (-not ((Get-ImaPids) -contains $pidAtPoint)) {
    throw "point ($x,$y) belongs to pid $pidAtPoint, not ima - refusing to click/type there (another app is on top)"
  }
  return $pidAtPoint
}

function Assert-ImaForeground([IntPtr]$handle) {
  $deadline = (Get-Date).AddMilliseconds(2500)
  while ((Get-Date) -lt $deadline) {
    $fg = [DshImaWin32]::GetForegroundWindow()
    if ($fg -ne [IntPtr]::Zero) {
      $fgPid = [DshImaWin32]::PidOfWindow($fg)
      if ((Get-ImaPids) -contains $fgPid) { return $true }
    }
    Bring-ToFront $handle
  }
  throw 'ima is not the foreground window - refusing to send keystrokes (they would land in another app)'
}

try {
  switch ($Action) {
    'status' { Emit (Get-Status) }

    'ensure' { Emit (Ensure-Running) }

    'open' {
      $status = Ensure-Running
      if ($Url) {
        if ($Url -match '^[a-zA-Z][a-zA-Z0-9+.-]*://' -and $Url -notmatch '^https?://') {
          Start-Process -FilePath $Url | Out-Null
        } else {
          $deep = 'imacopilot://open?url=' + [System.Uri]::EscapeDataString($Url)
          Start-Process -FilePath $deep | Out-Null
        }
        Start-Sleep -Milliseconds $SettleMs
      }
      $after = Get-Status
      Emit ([ordered]@{ ok = $true; action = 'open'; url = $Url; windowHandle = $after.windowHandle; visible = $after.visible })
    }

    'ask' {
      if (-not $Question) { throw 'ask requires -Question' }
      $status = Ensure-Running
      $handle = [IntPtr]$status.windowHandle

      # Order matters and is the whole fix: raise ima FIRST, prove it owns the
      # foreground, and only then compute a click point from its (now truthful) rect.
      Bring-ToFront $handle
      $foregroundVerified = Assert-ImaForeground $handle

      $rect = New-Object DshImaWin32+RECT
      if (-not [DshImaWin32]::GetWindowRect($handle, [ref]$rect)) { throw 'cannot read ima window rect' }
      $width = $rect.Right - $rect.Left
      $height = $rect.Bottom - $rect.Top
      $clickX = [int]($rect.Left + $width * 0.55)
      # 0.10 (not 0.16): the composer is docked to the bottom of the content pane and
      # its centre sits ~10% of the window height above the bottom edge. At 0.16 the
      # click landed ~30px ABOVE the input (in the suggested-questions strip), so the
      # typed text went nowhere. Verified against a 2560x1700 window.
      $clickY = [int]($rect.Bottom - $height * 0.10)

      # The point must really be ima's, checked BEFORE any click.
      $pointPid = Assert-PointBelongsToIma $clickX $clickY

      $result = [ordered]@{
        ok = $true
        action = 'ask'
        delivered = $false
        readBack = $false
        dryRun = [bool]$DryRun
        foregroundVerified = $foregroundVerified
        pointPid = $pointPid
        click = [ordered]@{ x = $clickX; y = $clickY }
        rect = [ordered]@{ left = $rect.Left; top = $rect.Top; width = $width; height = $height }
        windowHandle = [int]$handle
      }

      if (-not $DryRun) {
        [void][DshImaWin32]::SetCursorPos($clickX, $clickY)
        Start-Sleep -Milliseconds 120
        [DshImaWin32]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
        [DshImaWin32]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
        Start-Sleep -Milliseconds 250
        # The click may have moved focus: re-assert before touching the keyboard.
        $foregroundVerified = Assert-ImaForeground $handle
        $result.foregroundVerified = $foregroundVerified

        Set-Clipboard -Value $Question
        Start-Sleep -Milliseconds 150
        [void](Assert-ImaForeground $handle)
        [System.Windows.Forms.SendKeys]::SendWait('^a')
        [System.Windows.Forms.SendKeys]::SendWait('{DEL}')
        Start-Sleep -Milliseconds 100
        [void](Assert-ImaForeground $handle)
        [System.Windows.Forms.SendKeys]::SendWait('^v')
        Start-Sleep -Milliseconds 300
        [void](Assert-ImaForeground $handle)
        [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
        Start-Sleep -Milliseconds $SettleMs
        $result.delivered = $true
        # Post-check: report the truth, not the intention.
        $result.deliveredWhileImaForeground = ((Get-ImaPids) -contains ([DshImaWin32]::PidOfWindow([DshImaWin32]::GetForegroundWindow())))
      }

      Emit $result
    }
  }
} catch {
  Emit ([ordered]@{ ok = $false; action = $Action; error = ($_.Exception.Message) })
  exit 1
}
