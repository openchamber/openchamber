# Contributing to OpenChamber

## Getting Started

```bash
git clone https://github.com/btriapitsyn/openchamber.git
cd openchamber
bun install
```

## Dev Scripts

### Web

| Script | Description | Ports |
|--------|-------------|-------|
| `bun run dev:web:full` | Build watcher + Express server. No HMR — manual refresh after changes. | `3001` (server + static) |
| `bun run dev:web:hmr` | Vite dev server + Express API. **Open the Vite URL for HMR**, not the backend. | `5180` (Vite HMR), `3902` (API) |

Both are configurable via env vars: `OPENCHAMBER_PORT`, `OPENCHAMBER_HMR_UI_PORT`, `OPENCHAMBER_HMR_API_PORT`.

### Desktop (Tauri)

```bash
bun run desktop:dev
```

Launches Tauri in dev mode with WebView devtools enabled and a distinct dev icon.

### VS Code Extension

```bash
bun run vscode:dev    # Watch mode (extension + webview rebuild on save)
```

To test in VS Code:
```bash
bun run vscode:build && code --extensionDevelopmentPath="$(pwd)/packages/vscode"
```

### Shared UI (`packages/ui`)

No dev server — this is a source-level library consumed by other packages. During development, `bun run dev` runs type-checking in watch mode.

## Before Submitting

```bash
bun run type-check   # Must pass
bun run lint         # Must pass
bun run build        # Must succeed
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
  desktop/   Tauri macOS app (thin shell around the web UI)
  vscode/    VS Code extension (extension host + webview)
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
