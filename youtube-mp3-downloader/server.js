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
    noPlaylist: true,
    ...(cookiesFilePath ? { cookies: cookiesFilePath } : {}),
  };
}

// YouTube gan day bat client "web" mac dinh phai co PO Token moi tra ve
// duoc format phat nhac hop le ("Requested format is not available"). Cac
// client khac (tv, android, ios...) thuong chua bi bat PO Token nen thu lan
// luot cho den khi co client nao thanh cong. Co the tuy chinh qua bien moi
// truong YTDLP_PLAYER_CLIENTS (vd: "tv,android").
const PLAYER_CLIENTS = (process.env.YTDLP_PLAYER_CLIENTS || 'tv,android,ios,web_safari,web')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Plugin bgutil-ytdlp-pot-provider (vendor trong yt-dlp-plugins/) day yt-dlp
// biet cach lay PO Token tu server phu "pot-server" (xem README muc "PO
// Token"). PO_PROVIDER_URL tro toi server do, vd "http://host:4416" hoac
// "https://bgutil-pot-server-xxxx.onrender.com".
const PLUGIN_DIR = path.join(__dirname, 'yt-dlp-plugins');
const rawPotUrl = process.env.POT_PROVIDER_URL;
const potProviderUrl = rawPotUrl
  ? rawPotUrl.startsWith('http')
    ? rawPotUrl
    : `http://${rawPotUrl}`
  : undefined;
if (potProviderUrl) {
  console.log(`Da cau hinh PO Token provider tai ${potProviderUrl}`);
}

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
        verbose: true,
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

// Lay thong tin video (tieu de, anh thu nho, thoi luong)
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url || !YOUTUBE_URL_RE.test(url)) {
    return res.status(400).json({ error: 'Link YouTube khong hop le' });
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

  try {
    const info = await runYoutubeDl(url, { dumpSingleJson: true });
    const title = sanitizeFilename(info.title);

    await runYoutubeDl(url, {
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: '192K',
      ffmpegLocation: ffmpegPath,
      output: outTemplate,
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
