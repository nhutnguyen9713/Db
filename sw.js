// Service Worker cho TN5 Dashboard (PWA)
// Chiến lược: "Network First" — luôn cố lấy bản MỚI NHẤT từ mạng trước; chỉ dùng bản đã lưu (cache)
// khi không có mạng. Nhờ vậy mỗi lần cập nhật index.html mới lên GitHub Pages, mở app có mạng là
// tự động thấy bản mới ngay, không bị kẹt ở bản cũ.
// v2: index.html vừa được tách CSS/JS chính ra 2 file riêng (styles.css/app.js, trước đây nhúng
// thẳng trong index.html) — đổi CACHE_NAME để buộc dọn sạch cache cũ (đang giữ bản index.html nhúng
// sẵn mọi thứ), tránh lẫn lộn giữa bản cũ/mới; đồng thời thêm 2 file này vào CORE_ASSETS để được cài
// sẵn (precache) ngay từ lúc cài Service Worker, giống index.html, thay vì chỉ được cache "tình cờ"
// ở lần tải bình thường đầu tiên (vẫn hoạt động nhờ chiến lược Network First bên dưới, nhưng thêm vào
// đây để có ngay từ đầu, đúng ý nghĩa "core" của app shell ngoại tuyến).
const CACHE_NAME = 'tn5-dashboard-v2';
const CORE_ASSETS = ['./', './index.html', './app.js', './styles.css', './manifest.json', './icon-192.png', './icon-512.png'];

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
      .catch(() => caches.match(req).then((cached) => {
        if (cached) return cached;
        // CHỈ dự phòng về index.html khi chính request đang điều hướng vào trang chủ (index.html/./)
        // lúc mất mạng — KHÔNG áp dụng cho các trang KHÁC cùng gốc (VD tong-hop-3-plan.html), để
        // tránh hiện NHẦM nội dung TN5 Dashboard khi người dùng đang mở 1 trang khác mà mất mạng.
        if (req.mode === 'navigate' && (req.url === self.registration.scope || req.url.endsWith('/index.html'))) {
          return caches.match('./index.html');
        }
        return new Response('', { status: 504, statusText: 'Offline' });
      }))
  );
});
