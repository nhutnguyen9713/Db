const form = document.getElementById('form');
const urlInput = document.getElementById('url');
const btnFetch = document.getElementById('btnFetch');
const errorBox = document.getElementById('error');
const result = document.getElementById('result');
const thumb = document.getElementById('thumb');
const titleEl = document.getElementById('title');
const subEl = document.getElementById('sub');
const btnDownload = document.getElementById('btnDownload');
const statusEl = document.getElementById('status');

function formatDuration(sec) {
  sec = Number(sec) || 0;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
  result.hidden = true;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  errorBox.hidden = true;
  result.hidden = true;
  btnFetch.disabled = true;
  btnFetch.textContent = 'Đang kiểm tra...';

  try {
    const res = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Có lỗi xảy ra');

    thumb.src = data.thumbnail;
    titleEl.textContent = data.title;
    subEl.textContent = `${data.author || ''} · ${formatDuration(data.lengthSeconds)}`;
    statusEl.textContent = '';
    btnDownload.disabled = false;
    btnDownload.textContent = '⬇ Tải MP3';
    btnDownload.onclick = () => startDownload(url);
    result.hidden = false;
  } catch (err) {
    showError(err.message);
  } finally {
    btnFetch.disabled = false;
    btnFetch.textContent = 'Kiểm tra video';
  }
});

function startDownload(url) {
  btnDownload.disabled = true;
  statusEl.textContent = 'Đang tải và chuyển sang MP3, vui lòng chờ...';
  const link = document.createElement('a');
  link.href = `/api/download?url=${encodeURIComponent(url)}`;
  link.download = '';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => {
    btnDownload.disabled = false;
    statusEl.textContent = 'Nếu trình duyệt chưa tự tải, hãy thử lại.';
  }, 4000);
}
