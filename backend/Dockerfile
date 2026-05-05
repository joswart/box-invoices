FROM node:20-alpine AS build

WORKDIR /app
COPY package*.json ./
# Skip Puppeteer's Chrome download — we use system Chromium in the runtime stage
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:20-alpine

# System Chromium + fonts for Puppeteer
RUN apk add --no-cache \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ca-certificates \
  poppler-utils \
  ttf-dejavu \
  ttf-freefont

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app
COPY package*.json ./
RUN npm ci --production

COPY --from=build /app/dist ./dist
COPY templates ./templates

USER node
CMD ["node", "dist/server.js"]
