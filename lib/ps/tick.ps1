# dsh-screen-vision-win :: one collection pass = foreground window + UIA tree + GDI+ screenshot.
#
# Two modes, chosen by -Mode:
#   oneshot : do one pass from the given params, write the result files, exit.
#   worker  : stay alive and serve passes requested on stdin, one line per pass:
#             id|maxNodes|maxDepth|wantTree|wantShot|jsonPath|pngPath
#             answered on stdout with "id|OK" or "id|ERR|message". Warming Add-Type up
#             once is what makes sub-second polling possible: process start plus assembly
#             load alone costs ~1.0s (measured), while the pass itself costs ~0.5s.
#
# Keep this file pure ASCII: PowerShell 5.1 decodes a BOM-less file as ANSI, so non-ASCII
# comments become mojibake. Also avoid PS backtick escapes and C-style block comments
# (5.1 parses a leading slash-star as a command name).
#
# Traps this script deliberately avoids (each one broke v1.1.0 on Windows):
#   - Add-Type System.Windows.Forms must precede any [System.Windows.Forms.Screen] use
#   - SetProcessDPIAware must precede reading Bounds: otherwise the screenshot is in logical
#     pixels while UIA rectangles are physical (they differ by the display scale factor)
#   - never assign the read-only automatic variable pid (VariableNotWritable aborts the run)
#   - [json]::Escape does not exist in 5.1; use ConvertTo-Json
#   - BoundingRectangle X/Y can be Infinity for off-screen or hidden elements; a bare Infinity
#     in the JSON makes Node JSON.parse throw, which v1.1.0 surfaced as "UI Automation
#     unavailable". Normalize every rectangle number through DshNum.
#   - results go to UTF-8 files, not stdout: redirected stdout uses the OEM codepage (936 on
#     this machine) and destroys non-ASCII window titles irreversibly
#   - the UIA walk starts at FromHandle(foreground hwnd); the desktop root only exposes twenty-
#     some shell nodes and never the foreground application internals
param(
  [string]$Mode = "oneshot",
  [string]$MaxNodes = "600",
  [string]$MaxDepth = "12",
  [string]$WantTree = "1",
  [string]$WantShot = "1",
  [string]$JsonPath = "",
  [string]$PngPath = "",
  [string]$WorkDir = ""
)
$ErrorActionPreference = 'SilentlyContinue'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Text;
public class DshVisionWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint procId);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  // OpenProcess plus QueryFullProcessImageName beats Process.GetProcessById here: it does not
  // snapshot the process list, tolerates a process we cannot fully query, and never throws when
  // the process exits mid-tick. An empty name would silently kill window_switch events.
  public static string ProcName(uint procId) {
    if (procId == 0) return "";
    try {
      IntPtr h = OpenProcess(0x1000, false, procId);
      if (h != IntPtr.Zero) {
        try {
          StringBuilder sb = new StringBuilder(1024);
          uint size = (uint)sb.Capacity;
          if (QueryFullProcessImageName(h, 0, sb, ref size)) {
            string leaf = System.IO.Path.GetFileNameWithoutExtension(sb.ToString());
            if (!string.IsNullOrEmpty(leaf)) return leaf;
          }
        } finally { CloseHandle(h); }
      }
    } catch { }
    try { return Process.GetProcessById((int)procId).ProcessName; } catch { return ""; }
  }
}
"@
[void][DshVisionWin32]::SetProcessDPIAware()

function DshNum([double]$v) {
  if ([double]::IsNaN($v)) { return 0 }
  if ([double]::IsPositiveInfinity($v)) { return 0 }
  if ([double]::IsNegativeInfinity($v)) { return 0 }
  return [int][math]::Round($v)
}

$script:walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function DshWalk($el, $depth) {
  if ($null -eq $el) { return }
  if ($script:nodes.Count -ge $script:nodeCap) { $script:truncated = $true; return }
  try {
    $name = $el.Current.Name
    $cls = $el.Current.ClassName
    $aid = $el.Current.AutomationId
    $ct = $el.Current.ControlType.ProgrammaticName
    $rect = $el.Current.BoundingRectangle
    $isPass = $false
    try { $isPass = $el.Current.IsPassword } catch {}
    $hasFocus = $false
    try { $hasFocus = $el.Current.HasKeyboardFocus } catch {}
    $click = $false
    $scroll = $false
    $inputf = $false
    try { if ($el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)) { $click = $true } } catch {}
    try { if ($el.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)) { $scroll = $true } } catch {}
    try { if ($el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)) { $inputf = $true } } catch {}
    try { if ($el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)) { $inputf = $true } } catch {}
    if ($name -or $cls -or $aid -or $click -or $scroll -or $inputf) {
      [void]$script:nodes.Add(@{
        text = $name
        desc = $name
        cls = $cls
        automationId = $aid
        controlType = $ct
        x = (DshNum $rect.X)
        y = (DshNum $rect.Y)
        w = (DshNum $rect.Width)
        h = (DshNum $rect.Height)
        clickable = $click
        scrollable = $scroll
        input = $inputf
        password = $isPass
        focused = $hasFocus
        depth = $depth
      })
    }
    if ($depth -lt $script:depthCap) {
      $child = $script:walker.GetFirstChild($el)
      while ($child) {
        DshWalk $child ($depth + 1)
        if ($script:nodes.Count -ge $script:nodeCap) { $script:truncated = $true; break }
        $child = $script:walker.GetNextSibling($child)
      }
    }
  } catch {}
}

function DshPass($MaxNodes, $MaxDepth, $WantTree, $WantShot, $JsonPath, $PngPath) {
  $script:nodeCap = [int]$MaxNodes
  $script:depthCap = [int]$MaxDepth
  $script:truncated = $false
  $script:nodes = New-Object System.Collections.ArrayList

  $out = [ordered]@{ ok = $true }

  $hwnd = [DshVisionWin32]::GetForegroundWindow()
  $winPid = 0
  $title = ""
  $procName = ""
  $fg = [ordered]@{ left = 0; top = 0; width = 0; height = 0 }
  if ($hwnd -ne [IntPtr]::Zero) {
    $len = [DshVisionWin32]::GetWindowTextLength($hwnd)
    $sb = New-Object System.Text.StringBuilder($len + 1)
    [void][DshVisionWin32]::GetWindowText($hwnd, $sb, $sb.Capacity)
    $title = $sb.ToString()
    [void][DshVisionWin32]::GetWindowThreadProcessId($hwnd, [ref]$winPid)
    $procName = [DshVisionWin32]::ProcName($winPid)
    $rc = New-Object ('DshVisionWin32+RECT')
    [void][DshVisionWin32]::GetWindowRect($hwnd, [ref]$rc)
    $fg.left = $rc.Left
    $fg.top = $rc.Top
    $fg.width = ($rc.Right - $rc.Left)
    $fg.height = ($rc.Bottom - $rc.Top)
  }
  $out.title = $title
  $out.processName = $procName
  $out.windowPid = $winPid
  $out.fgRect = $fg

  $screen = [System.Windows.Forms.Screen]::PrimaryScreen
  $bounds = $screen.Bounds
  $out.screenW = $bounds.Width
  $out.screenH = $bounds.Height

  $treeRoot = ""
  if ($WantTree -eq "1") {
    try {
      $el = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
      if ($el) { $treeRoot = "foreground"; DshWalk $el 0 }
    } catch {}
    if ($script:nodes.Count -lt 3) {
      try {
        $rootEl = [System.Windows.Automation.AutomationElement]::RootElement
        if ($rootEl) {
          $script:nodes = New-Object System.Collections.ArrayList
          $treeRoot = "desktop-root"
          DshWalk $rootEl 0
        }
      } catch {}
    }
  }
  $out.treeRoot = $treeRoot
  $out.nodes = @($script:nodes)
  $out.truncated = $script:truncated

  if ($WantShot -eq "1") {
    try {
      $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
      $gfx = [System.Drawing.Graphics]::FromImage($bmp)
      $gfx.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
      $gfx.Dispose()
      $bmp.Save($PngPath, [System.Drawing.Imaging.ImageFormat]::Png)
      $bmp.Dispose()
      $out.pngPath = $PngPath
    } catch {
      $out.shotError = "screenshot failed: " + $_.Exception.Message
    }
  }

  $json = $out | ConvertTo-Json -Compress -Depth 8
  [System.IO.File]::WriteAllText($JsonPath, [string]$json, (New-Object System.Text.UTF8Encoding($false)))
}

if ($Mode -eq "worker") {
  # Wire protocol note: a redirected PowerShell stdin decodes bytes with the OEM codepage
  # (936 here), so a path containing non-ASCII characters arrives mangled. Therefore every
  # path travels as a process argument (wide-char, lossless) and each request line carries
  # only ASCII: id|maxNodes|maxDepth|wantTree|wantShot. Results land in $WorkDir named after
  # the id, and error text returns base64-encoded to survive the same codepage on the way out.
  if ($WorkDir -eq "") {
    [Console]::Out.WriteLine("NOREPLY|")
    [Console]::Out.Flush()
    exit 1
  }
  $script:wd = $WorkDir.TrimEnd('\')
  [Console]::Out.WriteLine("READY|")
  [Console]::Out.Flush()
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line -eq "EXIT") { break }
    $parts = $line.Split('|')
    if ($parts.Count -lt 5) { continue }
    $id = $parts[0]
    $jp = $script:wd + "\pass-" + $id + ".json"
    $pp = $script:wd + "\pass-" + $id + ".png"
    try {
      DshPass $parts[1] $parts[2] $parts[3] $parts[4] $jp $pp
      [Console]::Out.WriteLine($id + "|OK")
    } catch {
      $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$_.Exception.Message))
      [Console]::Out.WriteLine($id + "|ERR|" + $b64)
    }
    [Console]::Out.Flush()
  }
} else {
  DshPass $MaxNodes $MaxDepth $WantTree $WantShot $JsonPath $PngPath
}
