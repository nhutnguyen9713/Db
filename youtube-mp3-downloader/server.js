const path = require('path');
const os = require('os');
const fs = require('fs');
const https = require('https');
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

// Content-Disposition chi chap nhan ky tu ASCII thuan tren phan filename=""
// (tieu de video co dau tieng Viet se bi Node tu choi voi loi "Invalid
// character in header content"). Dung ban ASCII lam fallback, kem theo
// filename*=UTF-8''... (RFC 5987) de trinh duyet hien dung ten co dau.
function contentDispositionHeader(title) {
  const asciiName = title.replace(/[^\x20-\x7E]/g, '_').replace(/_+/g, '_').trim() || 'audio';
  const utf8Name = encodeURIComponent(`${title}.mp3`);
  return `attachment; filename="${asciiName}.mp3"; filename*=UTF-8''${utf8Name}`;
}

function baseFlags() {
  return {
    noPlaylist: true,
    ...(cookiesFilePath ? { cookies: cookiesFilePath } : {}),
  };
}

// Client "web" hoat dong on dinh khi da co --js-runtimes tro dung Node (giai
// duoc "n challenge") + cookie dang nhap. Uu tien thu no truoc tien de nhanh
// va tranh timeout; cac client khac chi la du phong (thuong that bai vi
// khong ho tro cookie hoac bi 403 API rieng, khong lien quan gi nhau). Co
// the tuy chinh qua bien moi truong YTDLP_PLAYER_CLIENTS.
const PLAYER_CLIENTS = (process.env.YTDLP_PLAYER_CLIENTS || 'web,tv,android,ios,web_safari')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Plugin bgutil-ytdlp-pot-provider (vendor trong yt-dlp-plugins/) day yt-dlp
// biet cach lay PO Token tu server phu "pot-server" (xem README muc "PO
// Token"). PO_PROVIDER_URL tro toi server do, vd "http://host:4416" hoac
// "https://bgutil-pot-server-xxxx.onrender.com".
const PLUGIN_DIR = path.join(__dirname, 'yt-dlp-plugins');
try {
  const exists = fs.existsSync(PLUGIN_DIR);
  console.log(`[debug] PLUGIN_DIR=${PLUGIN_DIR} exists=${exists}`);
  if (exists) {
    console.log(`[debug] PLUGIN_DIR contents: ${fs.readdirSync(PLUGIN_DIR).join(', ')}`);
    const extractorDir = path.join(PLUGIN_DIR, 'bgutil', 'yt_dlp_plugins', 'extractor');
    if (fs.existsSync(extractorDir)) {
      console.log(`[debug] extractor plugin files: ${fs.readdirSync(extractorDir).join(', ')}`);
    }
  }
} catch (err) {
  console.error('[debug] Loi khi kiem tra PLUGIN_DIR:', err.message);
}

// Neu chi la "host" hoac "host:port" (khong co tien to giao thuc), doan xem
// co port hay khong de chon http (thuong la noi bo, cung mang private) hay
// https (domain cong khai tren Railway/Render... deu chi phuc vu qua TLS).
const rawPotUrl = process.env.POT_PROVIDER_URL;
const potProviderUrl = rawPotUrl
  ? rawPotUrl.startsWith('http')
    ? rawPotUrl
    : `${/:\d+$/.test(rawPotUrl) ? 'http' : 'https'}://${rawPotUrl}`
  : undefined;
if (potProviderUrl) {
  console.log(`Da cau hinh PO Token provider tai ${potProviderUrl}`);
}

// yt-dlp can 1 JS runtime (node/deno/bun/quickjs) de giai ma "n challenge"
// cua YouTube. Ban than app nay da chay bang Node, nhung yt-dlp tu do tim
// "node" qua PATH co the khong thay khi chay nhu tien trinh con — tro thang
// den binary Node dang chay app (process.execPath) de chac chan.
const JS_RUNTIME_ARG = `node:${process.execPath}`;

async function runYoutubeDl(url, extraFlags) {
  const attempts = [];
  for (const client of PLAYER_CLIENTS) {
    try {
      const extractorArgs = [`youtube:player_client=${client}`];
      if (potProviderUrl) {
        extractorArgs.push(`youtubepot-bgutilhttp:base_url=${potProviderUrl}`);
      }
      const result = await youtubedl(url, {
        ...baseFlags(),
        ...extraFlags,
        pluginDirs: PLUGIN_DIR,
        extractorArgs,
        jsRuntimes: JS_RUNTIME_ARG,
      });
      console.log(`[yt-dlp] client=${client} -> OK`);
      return result;
    } catch (err) {
      const fullMsg = (err.stderr || err.message || String(err)).trim();
      // Log toan bo (khong cat bot) ra Render Logs de chan doan; chi rut gon
      // phan hien thi ngay trong app cho gon.
      console.error(`[yt-dlp] client=${client} -> FAIL:\n${fullMsg}`);
      const msg = fullMsg.slice(0, 300);
      attempts.push(`${client}: ${msg}`);
    }
  }
  throw new Error(`Tat ca ${PLAYER_CLIENTS.length} player client deu that bai:\n` + attempts.join('\n'));
}

// oEmbed cua YouTube: API cong khai, nhe, khong can yt-dlp giai ma gi ca —
// dung de xem truoc (tieu de/anh/tac gia) that nhanh. Khong co thoi luong.
function fetchOembed(url) {
  return new Promise((resolve, reject) => {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    https
      .get(oembedUrl, { timeout: 8000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`oEmbed status ${res.statusCode}`));
        }
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject)
      .on('timeout', function () {
        this.destroy(new Error('oEmbed timeout'));
      });
  });
}

// Lay thong tin video (tieu de, anh thu nho, thoi luong) de xem truoc
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url || !YOUTUBE_URL_RE.test(url)) {
    return res.status(400).json({ error: 'Link YouTube khong hop le' });
  }

  try {
    const oembed = await fetchOembed(url);
    return res.json({
      title: oembed.title,
      author: oembed.author_name || '',
      lengthSeconds: 0,
      thumbnail: oembed.thumbnail_url || '',
    });
  } catch (oembedErr) {
    console.log('[info] oEmbed that bai, fallback sang yt-dlp:', oembedErr.message);
  }

  try {
    const info = await runYoutubeDl(url, { dumpSingleJson: true });
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

  console.log(`[download] jobId=${jobId} bat dau: ${url}`);
  try {
    // Neu frontend da co san tieu de (tu /api/info goi truoc do) thi dung
    // luon, khoi phai goi yt-dlp them 1 lan chi de lay lai tieu de.
    let title = req.query.title ? sanitizeFilename(req.query.title) : null;
    if (!title) {
      const info = await runYoutubeDl(url, { dumpSingleJson: true });
      title = sanitizeFilename(info.title);
    }
    console.log(`[download] jobId=${jobId} title="${title}"`);

    await runYoutubeDl(url, {
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: '192K',
      ffmpegLocation: ffmpegPath,
      output: outTemplate,
    });
    console.log(`[download] jobId=${jobId} yt-dlp extractAudio xong`);

    if (!fs.existsSync(outFile)) {
      const dirListing = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(jobId));
      throw new Error(`Khong tao duoc file MP3 (tmp co: ${dirListing.join(', ') || 'khong co gi'})`);
    }
    const fileSize = fs.statSync(outFile).size;
    console.log(`[download] jobId=${jobId} file MP3 san sang, size=${fileSize} bytes`);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Content-Disposition', contentDispositionHeader(title));

    const stream = fs.createReadStream(outFile);
    stream.pipe(res);
    stream.on('close', () => {
      console.log(`[download] jobId=${jobId} da gui xong cho client`);
      fs.unlink(outFile, () => {});
    });
    stream.on('error', (err) => {
      console.error(`[download] jobId=${jobId} loi khi doc file:`, err.message);
      fs.unlink(outFile, () => {});
      if (!res.headersSent) res.status(500).end('Loi khi doc file MP3');
    });
  } catch (err) {
    const msg = err.stderr || err.message || String(err);
    console.error(`[download] jobId=${jobId} that bai:`, msg);
    fs.unlink(outFile, () => {});
    if (!res.headersSent) {
      res.status(500).json({ error: 'Khong tai duoc: ' + msg });
    }
  }
});

app.listen(PORT, () => {
  console.log(`YouTube MP3 Downloader dang chay tai http://localhost:${PORT}`);
});
