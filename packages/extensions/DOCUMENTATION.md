# Built-in extension ownership

## Source and build

- `registry.json` is the app-owned allowlist. IDs use the reserved `openchamber-builtin-` prefix and remain stable across releases.
- Each package uses the ordinary SDK manifest and public SDK APIs. Built-in status does not expose private stores, credentials, or native bridges to its iframe.
- `scripts/build-builtin-extensions.mjs` copies only declared files, bundles declared entries, stamps the app version, and validates the staged output before replacing the previous complete bundle. Browser output is a self-contained IIFE. Node service output is ESM.
- Panel translations live with the package and use `HostReadyContext.locale`. They cannot consume the host React i18n context across the iframe boundary. Keep all 12 host locales covered.
- A built-in's `contributes.service` still runs with the host user's filesystem rights and no OS sandbox. Keep service reads narrow, avoid shelling out, and return only the data the panel needs.
- `packages/web/server/built-in-extensions/` is generated app code, not user data. Web builds, web prepack and root postinstall prepare it. Packaged Electron keeps it in `app.asar.unpacked/node_modules/@openchamber/web/server/built-in-extensions` and supplies that physical root to the in-process backend.

## Runtime authority

- `server/lib/guests/builtins.js` parses the registry; `catalog.js` binds it to an instance's persistence path during server startup. HTTP requests and extension manifests cannot change that binding.
- Only packages reached through that registry, with a matching ID and a canonical directory inside its root, become `source: 'bundled'`. An invalid individual package is skipped without blocking valid packages; a missing or invalid registry is a startup/build failure.
- The server derives grants from the built-in's current declarations. Keep normal capability, path, credential-target and enabled-state checks. Automatic approval is not unrestricted authority.
- User installs cannot use the reserved namespace, even with `replace`. Built-ins cannot be removed, Git-updated or have their grants edited through the public API.
- `disabledGuests` persists the user's decision independently of code paths and versions. Provider credentials and extension storage stay in the instance data directory. Disable stops services and API access while retaining data and credentials.
- Settings puts enabled built-in token/OAuth cards inside Built-in integrations. Other extension accounts stay in their existing section.
- Current renderer support remains web and Electron, direct or relay. VS Code and mobile keep the existing explicit unsupported behavior. Migrate an existing core feature only after deciding its behavior on every surface where it already exists.

## Adding a package

1. Add its SDK manifest and source under this directory.
2. Add an ID/directory entry to `registry.json`, with explicit files and build entries.
3. Add source type-check/lint coverage to the root checks when introducing executable package source. Run the build command in the README and the focused build/catalog/route tests.
4. Check Enable/Disable, retained data, automatic grants, and account placement. A newly requested capability should appear in the server's granted set without an approval dialog.
5. Verify the web tarball includes the registry and built files. Native services also need the unpacked Electron resource path.

## Magic Context panel

`magic-context/` recreates the OpenCode sidebar with the public guest SDK and adds read-only cache and plugin-log diagnostics. The extension does not call Magic Context's private `sidebar-snapshot` RPC, use OpenChamber stores, or invoke the Dashboard's broad `--serve` command API.

The service reads the standard local files used by the `mcdash` alias:

- `~/.local/share/cortexkit/magic-context/context.db`
- `~/.local/share/opencode/opencode.db`
- `${TMPDIR:-/tmp}/opencode/magic-context/magic-context.log`

The service opens SQLite read-only and enables `query_only`. It returns numeric context/cache counts, fixed cache-cause categories, and bounded log-event metadata. It never returns message text, memory contents, raw log lines, or file paths. Log polling reads at most 256 KiB and 100 lines; database queries return at most 50 cache rows.

`node:sqlite` is experimental in Node 22 and may be absent from an older service runtime. The panel shows an unavailable state instead of treating that as empty data. The service does not inherit `MAGIC_CONTEXT_STORAGE_DIR`, `OPENCODE_DB`, or `MAGIC_CONTEXT_LOG_PATH`; installations that override the documented default paths are not discovered automatically.

The panel refreshes parsed log events every five seconds and database snapshots no more often than every 15 seconds while mounted. This is bounded polling, not an OpenCode event stream. The Magic Context sidebar's exact component breakdown and live Historian/Dreamer states come from private plugin RPC and in-memory state; the panel labels those fields unavailable rather than inferring values from history.

Services run on the OpenChamber server. For a local desktop or local web server, that is the machine whose files match the paths above. A browser connected to a remote OpenChamber server reads the remote server's files, not the browser machine's. The mcdash alias can still run the separate Dashboard for comparison; the extension does not start it or depend on its HTTP server.
