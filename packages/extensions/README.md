# Built-in extensions

App-owned extensions live here and use the public `@openchamber/sdk` contract. This directory is not a Bun workspace and adds no runtime dependencies. The build resolves SDK entrypoints from the SDK workspace.

From the repository root:

```bash
bun run extensions:build
```

`registry.json` is the allowlist. Each entry names a package directory, explicit files to ship, and browser or Node build entries. Browser entries must produce a single IIFE; embed imported images rather than relying on runtime-relative URLs. The build stamps package versions with the app version and validates the finished packages with the same parser as user installs.

Output goes to `packages/web/server/built-in-extensions/`. It is generated, ignored by Git, and included in the web package. Root installation, web builds and web packaging build it automatically. Rebuild after editing a built-in, then reopen its panel. Registry changes require a server restart.

Packaged Electron unpacks these resources from ASAR so future service entries can run as ordinary files. The backend selects its app-owned registry; user extensions and user data are stored separately.

The registry includes the first-party Magic Context panel. It reads local cache and plugin-log diagnostics through a read-only service; the package does not include the Magic Context dashboard binary or add a runtime dependency. Build tests also use temporary fixtures.

The Magic Context source is type-checked and linted through the root `type-check` and `lint` scripts. Its database and log readers have focused tests under `packages/extensions/magic-context/`.

Implementation and trust rules: [DOCUMENTATION.md](./DOCUMENTATION.md).
