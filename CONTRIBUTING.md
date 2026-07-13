# Contributing to OpenChamber

## Getting Started

```bash
git clone https://github.com/btriapitsyn/openchamber.git
cd openchamber
bun install
```

## Worktree Local Development

Run this from inside any already-created worktree (for example, one created by OpenChamber).

```bash
# Show all detected worktrees and assigned UI/API port pairs
bun run dev:worktree:list

# Show export commands for this worktree's assigned ports
bun run dev:worktree:ports

# Install dependencies in this worktree (first run there)
bun install --frozen-lockfile

# Start this worktree with its assigned ports
bun run dev:worktree
```

Open the printed **UI URL** (HMR), not the API URL.

Bun reuses its global cache, so dependencies are reused across worktrees.

## Dev Scripts

Run commands from the project root unless a section says otherwise.

### Web

| Script | Description | Ports |
|--------|-------------|-------|
| `bun run dev` | Default web HMR dev flow. | auto-selected dev ports |
| `bun run dev:web:full` | Build watcher + Express server. No HMR — manual refresh after changes. | `3001` (server + static) |
| `bun run dev:web:hmr` | Vite dev server + Express API. **Open the Vite URL for HMR**, not the backend. | `5180` (Vite HMR), `3902` (API) |
| `bun run dev:worktree:list` | List detected worktrees with assigned UI/API ports. | per-worktree assigned |
| `bun run dev:worktree:ports` | Print export commands for current worktree UI/API ports. | per-worktree assigned |
| `bun run dev:worktree` | Start web HMR using current worktree assigned ports. | per-worktree assigned |
| `bun run start:web` | Start the packaged web server. | `3000` by default |

Both are configurable via env vars: `OPENCHAMBER_PORT`, `OPENCHAMBER_HMR_UI_PORT`, `OPENCHAMBER_HMR_API_PORT`.

### Desktop (Electron)

```bash
bun run electron:dev          # HMR web UI + Electron shell
bun run electron:dev:bundled  # Electron shell using built web assets
bun run electron:build        # Package desktop app for the current platform
```

Desktop supports macOS and Windows. The build output is written to `packages/electron/dist`.

macOS builds create `dmg` and `zip` files. You need Xcode/build tools for notarized packaging and icon asset work.

Windows builds create an NSIS installer. If signing env vars are not set, the build script makes an unsigned installer.

For desktop-specific details, see [`packages/electron/README.md`](./packages/electron/README.md).

### VS Code Extension

```bash
bun run vscode:dev      # Watch mode + Extension Development Host
bun run vscode:build    # Build extension + webview
bun run vscode:package  # Create a local .vsix package
```

`bun run vscode:dev` opens an Extension Development Host automatically. You can override the editor or workspace with `OPENCHAMBER_VSCODE_BIN` and `OPENCHAMBER_VSCODE_DEV_WORKSPACE`.

Example: `OPENCHAMBER_VSCODE_BIN=cursor bun run vscode:dev`.

### Shared UI (`packages/ui`)

No standalone app server. This is a source-level library used by Web, Desktop, and VS Code.

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
| `bun run build:electron` | Run Electron package build script without full packaging |
| `bun run electron:build` | Build packaged desktop app for the current OS |
| `bun run vscode:build` | Build the VS Code extension |
| `bun run vscode:package` | Package the VS Code extension as `.vsix` |
| `bun run pack:web` | Create a package archive for `@openchamber/web` |

## Platform Build Notes

You usually build desktop installers on the target platform.

macOS:

```bash
bun run electron:build
bun run release:test:intel
bun run release:test:arm
```

Windows:

```bash
bun run electron:build
```

Linux is supported for web/CLI development. A Linux desktop app is still planned, so Electron packaging is mainly macOS and Windows right now.

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
  electron/  Electron desktop shell
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
