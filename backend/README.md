# OpenChamber Backend

Standalone Express server that orchestrates OpenCode sessions. Each chat session
provisions an isolated [Daytona](https://www.daytona.io/) sandbox with OpenCode
running inside; the backend proxies the client's traffic to that sandbox and
tears it down on an explicit exit command or after 10 minutes of inactivity.

This package is **independent** from the client. It exposes an HTTP + WebSocket
API and does not serve any frontend assets (API-only mode). The client talks to
this server over its public URL.

## Run locally

```bash
cd backend
npm install
OPENCHAMBER_UI_PASSWORD=dev npm start        # serves on http://127.0.0.1:3000
```

Or with an explicit port/host:

```bash
node server/index.js --host 0.0.0.0 --port 3001
```

## Deploy on Render

Two options:

1. **Blueprint / native Node runtime** — point Render at this repo, set the root
   directory to `backend/`, and it will pick up `render.yaml`:
   - Build command: `npm install`
   - Start command: `node server/index.js --host 0.0.0.0`
   - Health check path: `/health`
2. **Docker** — use the provided `backend/Dockerfile`.

### Required environment variables

| Variable | Notes |
|----------|-------|
| `OPENCHAMBER_HOST` | `0.0.0.0` on Render so the platform can route traffic |
| `PORT` | Injected by Render automatically; the server honors it |
| `OPENCHAMBER_UI_PASSWORD` | **Required** when exposed publicly (auth gate) |
| `OPENCHAMBER_CLIENT_URL` | Public URL of the deployed client (for CORS) |
| `DAYTONA_API_KEY` | Enables Daytona sandbox orchestration |
| `DAYTONA_API_URL` | Default `https://app.daytona.io` |
| `DAYTONA_SANDBOX_IMAGE` | Sandbox image with OpenCode pre-installed |
| `DAYTONA_SANDBOX_TIMEOUT_MS` | Inactivity timeout (default `600000` = 10 min) |
| `DAYTONA_OPENCODE_PORT` | OpenCode port inside the sandbox (default `4096`) |

See `.env.example` for a complete template.

## Structure

- `server/` — Express app, routes, OpenCode + Daytona orchestration, proxies
- `bin/` — CLI entrypoint (`openchamber serve`, tunnel helpers, etc.)
