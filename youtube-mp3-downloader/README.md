# YouTube MP3 Downloader

Ứng dụng web nhỏ gọn để tải nhạc MP3 từ YouTube, dùng cho mục đích cá nhân với nội dung bạn có quyền tải (video của chính bạn, nội dung được cấp phép tự do/Creative Commons, v.v). Hãy tôn trọng bản quyền và Điều khoản dịch vụ của YouTube khi sử dụng.

## Cách chạy

```bash
cd youtube-mp3-downloader
npm install
npm start
```

Sau đó mở trình duyệt tại `http://localhost:3000`.

## Cách dùng

1. Dán link video YouTube vào ô nhập.
2. Bấm **Kiểm tra video** để xem tiêu đề, kênh, thời lượng.
3. Bấm **Tải MP3** để tải file về máy (chuyển đổi audio sang MP3 192kbps ngay trên server).

## Công nghệ

- **Backend**: Node.js + Express, dùng [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) (qua `youtube-dl-exec`, tự tải bản yt-dlp mới nhất mỗi lần `npm install`) để tải và trích xuất audio, cùng `ffmpeg` (qua `ffmpeg-static`) để chuyển sang MP3.
- **Frontend**: HTML/CSS/JS thuần, không cần build. Có sẵn PWA (manifest + service worker) nên cài được thành app trên điện thoại.

## Cài lên điện thoại Android (PWA)

Điện thoại không tự chạy được server Node/ffmpeg, nên cần deploy server lên một dịch vụ cloud trước, sau đó mở link đó trên điện thoại và "cài" như app.

### Bước 1: Deploy server lên Render (miễn phí)

1. Tạo tài khoản tại [render.com](https://render.com) (đăng nhập bằng GitHub là nhanh nhất).
2. Trong Render, chọn **New +** → **Blueprint**, chọn repo GitHub này (`nhutnguyen9713/Db`). Render sẽ tự đọc file `render.yaml` ở gốc repo và tạo sẵn Web Service `youtube-mp3-downloader`.
   - Nếu Render không hỗ trợ Blueprint, tạo thủ công: **New +** → **Web Service** → chọn repo → **Root Directory**: `youtube-mp3-downloader` → **Build Command**: `npm install` → **Start Command**: `npm start`.
3. Bấm **Deploy**. Sau vài phút sẽ có link dạng `https://youtube-mp3-downloader-xxxx.onrender.com`.

> Lưu ý: gói free của Render sẽ "ngủ" sau ~15 phút không dùng, lần mở lại đầu tiên có thể chậm khoảng 30-60 giây để server thức dậy.

### Bước 2: Cài vào màn hình chính điện thoại

1. Trên điện thoại Android, mở **Chrome**, vào link Render ở bước 1.
2. Chrome sẽ tự hiện thông báo **"Thêm vào Màn hình chính" / "Install app"** — bấm để cài. Nếu không thấy, bấm menu (⋮ góc trên phải) → **Thêm vào Màn hình chính**.
3. App sẽ có icon riêng, mở toàn màn hình như app thật — dán link YouTube và tải MP3 như bình thường.

## Sửa lỗi "Sign in to confirm you're not a bot"

Khi server chạy trên IP của dịch vụ cloud (Render, Railway...), YouTube hay chặn vì nghi là bot. Cách khắc phục: cung cấp cookie của tài khoản YouTube đã đăng nhập để server "xác thực" thay bạn.

1. Đăng nhập [youtube.com](https://youtube.com) trên trình duyệt (máy tính hoặc điện thoại đều được — trên Android có thể dùng Kiwi Browser để có DevTools).
2. Mở DevTools → tab **Network** → bấm vào 1 request bất kỳ tới `youtube.com` → tìm **Request Headers** → copy toàn bộ giá trị của header **`Cookie`** (chuỗi dạng `ten1=gia_tri1; ten2=gia_tri2; ...`).
3. Trên Render, vào Web Service `youtube-mp3-downloader` → **Environment** → thêm biến:
   - **Key**: `YTDL_COOKIES`
   - **Value**: dán nguyên chuỗi cookie vừa copy
4. Bấm **Save, rebuild and deploy**. Server sẽ tự dùng cookie này cho mọi request tới YouTube.

> ⚠️ **Chỉ dán cookie vào ô Environment Variable trên Render, không dán/chia sẻ ở bất kỳ đâu khác** — chuỗi này chứa cookie đăng nhập toàn bộ tài khoản Google của bạn (SID, HSID, APISID...), ai có được có thể đăng nhập giả danh bạn mà không cần mật khẩu. Cookie cũng có hạn dùng, nếu lỗi quay lại thì lấy cookie mới và cập nhật lại biến `YTDL_COOKIES`.

## Sửa lỗi "Requested format is not available" (PO Token)

Ngay cả khi có cookie hợp lệ, YouTube gần đây còn yêu cầu thêm một **PO Token** (Proof-of-Origin Token) mới trả về được link phát nhạc, đặc biệt với IP của các dịch vụ cloud. `render.yaml` trong repo đã khai báo sẵn 1 service phụ tên `bgutil-pot-server` (thư mục `pot-server/`) chuyên sinh PO Token, dùng [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider).

### Nếu bạn deploy qua Blueprint (`render.yaml`)

Render sẽ tự tạo **cả 2 service** (`youtube-mp3-downloader` và `bgutil-pot-server`) và tự nối chúng qua biến `POT_PROVIDER_URL`. Không cần làm gì thêm — nếu Render đã hỗ trợ đồng bộ Blueprint tự động.

### Nếu Render không tự nối được (hoặc bạn deploy service thủ công)

1. Deploy `bgutil-pot-server` là 1 Web Service riêng: **New +** → **Web Service** → chọn repo → **Runtime: Docker** → **Root Directory**: `pot-server`. Deploy xong sẽ có link dạng `https://bgutil-pot-server-xxxx.onrender.com`.
2. Vào Web Service `youtube-mp3-downloader` → **Environment** → thêm biến:
   - **Key**: `POT_PROVIDER_URL`
   - **Value**: link ở bước 1 (vd `https://bgutil-pot-server-xxxx.onrender.com`)
3. Deploy lại `youtube-mp3-downloader`. Log lúc khởi động sẽ có dòng `Da cau hinh PO Token provider tai ...` xác nhận đã nối thành công.

> Lưu ý: đây vẫn không phải giải pháp đảm bảo 100% — theo README gốc của bgutil: *"Providing a PO token does not guarantee bypassing 403 errors or bot checks, but it may help your traffic seem more legitimate."* Đây là "cuộc đua" liên tục giữa YouTube và cộng đồng, có thể cần cập nhật thêm trong tương lai.

Thư mục `pot-server/` và `youtube-mp3-downloader/yt-dlp-plugins/` chứa code vendor nguyên bản từ dự án mã nguồn mở [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) (giấy phép GPL-3.0, xem file `LICENSE` trong mỗi thư mục), không phải code tự viết.

## Lưu ý

- YouTube thường xuyên thay đổi cách phát video. Mỗi lần deploy lại (Render build lại từ đầu), `youtube-dl-exec` tự tải bản `yt-dlp` mới nhất nên thường tự khắc phục được các lỗi kiểu "Failed to find any playable formats". Nếu vẫn lỗi, thử **Manual Deploy → Clear build cache & deploy** trên Render để chắc chắn lấy bản yt-dlp mới nhất.
- Chỉ nên tự host và dùng riêng, không nên public server này để tải hàng loạt nội dung có bản quyền.
