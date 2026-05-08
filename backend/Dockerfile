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
  wget

# Google Fonts — downloaded from raw.githubusercontent.com (no auth, no redirects)
# Variable fonts cover all weights in a single file; static fonts get Regular + Bold.
RUN mkdir -p /usr/share/fonts/google \
  && BASE=https://raw.githubusercontent.com/google/fonts/main \
  && wget -qO /usr/share/fonts/google/Inter.ttf             "$BASE/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf" \
  && wget -qO /usr/share/fonts/google/Roboto.ttf            "$BASE/ofl/roboto/Roboto%5Bwdth%2Cwght%5D.ttf" \
  && wget -qO /usr/share/fonts/google/OpenSans.ttf          "$BASE/ofl/opensans/OpenSans%5Bwdth%2Cwght%5D.ttf" \
  && wget -qO /usr/share/fonts/google/Montserrat.ttf        "$BASE/ofl/montserrat/Montserrat%5Bwght%5D.ttf" \
  && wget -qO /usr/share/fonts/google/SourceSans3.ttf       "$BASE/ofl/sourcesans3/SourceSans3%5Bwght%5D.ttf" \
  && wget -qO /usr/share/fonts/google/Raleway.ttf           "$BASE/ofl/raleway/Raleway%5Bwght%5D.ttf" \
  && wget -qO /usr/share/fonts/google/PlayfairDisplay.ttf   "$BASE/ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf" \
  && wget -qO /usr/share/fonts/google/Lato-Regular.ttf      "$BASE/ofl/lato/Lato-Regular.ttf" \
  && wget -qO /usr/share/fonts/google/Lato-Bold.ttf         "$BASE/ofl/lato/Lato-Bold.ttf" \
  && wget -qO /usr/share/fonts/google/Poppins-Regular.ttf   "$BASE/ofl/poppins/Poppins-Regular.ttf" \
  && wget -qO /usr/share/fonts/google/Poppins-Bold.ttf      "$BASE/ofl/poppins/Poppins-Bold.ttf" \
  && wget -qO /usr/share/fonts/google/Merriweather.ttf          "$BASE/ofl/merriweather/Merriweather%5Bopsz%2Cwdth%2Cwght%5D.ttf" \
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
