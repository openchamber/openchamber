# Contributing to OpenChamber

The repo is split into two **independent** projects. Each has its own
`package.json`, dependency tree, and lockfile, and is built/deployed separately.

- **`client/`** — web/PWA frontend, shared UI, and the Android app.
- **`backend/`** — the Express API server (deploys to Render).

## Getting Started

```bash
git clone https://github.com/btriapitsyn/openchamber.git
cd openchamber

# Client
cd client && bun install

# Backend (separate install)
cd ../backend && bun install
```

## Client

Run commands from `client/`.

| Script | Description |
|--------|-------------|
| `bun run dev` | Vite build watcher for the web/PWA frontend |
| `bun run build` | Production build of the web/PWA frontend (`client/web/dist`) |
| `bun run type-check` | Type-check web + ui + mobile |
| `bun run lint` | Lint web + ui + mobile |

The client talks to the backend over its public URL. Set it at build time:

```bash
# client/.env  (see client/.env.example)
VITE_API_URL=https://openchamber-backend.onrender.com
```

When `VITE_API_URL` is unset, local dev proxies `/api`, `/auth`, and `/health`
to `http://127.0.0.1:3001` (see `client/web/vite.config.ts`).

### Android (Mobile)

The Android app is a [Capacitor](https://capacitorjs.com/) shell that wraps the
built web UI from `client/web`. Run from `client/`:

```bash
bun run mobile:build                 # Build web assets and stage them for the app
bun run mobile:sync                  # Build + copy assets into the native Android project
bun run mobile:build:android:debug   # Build a debug APK
bun run mobile:open:android          # Open the project in Android Studio
```

Requires the Android SDK (and a JDK). The native project lives in
`client/mobile/android`. See [`client/mobile/README.md`](./client/mobile/README.md).

### Shared UI (`client/ui`)

A source-level library consumed by the web app and the Android shell via the
`@openchamber/ui` / `@` Vite + TS path aliases (no separate build step).

## Backend

Run commands from `backend/`.

| Script | Description |
|--------|-------------|
| `bun run dev` | Start the Express server on `OPENCHAMBER_PORT` (default 3001) |
| `npm start` | `openchamber serve` — production start |
| `bun run type-check` | Type-check the server |
| `bun run test` | Run server tests (Vitest) |

Configuration is via env vars (see `backend/.env.example`). Key ones:
`OPENCHAMBER_HOST`, `PORT`, `OPENCHAMBER_UI_PASSWORD`, `OPENCHAMBER_CLIENT_URL`,
and the `DAYTONA_*` sandbox settings.

## Before Submitting

Client:

```bash
cd client && bun run type-check && bun run lint && bun run build
```

Backend:

```bash
cd backend && bun run type-check && bun run test
```

## Code Style

- Functional React components only
- TypeScript strict mode — no `any` without justification
- Use existing theme colors/typography from `client/ui/src/lib/theme/` — don't add new ones
- Components must support light and dark themes
- Prefer early returns and `if/else`/`switch` over nested ternaries
- Tailwind v4 for styling; typography via `client/ui/src/lib/typography.ts`

## Pull Requests

1. Fork and create a branch
2. Make changes
3. Run the validation commands above
4. Submit PR with clear description of what and why

## Project Structure

```
client/            Independent Bun workspace (deploys as static site / Android APK)
  web/             Web/PWA frontend (Vite)
  ui/              Shared React components, hooks, stores, theme system
  mobile/          Android app (Capacitor shell wrapping the web UI)
backend/           Independent Express API server (deploys to Render)
  server/          Server + OpenCode/Daytona orchestration + proxies
  bin/             CLI entrypoint
docs-site/         Documentation website content
```

See [AGENTS.md](./AGENTS.md) for detailed architecture reference.

## Not a developer?

You can still help:

- Report bugs or UX issues — even "this felt confusing" is valuable feedback
- Test on different devices, browsers, or OS versions
- Suggest features or improvements via issues
- Help others in Discord

## Questions?

Open an [issue](https://github.com/btriapitsyn/openchamber/issues) or ask in [Discord](https://discord.gg/ZYRSdnwwKA).
