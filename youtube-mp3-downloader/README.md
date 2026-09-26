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

> Nhược điểm: CPU Free tier của Render rất yếu (0.1 vCPU dùng chung) — mỗi lần tải nhạc có thể mất 60-70 giây. Nếu muốn nhanh hơn mà **không cần thẻ thanh toán**, xem mục Railway bên dưới.

### Bước 1 (thay thế): Deploy lên Railway — nhanh hơn, không cần thẻ

Railway cấp **1 vCPU** cho free tier (gấp 10 lần Render Free), không bị "ngủ"/cold-start, và **không yêu cầu thẻ** để đăng ký (có $5 credit dùng thử tháng đầu, sau đó $1 credit/tháng — đủ dùng cho nhu cầu tải nhạc cá nhân, thỉnh thoảng).

1. Tạo tài khoản tại [railway.com](https://railway.com) (đăng nhập bằng GitHub).
2. **New Project** → **Deploy from GitHub repo** → chọn repo `nhutnguyen9713/Db`.
3. Trong phần cấu hình service vừa tạo:
   - **Root Directory**: `youtube-mp3-downloader` (Railway sẽ tự nhận diện `Dockerfile` có sẵn trong thư mục này và build theo đó)
   - **Branch**: `mp3`
4. Vào tab **Variables** → thêm biến `YTDL_COOKIES` (xem hướng dẫn lấy cookie ở mục bên dưới).
5. Vào tab **Settings** → **Networking** → bấm **Generate Domain** để có link public dạng `https://youtube-mp3-downloader-xxxx.up.railway.app`.

> Theo dõi mục **Usage** trong Railway để biết credit còn lại mỗi tháng — nếu dùng nhiều (tải liên tục) có thể vượt $1 credit/tháng và cần nạp thêm hoặc thêm thẻ.

> Lưu ý: gói free của Render sẽ "ngủ" sau ~15 phút không dùng, lần mở lại đầu tiên có thể chậm khoảng 30-60 giây để server thức dậy.

### Bước 1 (thay thế): Deploy lên Google Cloud Run — nhanh hơn Render Free

Render Free tier CPU rất yếu (mỗi lần tải nhạc mất 60-70 giây). Google Cloud Run cấp CPU thật khi xử lý request (không bị chia sẻ/giới hạn như Render Free), miễn phí tới 2 triệu request/tháng — đủ dùng cá nhân thoải mái. Bù lại cần tài khoản Google Cloud (yêu cầu thẻ thanh toán để xác minh, nhưng không bị trừ tiền nếu ở trong hạn mức free) và setup nhiều bước hơn Render.

1. Tạo tài khoản tại [console.cloud.google.com](https://console.cloud.google.com) (cần thẻ để xác minh danh tính, gói Free Tier không tự động trừ tiền).
2. Tạo 1 **Project** mới (góc trên bên trái, "Select a project" → "New Project").
3. Vào **Cloud Run** (tìm "Cloud Run" trong ô tìm kiếm trên cùng) → bấm **Create Service**.
4. Chọn **"Continuously deploy from a repository"** → **Set up with Cloud Build** → **Connect** tài khoản GitHub → chọn repo `nhutnguyen9713/Db`.
5. Ở phần cấu hình build:
   - **Branch**: `mp3`
   - **Build Type**: Dockerfile
   - **Source location**: `/youtube-mp3-downloader/Dockerfile`
6. Cấu hình service:
   - **Region**: chọn gần Việt Nam (vd `asia-southeast1` - Singapore)
   - **Authentication**: **Allow unauthenticated invocations** (để ai cũng mở được link, không cần đăng nhập Google)
   - **Memory**: 512 MiB là đủ, có thể tăng lên 1 GiB nếu muốn chắc chắn hơn
   - **CPU allocation**: "CPU is only allocated during request processing" (mặc định, giữ free)
7. Bấm **Create**. Sau vài phút sẽ có link dạng `https://youtube-mp3-downloader-xxxxx-as.a.run.app`.
8. (Khuyên dùng) Vào service vừa tạo → **Edit & Deploy New Revision** → tab **Variables & Secrets** → thêm biến `YTDL_COOKIES` (xem hướng dẫn lấy cookie ở mục bên dưới) để tránh bị chặn bot.

> Lưu ý: Cloud Run cũng "scale về 0" khi không dùng (giống Render), nhưng do CPU mạnh hơn nên lần đánh thức đầu và mỗi lần tải nhạc đều nhanh hơn Render Free rõ rệt.

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

## Sửa lỗi "Requested format is not available" (PO Token / JS runtime)

Lỗi này thường không phải do PO Token mà do `yt-dlp` không tìm thấy JS runtime (Node) để giải mã tín hiệu của YouTube — server.js đã tự trỏ thẳng `--js-runtimes` vào Node đang chạy app nên phần này không cần cấu hình gì thêm, kể cả trên Cloud Run.

`render.yaml` trong repo vẫn có khai báo 1 service phụ tên `bgutil-pot-server` (thư mục `pot-server/`, dùng [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)) để sinh **PO Token** — cơ chế xác thực bổ sung mà YouTube áp dụng ngày càng nhiều. Trên Render, phần này chưa từng thực sự kết nối được (không bắt buộc phải deploy nó) — chỉ dùng đến nếu sau này lỗi format quay lại dù JS runtime đã đúng. Bỏ qua phần dưới đây nếu deploy lên Cloud Run.

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
