const path = require('path');
const express = require('express');
const ytdl = require('@distube/ytdl-core');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 150) || 'audio';
}

// Lay thong tin video (tieu de, anh thu nho, thoi luong)
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url || !ytdl.validateURL(url)) {
    return res.status(400).json({ error: 'Link YouTube khong hop le' });
  }
  try {
    const info = await ytdl.getInfo(url);
    const { videoDetails } = info;
    res.json({
      title: videoDetails.title,
      author: videoDetails.author?.name,
      lengthSeconds: Number(videoDetails.lengthSeconds || 0),
      thumbnail: videoDetails.thumbnails?.at(-1)?.url || '',
    });
  } catch (err) {
    res.status(500).json({ error: 'Khong lay duoc thong tin video: ' + err.message });
  }
});

// Tai va chuyen doi sang MP3, stream truc tiep ve trinh duyet
app.get('/api/download', async (req, res) => {
  const { url } = req.query;
  if (!url || !ytdl.validateURL(url)) {
    return res.status(400).json({ error: 'Link YouTube khong hop le' });
  }

  try {
    const info = await ytdl.getInfo(url);
    const title = sanitizeFilename(info.videoDetails.title);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${title}.mp3"`);

    const audioStream = ytdl.downloadFromInfo(info, {
      quality: 'highestaudio',
      filter: 'audioonly',
    });

    audioStream.on('error', (err) => {
      if (!res.headersSent) res.status(500).end('Loi tai audio: ' + err.message);
      else res.end();
    });

    ffmpeg(audioStream)
      .audioBitrate(192)
      .format('mp3')
      .on('error', (err) => {
        if (!res.headersSent) res.status(500).end('Loi chuyen doi MP3: ' + err.message);
        else res.end();
      })
      .pipe(res, { end: true });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: 'Khong tai duoc: ' + err.message });
    }
  }
});

app.listen(PORT, () => {
  console.log(`YouTube MP3 Downloader dang chay tai http://localhost:${PORT}`);
});
