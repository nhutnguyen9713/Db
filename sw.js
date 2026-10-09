// Service Worker cho TN5 Dashboard (PWA)
// Chiến lược: "Network First" — luôn cố lấy bản MỚI NHẤT từ mạng trước; chỉ dùng bản đã lưu (cache)
// khi không có mạng HOẶC mạng quá chậm (quá NETWORK_TIMEOUT_MS) — wifi kho yếu thì app không bị treo.
// Nhờ vậy mỗi lần cập nhật index.html mới lên GitHub Pages, mở app có mạng là tự động thấy bản mới.
// v3: sửa các lỗi cache — (1) chỉ lưu phản hồi thành công (res.ok), không ghi đè bản tốt bằng 404/5xx;
// (2) bỏ query ?_t=... khỏi khoá cache (trước đây mỗi lần mở tạo thêm 1 mục không bao giờ bị dọn, và mở
// offline không khớp được); (3) thêm doi-chieu.html / tong-hop-3-plan.html vào precache và
// cài từng file riêng để 1 file lỗi không làm hỏng cả lô.
const CACHE_NAME = 'tn5-dashboard-v4';
const NETWORK_TIMEOUT_MS = 4000;
const CORE_ASSETS = [
  './', './index.html', './app.js', './styles.css', './manifest.json', './icon-192.png', './icon-512.png',
  './icon-512-maskable.png', './doi-chieu.html', './tong-hop-3-plan.html'
];

// Khoá cache = URL không có query "_t" (tham số chống cache của cổng khoá) — các query khác giữ nguyên.
function cacheKeyFor(req){
  const u = new URL(req.url);
  u.searchParams.delete('_t');
  return u.toString();
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(CORE_ASSETS.map((url) => cache.add(url).catch(() => {}))) // 1 file lỗi không chặn các file còn lại
    )
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

  const key = cacheKeyFor(req);
  const fromCache = () => caches.open(CACHE_NAME).then((cache) => cache.match(key));

  const network = fetch(req).then((res) => {
    if (res && res.ok) {
      const resClone = res.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(key, resClone)).catch(() => {});
    }
    return res;
  });
  network.catch(() => {}); // tránh cảnh báo 'unhandled rejection' khi bản cache đã thắng cuộc đua
  // Mạng quá chậm -> dùng bản đã lưu (nếu có); không có bản đã lưu thì cứ chờ mạng.
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS));

  event.respondWith(
    Promise.race([network, timeout])
      .then((res) => res || fromCache().then((cached) => cached || network))
      .catch(() => fromCache().then((cached) => {
        if (cached) return cached;
        // CHỈ dự phòng về index.html khi chính request đang điều hướng vào trang chủ (index.html/./)
        // lúc mất mạng — KHÔNG áp dụng cho các trang KHÁC cùng gốc (VD tong-hop-3-plan.html), để
        // tránh hiện NHẦM nội dung TN5 Dashboard khi người dùng đang mở 1 trang khác mà mất mạng.
        const path = new URL(req.url).pathname;
        if (req.mode === 'navigate' && (req.url === self.registration.scope || path.endsWith('/index.html') || path.endsWith('/'))) {
          return caches.open(CACHE_NAME).then((cache) => cache.match(new URL('./index.html', self.registration.scope).toString()));
        }
        return new Response('', { status: 504, statusText: 'Offline' });
      }))
  );
});
