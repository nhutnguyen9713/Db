// Service Worker cho trang "Tổng hợp 3 Plan — Xem theo Container" (PWA riêng, tách khỏi sw.js của
// TN5 Dashboard chính). Trang này luôn cần lấy dữ liệu MỚI NHẤT từ Cloud mỗi lần mở nên KHÔNG cache
// dữ liệu Firebase — chỉ đăng ký Service Worker để trình duyệt (Android/Chrome) cho phép "Cài đặt"
// (Add to Home Screen) như 1 app riêng; mọi request đều đi thẳng ra mạng, không can thiệp gì cả.
self.addEventListener('install', (event) => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { self.clients.claim(); });
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
