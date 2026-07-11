# Contributing to OpenChamber

## Getting Started

```bash
git clone https://github.com/btriapitsyn/openchamber.git
cd openchamber
bun install
```

## Dev Scripts

Run commands from the project root unless a section says otherwise.

### Web

| Script | Description | Ports |
|--------|-------------|-------|
| `bun run dev` | Default web HMR dev flow. | auto-selected dev ports |
| `bun run dev:web:full` | Build watcher + Express server. No HMR — manual refresh after changes. | `3001` (server + static) |
| `bun run dev:web:hmr` | Vite dev server + Express API. **Open the Vite URL for HMR**, not the backend. | `5180` (Vite HMR), `3902` (API) |
| `bun run start:web` | Start the packaged web server. | `3000` by default |

Both are configurable via env vars: `OPENCHAMBER_PORT`, `OPENCHAMBER_HMR_UI_PORT`, `OPENCHAMBER_HMR_API_PORT`.

### Android (Mobile)

The Android app is a [Capacitor](https://capacitorjs.com/) shell that wraps the built web UI from `packages/web`.

```bash
bun run mobile:build                 # Build web assets and stage them for the app
bun run mobile:sync                  # Build + copy assets into the native Android project
bun run mobile:build:android:debug   # Build a debug APK
bun run mobile:open:android          # Open the project in Android Studio
```

Requires the Android SDK (and a JDK). The native project lives in `packages/mobile/android`. See [`packages/mobile/README.md`](./packages/mobile/README.md) for device/emulator workflows.

### Shared UI (`packages/ui`)

No standalone app server. This is a source-level library used by Web and the Android app.

Useful package commands:

```bash
bun run build:ui
bun run type-check:ui
bun run lint:ui
```

## Build And Package Commands

| Command | What it does |
|---------|--------------|
| `bun run build` | Build all workspaces |
| `bun run build:web` | Build only `packages/web` |
| `bun run build:ui` | Build only `packages/ui` |
| `bun run mobile:build` | Build web assets and stage them for the Android app |
| `bun run mobile:build:android:debug` | Build a debug Android APK |
| `bun run pack:web` | Create a package archive for `@openchamber/web` |

## Before Submitting

```bash
bun run type-check   # Must pass
bun run lint         # Must pass
bun run build        # Must succeed
```

For docs-only changes, validation may be enough:

```bash
bun run docs:validate
```

## Code Style

- Functional React components only
- TypeScript strict mode — no `any` without justification
- Use existing theme colors/typography from `packages/ui/src/lib/theme/` — don't add new ones
- Components must support light and dark themes
- Prefer early returns and `if/else`/`switch` over nested ternaries
- Tailwind v4 for styling; typography via `packages/ui/src/lib/typography.ts`

## Pull Requests

1. Fork and create a branch
2. Make changes
3. Run the validation commands above
4. Submit PR with clear description of what and why

## Project Structure

```
packages/
  ui/        Shared React components, hooks, stores, and theme system
  web/       Web server (Express) + frontend (Vite) + CLI
  mobile/    Android app (Capacitor shell wrapping the web UI)
  docs/      Documentation site source
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
