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

- **Backend**: Node.js + Express, dùng `@distube/ytdl-core` để lấy luồng audio và `ffmpeg` (qua `ffmpeg-static`/`fluent-ffmpeg`) để chuyển sang MP3.
- **Frontend**: HTML/CSS/JS thuần, không cần build.

## Lưu ý

- YouTube thường xuyên thay đổi cách phát video nên thư viện `ytdl-core` đôi khi cần cập nhật (`npm update @distube/ytdl-core`) nếu gặp lỗi tải.
- Chỉ nên tự host và dùng riêng, không nên public server này để tải hàng loạt nội dung có bản quyền.
