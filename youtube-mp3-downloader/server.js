const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const ffmpegPath = require('ffmpeg-static');
const youtubedl = require('youtube-dl-exec');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const YOUTUBE_URL_RE = /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i;

// YouTube hay chan request tu server cloud vi nghi la bot. Set bien moi
// truong YTDL_COOKIES = chuoi cookie dang "ten1=gia_tri1; ten2=gia_tri2; ..."
// (copy tu header Cookie cua trinh duyet khi da dang nhap YouTube) de yt-dlp
// dung cookie nay xac thuc thay ban.
let cookiesFilePath;
if (process.env.YTDL_COOKIES) {
  try {
    const pairs = process.env.YTDL_COOKIES.split(';').map((s) => s.trim()).filter(Boolean);
    const expiry = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 180; // 180 ngay
    const lines = ['# Netscape HTTP Cookie File'];
    for (const pair of pairs) {
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (!name) continue;
      lines.push(['.youtube.com', 'TRUE', '/', 'TRUE', expiry, name, value].join('\t'));
    }
    if (lines.length <= 1) throw new Error('Khong doc duoc cookie nao tu YTDL_COOKIES');
    cookiesFilePath = path.join(os.tmpdir(), 'yt-cookies.txt');
    fs.writeFileSync(cookiesFilePath, lines.join('\n') + '\n');
    console.log(`Da ghi ${lines.length - 1} cookie vao file, se dung cho yt-dlp.`);
  } catch (err) {
    console.error('YTDL_COOKIES khong hop le:', err.message);
  }
}

function sanitizeFilename(name) {
  return (name || '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 150) || 'audio';
}

function baseFlags() {
  return {
    noWarnings: true,
    noPlaylist: true,
    ...(cookiesFilePath ? { cookies: cookiesFilePath } : {}),
  };
}

// Lay thong tin video (tieu de, anh thu nho, thoi luong)
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url || !YOUTUBE_URL_RE.test(url)) {
    return res.status(400).json({ error: 'Link YouTube khong hop le' });
  }
  try {
    const info = await youtubedl(url, { dumpSingleJson: true, ...baseFlags() });
    res.json({
      title: info.title,
      author: info.uploader || info.channel || '',
      lengthSeconds: Number(info.duration || 0),
      thumbnail: info.thumbnail || '',
    });
  } catch (err) {
    res.status(500).json({ error: 'Khong lay duoc thong tin video: ' + (err.stderr || err.message) });
  }
});

// Tai va chuyen doi sang MP3 (qua yt-dlp + ffmpeg), roi stream file ve trinh duyet
app.get('/api/download', async (req, res) => {
  const { url } = req.query;
  if (!url || !YOUTUBE_URL_RE.test(url)) {
    return res.status(400).json({ error: 'Link YouTube khong hop le' });
  }

  const jobId = crypto.randomUUID();
  const outTemplate = path.join(os.tmpdir(), `${jobId}.%(ext)s`);
  const outFile = path.join(os.tmpdir(), `${jobId}.mp3`);

  try {
    const info = await youtubedl(url, { dumpSingleJson: true, ...baseFlags() });
    const title = sanitizeFilename(info.title);

    await youtubedl(url, {
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: '192K',
      ffmpegLocation: ffmpegPath,
      output: outTemplate,
      ...baseFlags(),
    });

    if (!fs.existsSync(outFile)) {
      throw new Error('Khong tao duoc file MP3');
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${title}.mp3"`);

    const stream = fs.createReadStream(outFile);
    stream.pipe(res);
    stream.on('close', () => fs.unlink(outFile, () => {}));
    stream.on('error', () => {
      fs.unlink(outFile, () => {});
      if (!res.headersSent) res.status(500).end('Loi khi doc file MP3');
    });
  } catch (err) {
    fs.unlink(outFile, () => {});
    if (!res.headersSent) {
      res.status(500).json({ error: 'Khong tai duoc: ' + (err.stderr || err.message) });
    }
  }
});

app.listen(PORT, () => {
  console.log(`YouTube MP3 Downloader dang chay tai http://localhost:${PORT}`);
});
