# ---- build ----
# Context is the repo root. Only frontend/src, frontend/package*.json, and
# frontend/tsconfig.json are required — all under frontend/src which is reliably
# included in the build context.
FROM node:20-alpine AS build

WORKDIR /app

COPY frontend/package*.json ./frontend/
RUN cd frontend && npm ci

COPY frontend/tsconfig.json ./frontend/
COPY frontend/src            ./frontend/src

RUN cd frontend && npm run build

# ---- runtime ----
FROM nginx:1.27-alpine

# Inline nginx config so we don't depend on the build context for this file.
RUN printf 'server {\n\
    listen 80;\n\
    server_name _;\n\
\n\
    client_max_body_size 50M;\n\
\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
\n\
    location / {\n\
        try_files $uri $uri/ /index.html;\n\
    }\n\
\n\
    location /api/ {\n\
        proxy_pass         http://backend:3000/;\n\
        proxy_http_version 1.1;\n\
        proxy_set_header   Host $host;\n\
        proxy_read_timeout 120s;\n\
        proxy_send_timeout 120s;\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf

COPY --from=build /app/frontend/dist /usr/share/nginx/html
