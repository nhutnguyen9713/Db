FROM node:26-bookworm-slim AS install
USER node
WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --no-audit --no-fund

FROM install AS build_node

RUN npm ci --no-audit --no-fund

COPY types/ types/
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM install AS server_node

COPY --from=build_node /app/build /app/build

EXPOSE 4416
ENTRYPOINT ["/usr/local/bin/node", "build/main.js"]
CMD ["--host", "0.0.0.0"]
