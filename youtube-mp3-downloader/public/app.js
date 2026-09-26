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
    subEl.textContent = data.lengthSeconds
      ? `${data.author || ''} · ${formatDuration(data.lengthSeconds)}`
      : (data.author || '');
    statusEl.textContent = '';
    btnDownload.disabled = false;
    btnDownload.textContent = '⬇ Tải MP3';
    btnDownload.onclick = () => startDownload(url, data.title);
    result.hidden = false;
  } catch (err) {
    showError(err.message);
  } finally {
    btnFetch.disabled = false;
    btnFetch.textContent = 'Kiểm tra video';
  }
});

async function startDownload(url, title) {
  btnDownload.disabled = true;
  statusEl.textContent = 'Đang tải và chuyển sang MP3, vui lòng chờ (có thể mất 20-40 giây)...';

  try {
    const titleParam = title ? `&title=${encodeURIComponent(title)}` : '';
    const res = await fetch(`/api/download?url=${encodeURIComponent(url)}${titleParam}`);
    if (!res.ok) {
      let msg = `Lỗi server (${res.status})`;
      try {
        const data = await res.json();
        if (data.error) msg = data.error;
      } catch {}
      throw new Error(msg);
    }

    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const asciiMatch = disposition.match(/filename="(.+)"/);
    const filename = utf8Match ? decodeURIComponent(utf8Match[1]) : (asciiMatch ? asciiMatch[1] : 'audio.mp3');

    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(blobUrl);

    statusEl.textContent = 'Đã tải xong!';
  } catch (err) {
    statusEl.textContent = 'Lỗi khi tải MP3: ' + err.message;
  } finally {
    btnDownload.disabled = false;
  }
}
