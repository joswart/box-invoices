FROM node:20-alpine AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:20-alpine

RUN apk add --no-cache poppler-utils

WORKDIR /app
COPY package*.json ./
RUN npm ci --production

COPY --from=build /app/dist ./dist

USER node
CMD ["node", "dist/server.js"]
