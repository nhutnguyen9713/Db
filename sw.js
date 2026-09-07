// Service Worker cho TN5 Dashboard (PWA)
// Chiến lược: "Network First" — luôn cố lấy bản MỚI NHẤT từ mạng trước; chỉ dùng bản đã lưu (cache)
// khi không có mạng. Nhờ vậy mỗi lần cập nhật index.html mới lên GitHub Pages, mở app có mạng là
// tự động thấy bản mới ngay, không bị kẹt ở bản cũ.
const CACHE_NAME = 'tn5-dashboard-v1';
const CORE_ASSETS = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .catch(() => {}) // không chặn cài đặt nếu 1 vài asset lỗi tạm thời
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Chỉ can thiệp request GET cùng gốc (index.html, manifest, icon...) — mọi thứ bên ngoài (CDN thư
  // viện ExcelJS/JSZip/jsQR, Cloud Apps Script...) luôn đi thẳng ra mạng bình thường, không cache.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
  );
});
