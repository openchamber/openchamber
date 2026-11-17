# Web package configuration

## Ownership

This package owns the browser build, Vite plugins, development launchers and web test configuration. Browser bootstrap belongs to `src/DOCUMENTATION.md`, server contracts to `server/DOCUMENTATION.md`, and CLI contracts to `bin/lib/DOCUMENTATION.md`.

## Invariants

- Theme hot updates publish through the runtime listener and return no Vite modules, which prevents a full-page reload. Invalid or incomplete JSON preserves the last valid theme until a valid save.
- Each development server uses its own dependency cache. Module matching uses the checkout's real path because Vite module ids resolve symlinks.
- The React transform cache key covers module identity, source, Babel setup, relevant resolved Vite settings and compiler dependency versions. Unreadable dependency versions disable caching because an upgrade must invalidate its output.
- Shared cache entries replace only generated checkout-root paths. Modules whose own source names the checkout root bypass caching, and root replacement includes a trailing separator to preserve sibling paths.
- Chunk-module comparisons normalize path separators because Rollup ids use forward slashes on Windows too.
- ASCII rewriting preserves regular-expression semantics, including surrogate pairs and already escaped characters. Tagged-template raw text stays unchanged because a tag can observe the escape itself. Source-map builds bypass rewriting because their maps would also need replacement.
- The custom manifest in `index.html` remains authoritative. The service worker uses a classic bundle for iOS Safari/PWA reliability. The share renderer needs no offline precache because it is read only when a page is shared.
- Test aliases match the application's shared-UI aliases so mock factories can resolve real exports. The `@/` alias is anchored so scoped dependencies remain resolvable.
- Test workers leave capacity for loopback handshakes and Git subprocesses. Git operations need a timeout above Vitest's default because subprocess round trips vary with machine load.
- UI fixtures that import Vite assets execute through Vitest because Bun's raw TypeScript loader cannot load those assets.
- Tests use isolated configuration and loopback binds. Inherited enterprise policy, pinned endpoints and OpenCode skill-discovery switches cannot determine a test's result; cases that need those settings provide them explicitly.
- The development launcher removes names recorded in `OPENCHAMBER_INJECTED_ENV`, including inline replacements, so an app-owned password, desktop runtime or asset path cannot leak into the dev instance. Removing that record from the launch environment preserves inherited values. With the inherited bind removed, the server defaults to loopback; the Vite UI has a separate allowed loopback origin.

## Decisions

### Why locale imports are sliced and not bundled whole

The startup English dictionary imports feature dictionaries that contain every locale. Resolving each dictionary import to its own locale avoids retaining all translations at startup; an unrecognized export shape stays whole so optimization cannot discard required strings.

### Why chunks use selective ASCII rewriting and not universal escaping

Wide characters can double V8's retained source-text storage for a mostly Latin chunk. ASCII rewriting applies only when its escaped output costs less than the two-byte representation; mostly non-Latin dictionaries keep their smaller original representation.

### Why the desktop graph is preloaded and not left to dynamic imports

The packaged entry waits for the local server's runtime configuration before its dynamic app import can run. Protocol-gated preloads fetch that graph during the wait while keeping network clients, including phones, from downloading the desktop app.

### Why React transforms persist on disk and not only in Vite memory

The React Compiler dominates cold development startup, and its output depends on source and compiler configuration. Repository-relative keys and a root placeholder let worktrees reuse that output across restarts without retaining another checkout's paths.

### Why shared pages use a separate bundle and not the app's chunks

The relay viewer executes shared pages without network access. A separate build replaces app-only modules and inlines all chunks and styles into a self-contained renderer; React's mode matches the JSX transform because production React has no `jsxDEV` export.

### Why runtime helpers have their own chunk and not an arbitrary vendor

Every dynamic import needs Vite's preload helper. Co-locating it with a large lazy vendor makes that vendor part of eager bootstrap.

### Why styles stay with their importers and not vendor groups

An eager stylesheet grouped with a lazy engine makes that whole vendor eager. Keeping styles with their importers preserves lazy loading of the KaTeX engine.

### Why vendor identity uses the last package segment and not the first

Bun's isolated install nests the real package below `.bun/.../node_modules/`. Reading the first segment groups all dependencies together and pulls lazy dependencies into one eager chunk.

### Why language and diff modules split by usage and not package

Shiki languages and themes, CodeMirror legacy modes and highlight themes load individually, so package-wide chunks download unused registries. The eager diff parser also stays separate from the lazy highlighting renderer to preserve its small import graph.

### Why diagnostic output lives outside the package and not beside production assets

Electron copies this package into its ASAR, so diagnostic assets inside it enlarge the shipped app. Diagnostic builds identify work through maps and probes; production builds supply timing measurements, and an unmatched store transform fails the diagnostic build so notification counts cannot silently read zero.
