# Web package configuration

## Ownership

This package owns the browser build, Vite plugins, development launchers and web test configuration. Browser bootstrap belongs to `src/DOCUMENTATION.md`, server contracts to `server/DOCUMENTATION.md`, and CLI contracts to `bin/lib/DOCUMENTATION.md`.

## Invariants

- `type-check:server` checks all converted server and CLI implementations under
  the separate no-emit strict configuration. JavaScript dependencies supply
  inferred shapes without being checked. A paired handwritten declaration
  must be removed when its implementation becomes TypeScript.
- `lint:server` enforces TypeScript and OpenChamber rules on every converted
  implementation without accepting the JavaScript backlog. Conversion workers
  follow [the server conversion brief](server/DOCUMENTATION.md#converting-a-folder-to-typescript).

- `build:server` emits JavaScript, declarations and inline-source maps into
  `build/{server,bin}`. The UI build owns `dist` and cannot erase server output.
  `build` and `prepack` run the server build; development and tests read sources.
- Local and remote `oc-dev` deployment resolves the installed executable from
  the package's `bin.openchamber`, including when stopping the previous layout.
- Runtime JSON, text and CJS siblings are copied beside their emitted importers,
  including built-in extensions. Tests and test-support files are excluded.
  Paired handwritten declarations remain source-side; the 2 declaration-only
  tracker and source-control contracts are copied for emitted type references.

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

### Why declarations are generated separately from the source contracts

The handwritten `.d.ts` files still type source consumers such as VS Code.
They stay in place and never overwrite inferred declarations in `build`.
`preserveSymlinks` keeps inferred dependency names portable with Bun's isolated
install layout. JavaScript checking stays disabled during the build-only step.

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
