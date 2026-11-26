# Bundled OpenCode server

## Ownership

This folder is the bundled OpenCode server that both `@openchamber/web` and the Electron desktop app ship: `opencode serve` assembled from OpenCode's npm packages (`@opencode/server` and the packages it imports), pinned by the exact `@opencode/server` version in `packages/web/package.json` and `packages/electron/package.json`.

- **Web (`@openchamber/web`):** `packages/web/scripts/prepare-opencode-server.mjs` bundles it with Bun into `packages/web/build/opencode-server/`, copies `photon_rs_bg.wasm`, and writes `assets/manifest.json` with `mode: "node_modules"`. The four native wrapper packages (`@lydell/node-pty`, `@parcel/watcher`, `@ff-labs/fff-node`, `@opencode/pty`) live in `packages/web/package.json` `dependencies` so npm/Bun installs the host platform's prebuilt binaries and `assets.mjs` resolves them from `node_modules` at runtime.
- **Desktop (`@openchamber/electron`):** `packages/electron/scripts/prepare-opencode-server.mjs` calls the same bundler into `packages/electron/resources/opencode-server/` and downloads the target platform/architecture's native packages into `assets/` so cross-arch installers carry the right binaries. `packages/electron/scripts/verify-opencode-server.mjs` checks a staged or packaged copy.

The web server owns starting and stopping it. `lib/opencode/env-runtime.js` resolves `OPENCHAMBER_BUNDLED_OPENCODE_SERVER_DIR`, Electron's `resources/opencode-server/serve.mjs`, or the built web package's `build/opencode-server/serve.mjs` as the `bundled` OpenCode (ahead of `PATH`, behind explicit `OPENCODE_BINARY` / Settings / policy) and runs it through `resolveManagedOpenCodeLaunchSpec` on Node: Electron's executable with `ELECTRON_RUN_AS_NODE=1` in the app, the host's Node in web/CLI and HMR. When the host Node is older than 22.16, is any Node 23, or is no Node at all (such as Debian's Node 20 in Docker or a Bun binary symlinked as `node`), `bundled` is skipped and resolution falls back to `PATH` because `@opencode/core`'s Node build relies on `node:sqlite`, `node:module` `registerHooks`, and `node:vm` dynamic imports. The floor comes from its SQLite client (`@effect/sql-sqlite-node`): it imports `backup` from `node:sqlite`, which Node 22.15 lacks, so the server exits before it listens, and it calls `StatementSync#setReturnArrays`, which no Node 23 has. The desktop's SSH manager repeats the same rule in the probe it runs on a remote host (`remoteHasBundledOpenCode` in `packages/electron/ssh-manager.mjs`) to decide whether that host still needs its own `opencode`, so a new floor changes both. On Linux musl hosts (Alpine), the web package's `node_modules` bundle is also skipped because `@lydell/node-pty` ships glibc-only Linux binaries. From there `lib/opencode/lifecycle.js` treats it like any OpenCode binary.

- `serve.mjs`: the entry. Answers `--version` without loading OpenCode, refuses every command but `serve`, adds the operating system's CA certificates to the default TLS trust, sets the native paths, then loads the server. It runs as a bundle; the bundler defines `__OPENCODE_SERVER_VERSION__` from the pinned `@opencode/server` version.
- `args.mjs`: the command line, `serve [--stdio] [--hostname] [--port] [--cors]...` and `--version`.
- `assets.mjs`: points OpenCode at the staged natives (`OPENCODE_NODE_PTY_PATH`, `OPENCODE_PARCEL_WATCHER_PATH`, `OPENCODE_PHOTON_WASM_PATH`, `FFF_BINARY_PATH`, `OPENCODE_FFF_FFI_PATH`, `OPENCODE_PTY_BIN`) from `assets/manifest.json`.
- `plugin-runtime.mjs`: publishes OpenCode's plugin SDK so plugins that import `@opencode/plugin` get the host's copy, and loads the `.ts` and `.mts` plugin files under `node_modules` that Node refuses: it transforms their types and resolves the relative imports an npm plugin written for Bun's resolver uses — an extensionless one, or a `.js` suffix naming a `.ts` file. Resolution also covers a plugin loaded from a local checkout outside `node_modules`, which is how a symlinked plugin install points at its source.
- `server.mjs`: `opencode serve` in `default` and `stdio` modes. Service mode, the upstream web UI and the remote tunnel remain outside the desktop's server contract.

## Invariants

- It behaves as `opencode serve` does for the managed lifecycle: `--version` prints the bare version, `serve` prints `server listening on <url>` (`{"url":"<url>"}` with `--stdio`) on stdout, takes its password from `OPENCODE_PASSWORD` or `OPENCODE_SERVER_PASSWORD`, and with `--stdio` exits when stdin closes, which is how Windows stops it.
- `server.mjs` maps the environment to server options exactly as OpenCode's `packages/cli/src/server-process.ts` does for those two modes, and runs on the `latest` channel: the same `opencode.db`, `opencode.log` and data folders as the user's own release CLI. A bump of OpenCode diffs that file between the old and new tag (the `opencode-v2` skill, *Bumping the pinned OpenCode*).
- It removes `ELECTRON_RUN_AS_NODE` from its environment before anything starts: tools, MCP servers and shells inherit it, and an Electron app they launch would otherwise start as plain Node.
- Its TLS connections to `opencode.ai` and its subdomains offer Bun's cipher list, which `serve.mjs` adds through `tls.connect` before OpenCode loads. Without it, OpenCode Zen's free models answer 429 `FreeUsageLimitError`. All other hosts keep the runtime's default ciphers, and an explicit `--tls-cipher-list` turns the substitution off.
- Its TLS connections trust the operating system's CA store on top of Node's bundled list, as OpenCode's CLI does with `--use-system-ca`: `serve.mjs` calls the web server's `applySystemCertificates` (`server/lib/system-ca.ts`) before OpenCode loads. Without it, a provider behind a TLS-inspecting proxy whose root only the OS trusts fails with `SELF_SIGNED_CERT_IN_CHAIN`. A process started with `--use-openssl-ca`, in any form Node accepts on the command line or in `NODE_OPTIONS`, keeps OpenSSL's store.
- In stdio mode the server removes both password environment variables after reading them so tools cannot inherit the lease credential.
- It is a server script, never a command. The web server never puts its folder on `PATH` or its path in `OPENCODE_BINARY`, so a terminal or an agent's shell runs the user's own `opencode` or none.
- The staged natives match the target platform and architecture, not the build host's: Windows arm64 builds on x64 and macOS x64 on arm64. `verify-opencode-server.mjs` reads every native file's header to prove it.
- The bundle stages no `@number0/iroh` binding. OpenCode 2.4 loads it lazily, only for its experimental machines (remote workers), which this server does not offer.
- The bundle carries the JavaScript of the Claude Agent SDK, at the version `@opencode/core` names as its optional peer, so OpenCode's Claude Agent provider works. The SDK's platform package (a Claude Code binary) stays out: the provider runs the user's `claude`.

## Decisions

### Why a script on Electron's Node and not OpenCode's CLI binary

The CLI binary OpenCode publishes is a Bun executable that also carries its terminal UI, its web app and Bun itself: 213 MB in the app, against 33 to 40 MB, depending on the platform, for this server and its natives, which run on the Node every Electron build already contains. The managed lifecycle stays the same because the script answers the same command line.

### Why the server offers Bun's TLS ciphers

Zen's free tier lets a request through only when the TLS ClientHello's cipher list matches the one OpenCode's Bun CLI sends; headers such as `x-opencode-client` and `user-agent` play no part. Checked on 2026-11-20 by replaying one captured request: Node's and Electron's default cipher lists got 429, an arbitrary other list got 429, Bun's list got 200 from both Node and Electron's Node. Signature algorithms and key-exchange groups left at Node's defaults pass. The list is added per connection in `tls.connect`, which `fetch` calls too. Setting `tls.DEFAULT_CIPHERS` would cover the whole process, and a remote MCP server that needs a suite outside Bun's list, such as `ECDHE-RSA-AES128-SHA256`, could then no longer connect. Drop it when Zen accepts the desktop's server (`x-opencode-client: openchamber`) on its own.

### Why the server adds the system certificates itself and not `NODE_USE_SYSTEM_CA` in its environment

OpenCode's CLI compiles `--use-system-ca` into its own arguments, so the CLI process trusts the OS store and the shells, MCP servers and tools it starts keep their own trust. The variable in the launch environment would reach all of those children too. `tls.setDefaultCACertificates` changes only the calling thread; OpenCode's worker threads (image processing, Claude folder operations) open no TLS connections. On a host Node without that call (before 22.19, or 23.x to 24.4) the server still starts and the trust store in use stays as it is, including any `NODE_EXTRA_CA_CERTS`, as in the web server. It logs one warning when the step reaches a missing API; with OpenSSL trust chosen, or on 22.15 to 22.18 when the OS adds no certificate, the step ends before that.

### Why a child process and not the server inside the app's own process

OpenCode in the main process would share its fate: a hung or crashing agent would take the OpenChamber server and every window with it, and the server could no longer restart OpenCode on its own. A child keeps the restart, health and orphan machinery the lifecycle already has for every OpenCode, at the cost of the memory of a second Node process.

### Why `serve.mjs` sets the native paths and not a module imported first

The bundle splits into chunks, and an entry's statically imported chunks run before the entry's own code. OpenCode resolves its PTY binding while its modules evaluate, so the paths are set in the entry before it imports the server dynamically; a statically imported setup module would run after OpenCode already looked. The entry passes its own assets URL because `assets.mjs` runs from a chunk folder after bundling.

### Why the natives come from the registry and not from `node_modules`

`bun install` installs the platform packages of the build host only. Fetching the target's packages by the versions their parent packages name gives a cross-architecture build the right binaries and a host build the same files a release gets.

### Why some loaders are rewritten during bundling

`ffi-rs`, FFF's binary finder, photon's wasm loader and Turndown look for files next to their own package at run time, which a bundle no longer has; `jsonc-parser`'s `main` is a UMD build that requires its parts at run time. The plugin in `prepare-opencode-server.mjs` makes the same rewrites as OpenCode's Node build (`packages/cli/vite.node.config.ts`) and takes `jsonc-parser`'s ESM entry, so each loader reads the staged file or bundled module instead.

### Why the server closes a Windows folder watch itself

On Windows, `fs.watch` on a folder that is then deleted reports the folder's own absolute path without end, in Node and in Bun, and takes a whole core, mostly in the kernel (measured on 2026-11-25: Node 24.20, Bun 1.4.3, OpenCode 2.3.0). OpenCode watches `.git` and the parents of its config files this way, so deleting a project or worktree it has open was enough. `windows-folder-watch.mjs` wraps `fs.watch` before OpenCode loads and closes the watch at the first such event; ordinary events carry a relative name. A folder recreated at the same path is not watched again by that subscription, which matches a deleted folder on other platforms. Turning OpenCode's watcher off instead (`OPENCODE_DISABLE_FILEWATCHER`) would lose live config, skill and branch updates. The wrapper works on Node, which runs the bundle, and leaves watches with a non-UTF-8 encoding alone, where a relative name can decode to an absolute-looking one. An OpenCode the app does not bundle, including the Bun CLI, is not covered.

### Why an unchanged `HEAD` is not reported on Windows

Windows reports an access-time update as a change, so reading `.git/HEAD` can look like a branch switch, and OpenCode answers every `HEAD` event with git commands that read the file again (8 per event, measured on 2.3.0 and 2.4.1). The bundler rewrites OpenCode's own file watch to ask `createHeadGuard`, which drops the event when the file's identity, size and modification time are unchanged. The check sits in OpenCode's callback and not in the `fs.watch` wrapper, so plugins' watches keep every event. It compares metadata and not content, because reading the file would move its access time again. The first event always passes, so a switch made while the watch starts is not lost, and the filter applies only under a `.git` folder. A reftable repository keeps a placeholder in `HEAD` and is left unfiltered. Bundling fails when the code it rewrites is gone.

### Why a missing FFF binding allows startup

FFF reports itself unavailable without its native binding, and OpenCode falls back to plain file search. Failure to load that binding therefore leaves the server usable.

### Why plugins resolve the host's SDK

User-installed plugins can import `@opencode/plugin` without a copy installed beside them. Following OpenCode's Node build, the server publishes its Promise and Effect SDKs on `globalThis` and resolves plugin SDK specifiers to modules that re-export those copies.

### Why the loader transforms TypeScript plugin entrypoints

OpenCode imports a plugin from its installed package, and npm plugins commonly publish a `.ts` entrypoint under `~/.cache/opencode/npm/.../node_modules/`, where Node refuses to strip types (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). In 2.7.2 the same import went through Bun, which transpiles TypeScript anywhere, so this regressed when the desktop switched to OpenCode's server on Electron's Node. For a `file:` URL whose path has a `node_modules` segment and ends in `.ts` or `.mts`, the loader reads the file, transforms it with `stripTypeScriptTypes` and returns it as a module, which bypasses the restriction without moving the plugin out of the folder OpenCode resolves it from. Transform mode, not strip mode: a plugin may use an enum or a constructor parameter property, and strip mode cannot emit their code. Every other URL, including a local TypeScript plugin outside `node_modules`, goes to Node's default loader and keeps its package format.

Plugins written for Bun also import their own modules without a file extension, or with the `.js` suffix tsc emits for a `.ts` file, and Node's ES resolver rejects both. The loader covers a subset of Bun's resolution, not all of it: an ES `import` from a plugin's own `.ts` or `.mts` file, of a `./` or `../` specifier that Node itself failed to resolve. A specifier ending in `/` names a directory and tries only the `index` inside it, so `./v1.js/` never loads `v1.ts`; a specifier ending in `.js` or `.mjs` is retried with the TypeScript suffix it stands for; an extensionless one is tried with each suffix appended, then the same suffixes on an `index` inside it. From an installed package's file the order is `.mjs`, `.mts`, `.js`, `.cjs`, `.ts`, `.json`; from a local plugin's file it is `.mts`, `.ts`, `.mjs`, `.js`, `.cjs`, `.json`, so a checkout's source wins over build output beside it. Those are the orders Bun 1.4.4 uses for these suffixes inside and outside `node_modules`. The file it finds goes back through Node's resolver, so a symlink loads as the same module as an import of its target. A resolution Node already makes stays Node's, and a `require()` from those files, such as one through `createRequire()`, is never probed.

A plugin's own file is one of two kinds. An installed package's file has a `node_modules` segment in its path. A local plugin, such as a file in a `plugins` folder that is a symlink to the TypeScript source in a checkout, is imported by OpenCode's loader (`prepareSource` in `@opencode/plugin`) with a `__opencode_reload` query on its entry and on every module outside `node_modules` it reaches, and the loader takes that query as the mark. Any other TypeScript file the server imports keeps Node's resolution and its error.

Local checkout files get only the resolution, never the transform: Node strips their types itself, so they carry Node's own limits, separate from the installed-package ones below:

- The bundle can start on Node 22.16 and 22.17, where type stripping is off by default, so a local `.ts` plugin fails there before any of its imports resolve.
- Node strips in strip mode, so a local plugin with an enum, a runtime namespace or a constructor parameter property fails to load on every Node version.

Installed packages still hit four limits, all gaps against Bun rather than regressions against 2.7.3:

- A `.ts` entry under `node_modules` always loads as a module, so a CommonJS-syntax `.ts` plugin fails, including one written with `import x = require(...)` or `export =`.
- A `.cts` entry fails: Node's CommonJS loader strips types again by file extension and refuses the path, whatever source a hook returns.
- A `.tsx` entry or import fails: the loader transforms only `.ts` and `.mts`, so Node still rejects the extension.
- Node 26 removed the transform mode, so there the loader falls back to strip mode: a plugin with an enum, a runtime namespace or a constructor parameter property fails to load, while a plugin that only carries types still loads.

### Why both Claude Code flags gate the same roots

The server reads `.claude` directories only for skills, so either `OPENCODE_DISABLE_CLAUDE_CODE` or `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` disables those roots.
