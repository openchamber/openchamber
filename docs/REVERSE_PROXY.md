# Reverse Proxy Setup

Use this guide when running OpenChamber behind Nginx, Nginx Proxy Manager, Caddy, Cloudflare, or another reverse proxy.

## Before you proxy it

1. Confirm OpenChamber works directly first.
2. Open `http://<server-ip>:3000` or your custom port from the same network.
3. Only add the reverse proxy after the direct connection works.

## What the proxy must support

- WebSockets for live message transport:
  - `/api/event/ws`
  - `/api/global/event/ws`
  - `/api/terminal/ws`
- SSE without buffering:
  - `/api/event`
  - `/api/global/event`
  - `/api/notifications/stream`
  - `/api/openchamber/events`
  - `/api/terminal/:sessionId/stream`
- Large request bodies for attachments and file operations
- Long-lived read timeouts for live streams and terminal sessions

## Rules that matter

- Enable WebSocket proxying.
- Disable buffering on SSE routes.
- Disable gzip on the proxy if OpenChamber is already compressing responses.
- Keep compression enabled in only one layer.
- Forward normal proxy headers such as `Host`, `X-Forwarded-For`, and `X-Forwarded-Proto`.
- Increase body size limits if users upload files.

## Quick checklist

- OpenChamber reachable directly on LAN
- WebSockets enabled in the proxy
- SSE routes have buffering off
- `gzip off` on the proxy host, or proxy compression disabled another way
- `client_max_body_size` large enough for attachments
- `proxy_read_timeout` long enough for streams

## Example: Nginx

<details>
<summary>Show example config</summary>

```nginx
client_max_body_size 50M;
client_body_buffer_size 50M;
proxy_request_buffering off;

proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $host;

gzip off;

location = /api/terminal/ws {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

location = /api/global/event/ws {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

location = /api/event/ws {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

location ~ ^/api/(event|global/event|notifications/stream|openchamber/events)$ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Accept "text/event-stream";
    proxy_set_header Cache-Control "no-cache";
    proxy_buffering off;
    proxy_cache off;
    gzip off;
    add_header X-Accel-Buffering "no" always;
    add_header Cache-Control "no-cache, no-transform" always;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

location ~ ^/api/terminal/.+/stream$ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Accept "text/event-stream";
    proxy_set_header Cache-Control "no-cache";
    proxy_buffering off;
    proxy_cache off;
    gzip off;
    add_header X-Accel-Buffering "no" always;
    add_header Cache-Control "no-cache, no-transform" always;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

location /api {
    proxy_pass http://127.0.0.1:3000;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

location / {
    proxy_pass http://127.0.0.1:3000;
}
```

</details>

## Example: Nginx Proxy Manager

<details>
<summary>Show Advanced tab example</summary>

```nginx
client_max_body_size 50M;
client_body_buffer_size 50M;
proxy_request_buffering off;

proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $host;

gzip off;

location = /api/terminal/ws {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_connect_timeout 30s;
}

location = /api/global/event/ws {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_connect_timeout 30s;
}

location = /api/event/ws {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_connect_timeout 30s;
}

location = /api/event {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Accept "text/event-stream";
    proxy_set_header Cache-Control "no-cache";
    proxy_buffering off;
    proxy_cache off;
    gzip off;
    add_header X-Accel-Buffering "no" always;
    add_header Cache-Control "no-cache, no-transform" always;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_connect_timeout 30s;
}

location = /api/global/event {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Accept "text/event-stream";
    proxy_set_header Cache-Control "no-cache";
    proxy_buffering off;
    proxy_cache off;
    gzip off;
    add_header X-Accel-Buffering "no" always;
    add_header Cache-Control "no-cache, no-transform" always;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_connect_timeout 30s;
}

location = /api/notifications/stream {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Accept "text/event-stream";
    proxy_set_header Cache-Control "no-cache";
    proxy_buffering off;
    proxy_cache off;
    gzip off;
    add_header X-Accel-Buffering "no" always;
    add_header Cache-Control "no-cache, no-transform" always;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_connect_timeout 30s;
}

location = /api/openchamber/events {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Accept "text/event-stream";
    proxy_set_header Cache-Control "no-cache";
    proxy_buffering off;
    proxy_cache off;
    gzip off;
    add_header X-Accel-Buffering "no" always;
    add_header Cache-Control "no-cache, no-transform" always;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_connect_timeout 30s;
}

location ~ ^/api/terminal/.+/stream$ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Accept "text/event-stream";
    proxy_set_header Cache-Control "no-cache";
    proxy_buffering off;
    proxy_cache off;
    gzip off;
    add_header X-Accel-Buffering "no" always;
    add_header Cache-Control "no-cache, no-transform" always;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_connect_timeout 30s;
}

location /api {
    proxy_pass http://127.0.0.1:3000;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_connect_timeout 30s;
}

location / {
    proxy_pass http://127.0.0.1:3000;
}
```

</details>

Also enable `Websockets Support` in Nginx Proxy Manager for this host.

## Common failure signs

### Page loads, but sending messages fails

- WebSockets are not enabled in the proxy
- `/api/event/ws` or `/api/global/event/ws` is not passing through correctly

### Notifications or live status do not update

- one of the SSE routes is buffered or cached
- `X-Accel-Buffering "no"` is missing

### File uploads fail

- `client_max_body_size` is too small

### Everything works locally, but breaks only behind the proxy

- the proxy is compressing and buffering live traffic
- the proxy is missing WebSocket support

## Website docs

- Website version: `packages/docs/content/docs/reverse-proxy.mdx`
