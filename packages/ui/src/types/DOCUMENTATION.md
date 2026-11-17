# Shared UI types

## Ownership

This module owns the type contracts the UI shares across surfaces and with the
server: model and provider metadata, quota results, multi-run requests, worktree
metadata, themes, snippets, and the ambient declarations that stand in for
packages without bundled types. Behavior lives where those types are produced or
consumed; this module owns only their shape.

Quota provider ids mirror the providers the server reads in
`packages/web/server/lib/quota/providers`; every other provider the server can
serve arrives as an extension id. Permission types are owned by
`lib/opencode/model`; `permission.ts` only re-exports them for older imports.

## Invariants

### Model metadata

- `structured_output` is tri-state. `undefined` means the catalog says nothing
  about the model, which is common for aggregators and proxies, and callers
  treat it as worth trying. Only `false` means unsupported.

### Multi-run requests

- A group is one prompt variant. Its `files` belong to that variant only (for
  example resolved @mentions); the top-level `files` go with every variant.
- A group's `tokenBudget` applies to each lane separately.
- `name` seeds the group slug, worktree and branch names. `title` is the human
  title in the sidebar and overview and defaults to `name`.
- `autoFusion` fuses the lanes once all of them finish. `goal` gives every lane
  a goal of its own, with the lane's prompt as the objective.

### Quota results

- Built-in provider ids are the ones OpenChamber reads itself. An installed
  extension that provides quota is named `ext-<extension id>` by the server.
- `UsageWindowGiftReset.grantType` is the z.ai grant kind delivered per record
  by the list API. It is sent back unchanged on activation, and an absent value
  makes the runtimes fall back to `GLOBAL`.
- `inputPriceAtLeast` is a USD price per 1M input tokens; the budget counts a
  model once its input price reaches it.
- `consoleBudgets` is OpenCode Go only: the budgets of the same sign-in, shown
  on its usage page.
- `accountLabel` names the sign-in the numbers came from when that is not the
  sign-in OpenChamber chats as.

### Worktree metadata

- `title` comes from the branch description: the agent names it once the task
  is clear and the user can rename it. It is absent until then.
- `pinList` is the user's pin list the pin is filed in
  (`lib/sidebarSections.ts`), and is absent when the worktree sits in Pinned.
- `aheadBase` is the base ref `ahead` was counted against when there is no
  upstream.
- `worktreeRoot` is the canonical root path, equal to `path` for secondary
  worktrees.

### Ambient declarations

- `gesturestart`, `gesturechange` and `gestureend` are WebKit-only pinch events
  on Safari macOS trackpads and iOS WKWebView; `lib.dom` does not declare them.
- `bun-test.d.ts` declares the subset of `bun:test` the UI test files use, plus
  the `bun` module's `gc` and `plugin`, so Bun test runs can load Vite
  asset-query imports through a URL loader.
- `Mock<T>` mirrors bun:test's runtime mock: a callable `T` plus spy methods.
  Tests that swap implementations at runtime cast through it.

## Decisions

### Why `structured_output` is tri-state and not a boolean

The catalog often does not say whether a model supports structured output, so
silence has to mean "worth trying". A boolean would turn that silence into
`false` and hide models that work.

### Why permission types are re-exported instead of defined here

The domain model in `lib/opencode/model` owns them. The re-export keeps the
import path older UI code already uses without creating a second definition.

### Why `bun:test` types are declared by hand instead of installed

The workspace has no `@types/bun` dependency, and the UI test files use only a
small subset of the runtime API. The hand-written declaration keeps `tsc` honest
about that subset without pulling in the full runtime types.

### Why the WebKit gesture events are declared here instead of taken from a DOM library

The events exist only in WebKit, and the TypeScript DOM library does not declare
them. The ambient interfaces let the UI listen for pinch gestures on Safari and
iOS without asserting a type that no library provides.
