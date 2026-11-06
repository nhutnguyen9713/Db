; ============================================================================
;  TN5 · Tự động Find + Export dữ liệu WMS trên Oracle Applications (Forms)
;  Cần cài AutoHotkey v2: https://www.autohotkey.com  (bấm "Download v2")
;
;  Cách dùng:
;   1. Mở Oracle, mở sẵn 2 form "Locator Allocate Query" và "Locator Transaction"
;      đúng vị trí như bình thường (cửa sổ Oracle phóng to toàn màn hình).
;   2. Nhấp đúp file này để chạy. Biểu tượng chữ H xanh hiện ở góc phải taskbar.
;   3. Lần đầu: rê chuột lên từng nút (Find / Export của mỗi form) rồi bấm F8 để
;      xem toạ độ, sửa lại các số ở phần CÀI ĐẶT bên dưới nếu khác.
;
;  Phím tắt:  F7 = chạy 1 lượt ngay   F8 = xem toạ độ chuột
;             F9 = tạm dừng / chạy tiếp   F10 = thoát script
;
;  Lưu ý: script bấm chuột thật nên đừng dùng chuột đúng lúc nó đang chạy (mỗi
;  lượt vài chục giây). Máy bị khoá màn hình (Win+L) thì script không bấm được.
; ============================================================================
#Requires AutoHotkey v2.0
#SingleInstance Force

; ----------------------------- CÀI ĐẶT ---------------------------------------
ORACLE_TITLE   := "Oracle Applications"   ; 1 phần tiêu đề cửa sổ Oracle
INTERVAL_MIN   := 5                        ; chạy lại sau mỗi bao nhiêu phút

; Toạ độ tính theo cửa sổ Oracle (lấy bằng F8). Đặt RUN := false để bỏ qua form đó.
FORMS := [
  { name: "Locator Allocate Query (tồn kho)", RUN: true
  , find: [1130, 124], export: [1050, 161], waitFind: 25, waitExport: 20 },
  { name: "Locator Transaction (giao dịch)", RUN: true
  , find: [1044, 628], export: [1123, 593], waitFind: 15, waitExport: 15 }
]

; (Tuỳ chọn) Tự đổi ô "Date From" của Locator Transaction về giờ bắt đầu ca
; (07:00 hoặc 19:00) trước khi Find. Để false nếu muốn giữ ngày bạn tự nhập.
UPDATE_DATE_FROM := false
DATE_FROM_XY     := [680, 627]

; Sau khi bấm Export, nếu Oracle hiện hộp thoại lưu file ("Save As"/"Lưu"/"Export"),
; script tự gõ tên file kèm giờ vào thư mục dưới đây rồi Enter. Để "" = chỉ Enter.
SAVE_DIR := A_MyDocuments "\WMS_Export"
SAVE_DIALOG_TITLES := ["Save As", "Lưu", "Export", "File Download", "Tải xuống"]
; -----------------------------------------------------------------------------

paused := false
if SAVE_DIR != "" && !DirExist(SAVE_DIR)
  DirCreate(SAVE_DIR)
CoordMode "Mouse", "Window"
SetTitleMatchMode 2
TraySetIcon "shell32.dll", 239
A_IconTip := "TN5 · tự Export WMS mỗi " INTERVAL_MIN " phút (F9 tạm dừng, F10 thoát)"

SetTimer RunCycle, INTERVAL_MIN * 60 * 1000
TrayTip "Đã chạy. Lượt đầu bắt đầu sau 5 giây. F9 tạm dừng, F10 thoát.", "TN5 WMS Export"
SetTimer () => RunCycle(), -5000   ; lượt đầu sau 5 giây (hàm riêng để không đè lịch 5 phút)

F7::RunCycle()
F8:: {
  MouseGetPos &x, &y, &win
  ToolTip "Toạ độ trong cửa sổ: [" x ", " y "]`n" WinGetTitle(win)
  A_Clipboard := "[" x ", " y "]"
  SetTimer () => ToolTip(), -4000
}
F9:: {
  global paused := !paused
  TrayTip paused ? "Đã TẠM DỪNG (bấm F9 để chạy tiếp)" : "Đã CHẠY TIẾP", "TN5 WMS Export"
}
F10::ExitApp

RunCycle() {
  global paused
  if paused
    return
  if !WinExist(ORACLE_TITLE) {
    LogLine("Không thấy cửa sổ Oracle — bỏ qua lượt này")
    return
  }
  WinActivate ORACLE_TITLE
  if !WinWaitActive(ORACLE_TITLE, , 5) {
    LogLine("Không đưa được Oracle lên trước — bỏ qua")
    return
  }
  for f in FORMS {
    if !f.RUN
      continue
    if UPDATE_DATE_FROM && InStr(f.name, "Transaction")
      SetDateFrom()
    ClickAt(f.find)
    Sleep f.waitFind * 1000
    ClickAt(f.export)
    HandleSaveDialog(f.name, f.waitExport)
    WinActivate ORACLE_TITLE
    Sleep 1500
  }
  LogLine("Xong 1 lượt Find + Export")
}

ClickAt(xy) {
  WinActivate ORACLE_TITLE
  Click xy[1], xy[2]
  Sleep 400
}

; Chờ hộp thoại lưu file (nếu có) rồi lưu với tên kèm ngày giờ
HandleSaveDialog(formName, waitSec) {
  deadline := A_TickCount + waitSec * 1000
  while A_TickCount < deadline {
    for t in SAVE_DIALOG_TITLES {
      if WinExist(t) && !InStr(WinGetTitle(t), ORACLE_TITLE) {
        WinActivate t
        Sleep 500
        if SAVE_DIR != "" {
          tag := InStr(formName, "Transaction") ? "Transaction" : "Ton_kho"
          name := SAVE_DIR "\WMS_" tag "_" FormatTime(, "yyyyMMdd_HHmm")
          Send "^a"
          SendText name
          Sleep 300
        }
        Send "{Enter}"
        Sleep 1500
        if WinExist("Confirm Save As") || WinExist("Xác nhận Lưu")
          Send "!y"   ; ghi đè nếu trùng tên
        return
      }
    }
    Sleep 500
  }
  ; không có hộp thoại: Oracle tự lưu/mở file, không cần làm gì thêm
}

; Ô Date From = giờ bắt đầu ca hiện tại: 07:00 (ca ngày) hoặc 19:00 (ca đêm)
SetDateFrom() {
  h := Integer(FormatTime(, "H"))
  t := A_Now
  if h < 7
    t := DateAdd(t, -1, "Days"), hh := "19"
  else
    hh := h < 19 ? "07" : "19"
  mon := ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][Integer(FormatTime(t, "M"))]
  val := FormatTime(t, "dd") "-" mon "-" FormatTime(t, "yyyy") " " hh ":00:00"
  ClickAt(DATE_FROM_XY)
  Send "^a"
  SendText val
  Send "{Tab}"
  Sleep 300
}

LogLine(msg) {
  try FileAppend FormatTime(, "yyyy-MM-dd HH:mm:ss") "  " msg "`n", A_ScriptDir "\wms-auto-export.log", "UTF-8"
}
