# Bundled OpenCode server

## Ownership

This folder is the OpenCode the desktop app ships: `opencode serve` assembled from OpenCode's npm packages (`@opencode/server` and the packages it imports), pinned by the exact `@opencode/server` version in `packages/electron/package.json`. `scripts/prepare-opencode-server.mjs` bundles it with Bun into `resources/opencode-server/` and stages beside the bundle, under `assets/`, the native files OpenCode loads from disk, taken from the npm packages for the target platform and architecture. `scripts/verify-opencode-server.mjs` checks a staged or packaged copy.

The web server owns starting and stopping it. `lib/opencode/env-runtime.js` resolves `resources/opencode-server/serve.mjs` (or `OPENCHAMBER_BUNDLED_OPENCODE_SERVER_DIR`) as the `bundled` OpenCode and runs it through `resolveManagedOpenCodeLaunchSpec` on the host's own Node: Electron's executable with `ELECTRON_RUN_AS_NODE=1` in the app, the dev machine's Node under HMR. From there `lib/opencode/lifecycle.js` treats it like any OpenCode binary.

- `serve.mjs`: the entry. Answers `--version` without loading OpenCode, refuses every command but `serve`, sets the native paths, then loads the server. It runs as a bundle; the bundler defines `__OPENCODE_SERVER_VERSION__` from the pinned `@opencode/server` version.
- `args.mjs`: the command line, `serve [--stdio] [--hostname] [--port] [--cors]...` and `--version`.
- `assets.mjs`: points OpenCode at the staged natives (`OPENCODE_NODE_PTY_PATH`, `OPENCODE_PARCEL_WATCHER_PATH`, `OPENCODE_PHOTON_WASM_PATH`, `FFF_BINARY_PATH`, `OPENCODE_FFF_FFI_PATH`, `OPENCODE_PTY_BIN`) from `assets/manifest.json`.
- `plugin-runtime.mjs`: publishes OpenCode's plugin SDK so plugins that import `@opencode/plugin` get the host's copy, and strips `.ts` and `.mts` plugin entrypoints that Node refuses to load from `node_modules`.
- `server.mjs`: `opencode serve` in `default` and `stdio` modes. Service mode, the upstream web UI and the remote tunnel remain outside the desktop's server contract.

## Invariants

- It behaves as `opencode serve` does for the managed lifecycle: `--version` prints the bare version, `serve` prints `server listening on <url>` (`{"url":"<url>"}` with `--stdio`) on stdout, takes its password from `OPENCODE_PASSWORD` or `OPENCODE_SERVER_PASSWORD`, and with `--stdio` exits when stdin closes, which is how Windows stops it.
- `server.mjs` maps the environment to server options exactly as OpenCode's `packages/cli/src/server-process.ts` does for those two modes, and runs on the `latest` channel: the same `opencode.db`, `opencode.log` and data folders as the user's own release CLI. A bump of OpenCode diffs that file between the old and new tag (the `opencode-v2` skill, *Bumping the pinned OpenCode*).
- It removes `ELECTRON_RUN_AS_NODE` from its environment before anything starts: tools, MCP servers and shells inherit it, and an Electron app they launch would otherwise start as plain Node.
- Its TLS connections to `opencode.ai` and its subdomains offer Bun's cipher list, which `serve.mjs` adds through `tls.connect` before OpenCode loads. Without it, OpenCode Zen's free models answer 429 `FreeUsageLimitError`. All other hosts keep the runtime's default ciphers, and an explicit `--tls-cipher-list` turns the substitution off.
- In stdio mode the server removes both password environment variables after reading them so tools cannot inherit the lease credential.
- It is a server script, never a command. The web server never puts its folder on `PATH` or its path in `OPENCODE_BINARY`, so a terminal or an agent's shell runs the user's own `opencode` or none.
- The staged natives match the target platform and architecture, not the build host's: Windows arm64 builds on x64 and macOS x64 on arm64. `verify-opencode-server.mjs` reads every native file's header to prove it.
- The bundle carries the JavaScript of the Claude Agent SDK, at the version `@opencode/core` names as its optional peer, so OpenCode's Claude Agent provider works. The SDK's platform package (a Claude Code binary) stays out: the provider runs the user's `claude`.

## Decisions

### Why a script on Electron's Node and not OpenCode's CLI binary

The CLI binary OpenCode publishes is a Bun executable that also carries its terminal UI, its web app and Bun itself: 213 MB in the app, against 33 to 40 MB, depending on the platform, for this server and its natives, which run on the Node every Electron build already contains. The managed lifecycle stays the same because the script answers the same command line.

### Why the server offers Bun's TLS ciphers

Zen's free tier lets a request through only when the TLS ClientHello's cipher list matches the one OpenCode's Bun CLI sends; headers such as `x-opencode-client` and `user-agent` play no part. Checked on 2026-11-20 by replaying one captured request: Node's and Electron's default cipher lists got 429, an arbitrary other list got 429, Bun's list got 200 from both Node and Electron's Node. Signature algorithms and key-exchange groups left at Node's defaults pass. The list is added per connection in `tls.connect`, which `fetch` calls too. Setting `tls.DEFAULT_CIPHERS` would cover the whole process, and a remote MCP server that needs a suite outside Bun's list, such as `ECDHE-RSA-AES128-SHA256`, could then no longer connect. Drop it when Zen accepts the desktop's server (`x-opencode-client: openchamber`) on its own.

### Why a child process and not the server inside the app's own process

OpenCode in the main process would share its fate: a hung or crashing agent would take the OpenChamber server and every window with it, and the server could no longer restart OpenCode on its own. A child keeps the restart, health and orphan machinery the lifecycle already has for every OpenCode, at the cost of the memory of a second Node process.

### Why `serve.mjs` sets the native paths and not a module imported first

The bundle splits into chunks, and an entry's statically imported chunks run before the entry's own code. OpenCode resolves its PTY binding while its modules evaluate, so the paths are set in the entry before it imports the server dynamically; a statically imported setup module would run after OpenCode already looked. The entry passes its own assets URL because `assets.mjs` runs from a chunk folder after bundling.

### Why the natives come from the registry and not from `node_modules`

`bun install` installs the platform packages of the build host only. Fetching the target's packages by the versions their parent packages name gives a cross-architecture build the right binaries and a host build the same files a release gets.

### Why some loaders are rewritten during bundling

`ffi-rs`, FFF's binary finder, photon's wasm loader and Turndown look for files next to their own package at run time, which a bundle no longer has; `jsonc-parser`'s `main` is a UMD build that requires its parts at run time. The plugin in `prepare-opencode-server.mjs` makes the same rewrites as OpenCode's Node build (`packages/cli/vite.node.config.ts`) and takes `jsonc-parser`'s ESM entry, so each loader reads the staged file or bundled module instead.

### Why a missing FFF binding allows startup

FFF reports itself unavailable without its native binding, and OpenCode falls back to plain file search. Failure to load that binding therefore leaves the server usable.

### Why plugins resolve the host's SDK

User-installed plugins can import `@opencode/plugin` without a copy installed beside them. Following OpenCode's Node build, the server publishes its Promise and Effect SDKs on `globalThis` and resolves plugin SDK specifiers to modules that re-export those copies.

### Why the loader strips TypeScript plugin entrypoints

OpenCode imports a plugin from its installed package, and npm plugins commonly publish a `.ts` entrypoint under `~/.cache/opencode/npm/.../node_modules/`, where Node refuses to strip types (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). In 2.7.2 the same import went through Bun, which transpiles TypeScript anywhere, so this regressed when the desktop switched to OpenCode's server on Electron's Node. For a `file:` URL whose path has a `node_modules` segment and ends in `.ts` or `.mts`, the loader reads the file, strips its types with `stripTypeScriptTypes` and returns it as a module, which bypasses the restriction without moving the plugin out of the folder OpenCode resolves it from. Every other URL, including a local TypeScript plugin outside `node_modules`, goes to Node's default loader and keeps its package format.

Installed packages still hit three limits, all gaps against Bun rather than regressions against 2.7.3:

- A `.ts` entry under `node_modules` always loads as a module, so a CommonJS-syntax `.ts` plugin fails.
- A `.cts` entry fails: Node's CommonJS loader strips types again by file extension and refuses the path, whatever source a hook returns.
- The strip mode does not transform, so a plugin using an enum, a runtime namespace or a constructor parameter property fails to load.

### Why both Claude Code flags gate the same roots

The server reads `.claude` directories only for skills, so either `OPENCODE_DISABLE_CLAUDE_CODE` or `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` disables those roots.
