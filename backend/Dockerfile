FROM public.ecr.aws/docker/library/node:20-alpine AS build

WORKDIR /app
COPY package*.json ./
# Skip Puppeteer's Chrome download — we use system Chromium in the runtime stage
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY templates ./templates
RUN npm run build

# ---- runtime ----
FROM public.ecr.aws/docker/library/node:20-alpine

# System Chromium + fonts for Puppeteer
RUN apk add --no-cache \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ca-certificates \
  poppler-utils \
  ttf-dejavu \
  ttf-freefont \
  unzip \
  wget \
  && mkdir -p /usr/share/fonts/google \
  && for url in \
       "https://fonts.google.com/download?family=Inter" \
       "https://fonts.google.com/download?family=Roboto" \
       "https://fonts.google.com/download?family=Open%20Sans" \
       "https://fonts.google.com/download?family=Lato" \
       "https://fonts.google.com/download?family=Montserrat" \
       "https://fonts.google.com/download?family=Poppins" \
       "https://fonts.google.com/download?family=Source%20Sans%203" \
       "https://fonts.google.com/download?family=Raleway" \
       "https://fonts.google.com/download?family=Merriweather" \
       "https://fonts.google.com/download?family=Playfair%20Display" \
     ; do \
       wget -qO /tmp/f.zip "$url" \
       && unzip -q /tmp/f.zip -d /tmp/f \
       && find /tmp/f -name "*.ttf" -exec cp {} /usr/share/fonts/google/ \; \
       && rm -rf /tmp/f /tmp/f.zip; \
     done \
  && fc-cache -f

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app
COPY package*.json ./
RUN npm ci --production

COPY --from=build /app/dist ./dist
COPY --from=build /app/templates ./templates

USER node
CMD ["node", "dist/server.js"]
