# Contributing to OpenChamber

## Development

```bash
git clone https://github.com/btriapitsyn/openchamber.git
cd openchamber
bun install

# Web development
bun run dev:web:full

# Desktop app (Tauri)
bun run desktop:dev

# VS Code extension
bun run vscode:build && code --extensionDevelopmentPath="$(pwd)/packages/vscode"

# Production build
bun run build
```

### Alternative: Nix Flake

If you use Nix, the flake provides a complete dev shell with all dependencies (bun, node, rust, cargo-tauri, native build tools):

```bash
nix develop   # enters the dev shell
bun install   # install JS dependencies
bun run dev:web:full
```

## Before Submitting

```bash
bun run type-check   # Must pass
bun run lint         # Must pass
bun run build        # Must succeed
```

## Code Style

- Functional React components only
- TypeScript strict mode - no `any` without justification
- Use existing theme colors/typography - don't add new ones
- Components must support light and dark themes

## Pull Requests

1. Fork and create a branch
2. Make changes
3. Run validation commands above
4. Submit PR with clear description of what and why

## Project Structure

See [AGENTS.md](./AGENTS.md) for detailed architecture reference.

## Questions?

Open an issue.
