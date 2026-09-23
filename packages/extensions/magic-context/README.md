# Magic Context for OpenChamber

The bundled panel recreates the Magic Context OpenCode sidebar and adds read-only cache and plugin-log diagnostics.

The panel uses `@openchamber/sdk` only. Its service reads the standard Magic Context and OpenCode SQLite paths plus the Magic Context log path used by `mcdash`. It does not start the Dashboard binary, call its HTTP server, modify either database, or return conversation text and raw log lines.

The service can read files only on the OpenChamber server host. A remote OpenChamber server does not read the browser machine's local files. The Magic Context plugin's private live sidebar RPC is not exposed to SDK guests, so the panel marks the exact component breakdown and live Historian/Dreamer state unavailable.

From the repository root, build and check the package with:

```bash
bun run extensions:build
bun run type-check:extensions
bun run lint:extensions
bun run test:extensions
```
