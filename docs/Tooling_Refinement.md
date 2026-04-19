# Tooling Refinement

This document tracks the tooling-focused build and validation work needed to keep Phase 1 iteration fast and predictable.

It should be updated alongside each tooling change and each related changelog entry.

## Goals

- Remove repeated TypeScript work across `ui`, `web`, and `vscode`.
- Make warm validation runs fast enough to use continuously while iterating.
- Add a supported fast-build path for local work that skips the React compiler.
- Keep release validation strict while improving day-to-day tooling ergonomics.

## Baseline

Measured before the refinement pass:

- `packages/ui` type-check: about `50s`
- `packages/web` type-check: about `50s`
- `packages/vscode` type-check: about `49s`
- `packages/web` build: about `113s`
- `packages/vscode` webview build: about `109s`

Primary causes:

- `packages/web/tsconfig.json` and `packages/vscode/tsconfig.webview.json` both pulled `../ui/src` into their own type-check programs.
- Root `type-check` re-ran full-program checks instead of using project references and incremental caches.
- `@openchamber/ui` had no reusable declaration build output, so consumers had to type-check its source repeatedly.
- Local Vite builds always ran the React compiler, even when a faster edit/verify loop was preferable.

## Implemented

### 1. Project-reference type-check pipeline

Status: completed

Changes:

- Added root build-mode TypeScript graph in `tsconfig.typecheck.json`.
- Added `packages/ui/tsconfig.build.json` to emit reusable declarations into `packages/ui/dist/types`.
- Added `packages/web/tsconfig.typecheck.json`.
- Added `packages/vscode/tsconfig.extension.typecheck.json`.
- Added `packages/vscode/tsconfig.webview.typecheck.json`.
- Switched root and package `type-check` scripts to `tsc --build`.

Result:

- Warm `bun run type-check`: about `2.95s`
- Warm `packages/web` type-check: about `2.61s`
- Warm `packages/vscode` type-check: about `2.60s`

### 2. Reusable UI declaration output

Status: completed

Changes:

- `packages/ui` now produces declaration output in `dist/types`.
- Consumer type-check configs resolve `@openchamber/ui/lib/*` and related runtime entrypoints from the emitted declaration output instead of `../ui/src`.
- Added lightweight declaration shims for UI CSS/fonts entrypoints used by app shells during type-checking.

Result:

- `ui` is checked once in the reference graph instead of once per consumer.

### 3. Real local fast-build mode

Status: completed

Changes:

- Added `OPENCHAMBER_DISABLE_REACT_COMPILER` gate to:
  - `packages/web/vite.config.ts`
  - `packages/vscode/vite.config.ts`
- Added fast scripts:
  - root: `build:fast`, `dev:web:fast`
  - web: `build:fast`, `build:watch:fast`
  - vscode: `build:fast`, `build:webview:fast`

Measured result:

- `packages/web build:fast`: about `63s`
- `packages/vscode build:webview:fast`: about `67s`

Compared to the earlier baseline, this cuts local web build time by roughly 40-45%.

### 4. Serialize heavyweight root builds

Status: completed

Changes:

- Replaced the root `build` orchestration that fanned out workspace builds concurrently.
- Replaced the root `build:fast` orchestration with the same serialized package order.
- Root builds now run in this order:
  - `packages/ui`
  - `packages/web`
  - `packages/vscode`
  - `packages/desktop`

Result:

- Prevents concurrent Vite builds from exhausting Bun/JavaScriptCore heap during strict root builds.
- `bun run build` now completes successfully again.
- `bun run build:fast` also completes successfully.

### 5. Remove fake UI build work

Status: completed

Changes:

- `packages/ui build` no longer aliases another no-op type-check.
- `packages/ui build` and `packages/ui type-check` now run the same declaration-producing build graph used by the reference pipeline.

## Remaining Heavy Areas

These are real build-size issues, not missed tooling wiring:

- Shared UI is still bundled separately by the web app and VS Code webview.
- Large frontend bundles remain in the critical path.

These should be treated as product/bundle-graph optimizations rather than basic tooling fixes.

## Additional Bundle-Graph Refinements

### 6. Lazy-load Prism grammars

Status: completed

Changes:

- Replaced eager Prism component imports in `packages/ui/src/components/chat/message/parts/VirtualizedCodeBlock.tsx`.
- Added `packages/ui/src/components/chat/message/parts/prismLanguageLoader.ts` to load Prism grammars on demand.
- Only the grammar needed for the active code block is now fetched and registered.

Result:

- `packages/web build:fast` dropped from about `63s` to about `56s`.
- Web fast-build transformed modules dropped from about `3264` to about `3165`.
- Prism grammars now emit as small split chunks instead of inflating the main graph.

### 7. Narrow CodeMirror language loading

Status: completed

Changes:

- Rebuilt `packages/ui/src/lib/codemirror/languageByExtension.ts` around extension-specific async loaders.
- Removed eager imports of `@codemirror/lang-*`, `@codemirror/language-data`, and legacy modes from the initial module graph.
- Added `packages/ui/src/lib/codemirror/markdownCodeLanguages.ts` as a minimal markdown code-language resolver module.
- Updated `PlanView` to use the same async language-extension loading path already used by `FilesView`.

Result:

- Rare editor grammars now load only when a matching file is opened.
- The initial app graph no longer pays the cost for the full CodeMirror language set up front.

## Follow-Up Candidates

Status: pending

- Deferred by request for the current cross-platform refactor push. Do not pursue these until the Windows compatibility phases are further along.
- Revisit large vendor chunking in the web and VS Code Vite configs after the current Phase 1 work settles.
- Consider adding task-level cache tooling such as Turborepo or Nx if build frequency keeps rising.

## Verification

Current expected commands:

- `bun run type-check`
- `bun run lint`
- `bun run build`
- Optional local fast path: `bun run build:fast`

Current status:

- `bun run type-check` passes
- `bun run lint` passes with the existing 14 VS Code platform warnings
- `bun run build:fast` passes after the Prism and CodeMirror lazy-loading changes
- `bun run build` passes

## Change Log Sync

When this file changes, add or update a matching `CHANGELOG.md` entry under `Unreleased` summarizing the user-visible tooling impact.
