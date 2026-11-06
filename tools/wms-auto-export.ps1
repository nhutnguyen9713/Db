# ============================================================================
#  TN5 · Tự động Find + Export dữ liệu WMS trên Oracle Applications (Forms)
#  Chỉ dùng PowerShell có sẵn trong Windows — KHÔNG cần cài thêm phần mềm.
#
#  Cách dùng (để 3 file chung 1 thư mục):
#   - Nhấp đúp  Chay-WMS-Tu-Dong.bat  -> cứ 5 phút tự bấm Find rồi Export.
#                                        Muốn dừng: đóng cửa sổ đen (hoặc Ctrl+C).
#   - Nhấp đúp  Lay-Toa-Do.bat        -> rê chuột lên nút Find/Export, cửa sổ đen
#                                        hiện toạ độ, sửa lại phần CÀI ĐẶT bên dưới.
#  Lưu ý: script bấm chuột thật — đừng dùng chuột đúng lúc nó đang chạy (mỗi lượt
#  vài chục giây). Máy khoá màn hình (Win+L) thì không bấm được.
# ============================================================================
param([switch]$ToaDo, [switch]$MotLuot)

# ----------------------------- CÀI ĐẶT ---------------------------------------
$OracleTitle = 'Oracle Applications'   # 1 phần tiêu đề cửa sổ Oracle
$IntervalMin = 5                       # chạy lại sau mỗi bao nhiêu phút

# Toạ độ tính từ góc trên-trái cửa sổ Oracle (lấy bằng Lay-Toa-Do.bat).
# Run = $false để bỏ qua form đó. WaitFind/WaitExport = số giây chờ.
$Forms = @(
  @{ Name = 'Locator Allocate Query (ton kho)'; Run = $true
     Find = @(1130, 124); Export = @(1050, 161); WaitFind = 25; WaitExport = 20 },
  @{ Name = 'Locator Transaction (giao dich)'; Run = $false   # chỉ cần form Locator Allocate Query
     Find = @(1044, 628); Export = @(1123, 593); WaitFind = 15; WaitExport = 15 }
)

# (Tuỳ chọn) Tự đổi ô "Date From" của Locator Transaction về giờ bắt đầu ca
# (07:00 hoặc 19:00) trước khi Find. $false = giữ ngày bạn tự nhập.
$UpdateDateFrom = $false
$DateFromXY     = @(680, 627)

# Sau khi Export, nếu hiện hộp thoại lưu file thì tự gõ tên file kèm giờ vào thư
# mục này rồi Enter. Để '' = chỉ bấm Enter (lưu theo tên/thư mục mặc định).
$SaveDir = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'WMS_Export'
$SaveDialogTitles = @('Save As', 'Lưu', 'Export', 'File Download', 'Tải xuống')
# -----------------------------------------------------------------------------

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TN5W {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, int e);
  public static IntPtr Find(string part) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      if (sb.ToString().IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
}
"@
$wsh = New-Object -ComObject WScript.Shell

function Log($msg) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Host $line
  try { Add-Content -Path (Join-Path $PSScriptRoot 'wms-auto-export.log') -Value $line -Encoding UTF8 } catch {}
}
function Get-Oracle { [TN5W]::Find($OracleTitle) }
function Focus-Oracle($h) {
  if ([TN5W]::IsIconic($h)) { [void][TN5W]::ShowWindow($h, 9) }
  [void]$wsh.AppActivate([TN5W]::Title($h))
  [void][TN5W]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 500
}
function Click-At($h, $xy) {
  $r = New-Object TN5W+RECT; [void][TN5W]::GetWindowRect($h, [ref]$r)
  [void][TN5W]::SetCursorPos($r.L + $xy[0], $r.T + $xy[1])
  Start-Sleep -Milliseconds 150
  [TN5W]::mouse_event(0x02, 0, 0, 0, 0); Start-Sleep -Milliseconds 60; [TN5W]::mouse_event(0x04, 0, 0, 0, 0)
  Start-Sleep -Milliseconds 400
}
function Handle-SaveDialog($formName, $waitSec) {
  $deadline = (Get-Date).AddSeconds($waitSec)
  while ((Get-Date) -lt $deadline) {
    foreach ($t in $SaveDialogTitles) {
      $d = [TN5W]::Find($t)
      if ($d -ne [IntPtr]::Zero -and ([TN5W]::Title($d)) -notlike "*$OracleTitle*") {
        [void]$wsh.AppActivate([TN5W]::Title($d)); Start-Sleep -Milliseconds 600
        if ($SaveDir) {
          $tag = if ($formName -like '*Transaction*') { 'Transaction' } else { 'Ton_kho' }
          $name = Join-Path $SaveDir ('WMS_{0}_{1}' -f $tag, (Get-Date -Format 'yyyyMMdd_HHmm'))
          $wsh.SendKeys('^a'); Start-Sleep -Milliseconds 200
          Set-Clipboard -Value $name; $wsh.SendKeys('^v'); Start-Sleep -Milliseconds 300
        }
        $wsh.SendKeys('{ENTER}'); Start-Sleep -Seconds 2
        if ([TN5W]::Find('Confirm Save As') -ne [IntPtr]::Zero -or [TN5W]::Find('Xác nhận') -ne [IntPtr]::Zero) { $wsh.SendKeys('%y') }
        Log "  -> da luu: $formName"
        return
      }
    }
    Start-Sleep -Milliseconds 500
  }
}
function Set-DateFrom($h) {
  $now = Get-Date
  if ($now.Hour -lt 7) { $d = $now.AddDays(-1); $hh = '19' } elseif ($now.Hour -lt 19) { $d = $now; $hh = '07' } else { $d = $now; $hh = '19' }
  $mon = @('JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC')[$d.Month - 1]
  $val = '{0:dd}-{1}-{0:yyyy} {2}:00:00' -f $d, $mon, $hh
  Click-At $h $DateFromXY
  $wsh.SendKeys('^a'); $wsh.SendKeys($val); $wsh.SendKeys('{TAB}')
  Start-Sleep -Milliseconds 300
}
function Run-Cycle {
  $h = Get-Oracle
  if ($h -eq [IntPtr]::Zero) { Log 'Khong thay cua so Oracle - bo qua luot nay'; return }
  foreach ($f in $Forms) {
    if (-not $f.Run) { continue }
    Focus-Oracle $h
    if ($UpdateDateFrom -and $f.Name -like '*Transaction*') { Set-DateFrom $h }
    Click-At $h $f.Find
    Start-Sleep -Seconds $f.WaitFind
    Focus-Oracle $h
    Click-At $h $f.Export
    Handle-SaveDialog $f.Name $f.WaitExport
  }
  Focus-Oracle $h
  Log 'Xong 1 luot Find + Export'
}

if ($ToaDo) {
  Write-Host 'Re chuot len nut can lay toa do. Dong cua so nay de thoat.' -ForegroundColor Yellow
  while ($true) {
    $h = Get-Oracle
    $p = New-Object TN5W+POINT; [void][TN5W]::GetCursorPos([ref]$p)
    if ($h -eq [IntPtr]::Zero) { Write-Host "`rKhong thay cua so Oracle...            " -NoNewline }
    else {
      $r = New-Object TN5W+RECT; [void][TN5W]::GetWindowRect($h, [ref]$r)
      Write-Host ("`rToa do trong cua so Oracle: @({0}, {1})        " -f ($p.X - $r.L), ($p.Y - $r.T)) -NoNewline
    }
    Start-Sleep -Milliseconds 300
  }
}

if ($SaveDir -and -not (Test-Path $SaveDir)) { New-Item -ItemType Directory -Path $SaveDir | Out-Null }
if ($MotLuot) { Run-Cycle; return }
Log "Bat dau - moi $IntervalMin phut tu Find + Export. Dong cua so nay de dung."
Start-Sleep -Seconds 5
while ($true) {
  try { Run-Cycle } catch { Log ("Loi: " + $_.Exception.Message) }
  Start-Sleep -Seconds ($IntervalMin * 60)
}
