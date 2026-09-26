FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
# Cloud Run tu dat bien PORT (mac dinh 8080) va goi vao dung port do.
EXPOSE 8080

CMD ["node", "server.js"]
