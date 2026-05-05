# ---- build ----
# Context is the repo root so we can access backend/templates for the preview bundle.
FROM node:20-alpine AS build

WORKDIR /app

# Install dependencies
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm ci

# Copy frontend source, preserving relative paths (../../backend/... resolves correctly)
COPY frontend/tsconfig.json ./frontend/
COPY frontend/src             ./frontend/src

# Copy the invoice template — shared by backend (PDF) and frontend (preview)
COPY backend/templates        ./backend/templates

RUN cd frontend && npm run build

# ---- runtime ----
FROM nginx:1.27-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/public     /usr/share/nginx/html
COPY --from=build /app/frontend/dist/app.js /usr/share/nginx/html/app.js
