# Built-in extension ownership

## Source and build

- `registry.json` is the app-owned allowlist. IDs use the reserved `openchamber-builtin-` prefix and remain stable across releases.
- Each package uses the ordinary SDK manifest and public SDK APIs. Built-in status does not expose private stores, credentials, or native bridges to its iframe.
- `scripts/build-builtin-extensions.mjs` copies only declared files, bundles declared entries, stamps the app version, and validates the staged output before replacing the previous complete bundle. Browser output is a self-contained IIFE. Node service output is ESM.
- Panel translations live with the package and use `HostReadyContext.locale`. They cannot consume the host React i18n context across the iframe boundary. Keep all 12 host locales covered.
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
