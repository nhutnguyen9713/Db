FROM node:22-bookworm-slim

WORKDIR /app

# youtube-dl-exec's preinstall script insists on a `python` binary in PATH
# even though we only use the prebuilt yt-dlp binary it downloads (no Python
# needed at runtime). Skip that check on slim images that don't ship Python.
ENV YOUTUBE_DL_SKIP_PYTHON_CHECK=1
# The default GitHub release asset ("yt-dlp") is a zipapp that still needs a
# system python3 to run. yt-dlp_linux is the real standalone PyInstaller
# binary (glibc Linux, matches this Debian-based image) with no such need.
ENV YOUTUBE_DL_FILENAME=yt-dlp_linux

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
# Cloud Run tu dat bien PORT (mac dinh 8080) va goi vao dung port do.
EXPOSE 8080

CMD ["node", "server.js"]
