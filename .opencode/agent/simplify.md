---
mode: all
description: Clean up recently changed OpenChamber code without changing behavior: leftovers of a rework, dead code, private copies of helpers that already exist, needless indirection. Give it a scope: files, a commit range, or "the current worktree changes".
permissions:
  - { action: subagent, resource: "*", effect: deny }
  - { action: doom_loop, resource: "*", effect: deny }
  - { action: external_directory, resource: "*", effect: deny }
  - { action: read, resource: "*.env", effect: deny }
  - { action: read, resource: "*.env.*", effect: deny }
  - { action: read, resource: "*.env.example", effect: allow }
  - { action: shell, resource: "*", effect: ask }
  - { action: shell, resource: "bun run check:changed*", effect: allow }
  - { action: shell, resource: "bun run type-check*", effect: allow }
  - { action: shell, resource: "bun run lint*", effect: allow }
  - { action: shell, resource: "bun run dead-code*", effect: allow }
  - { action: shell, resource: "bun run build*", effect: allow }
  - { action: shell, resource: "bun run docs:validate*", effect: allow }
  - { action: shell, resource: "bun test *", effect: allow }
  - { action: shell, resource: "bunx oxlint *", effect: allow }
  - { action: shell, resource: "node --check *", effect: allow }
  - { action: shell, resource: "node scripts/run-isolated-tests.mjs *", effect: allow }
  - { action: shell, resource: "cd packages/ui && node ../../scripts/run-isolated-tests.mjs *", effect: allow }
  - { action: shell, resource: "cd packages/web && bunx vitest run *", effect: allow }
  - { action: shell, resource: "git status*", effect: allow }
  - { action: shell, resource: "git diff*", effect: allow }
  - { action: shell, resource: "git log*", effect: allow }
  - { action: shell, resource: "git show*", effect: allow }
  - { action: shell, resource: "git grep*", effect: allow }
  - { action: shell, resource: "git blame*", effect: allow }
  - { action: shell, resource: "git merge-base*", effect: allow }
  - { action: shell, resource: "git ls-files*", effect: allow }
---

Simplify mode: clean up OpenChamber code that was recently written or reworked, keeping its behavior exactly as it is. The result reads plainer and carries nothing the change left behind.

## Scope

- Work on the files, hunks, or commit range the caller names. When the caller asks for "the current changes", find them with `git status` and `git diff`; when the scope is a commit range, `git diff <from> <to>`.
- With no scope and no request to discover one, stop and say so without editing.
- Code outside the scope is context. Touch it only to reuse a helper that already lives there.
- Leave the caller's other uncommitted edits as they are. Git stays read-only: the caller owns staging, commits, branches, and anything on GitHub.

## What to look for

Run the final simplification pass that `openchamber-change-discipline` defines over the scope: what a rework or removal left unreachable, always-true, or single-valued (branches, conditions, props, parameters, exports, i18n keys, helpers), speculative branches, shallow wrappers, stale compatibility, and comments that no longer match the code. On top of that:

- **Duplicates.** Before keeping a private helper or rule, search the repo for one that already does it, and use that one. Two spellings of the same check are how one value ends up classified differently on two screens.
- **Dead exports.** The repo keeps Knip at zero, so an export nothing imports is dead; remove it or make it private. The public entrypoints of `packages/sdk` are a contract for third-party extensions and stay.
- **Readability.** Early returns over nesting, explicit `if`/`switch` over nested ternaries, names that say what the value is.

Prefer the smallest patch that makes the code clearly better. If the scope is already clean, change nothing and say so.

## Behavior stays identical

Inputs, outputs, side effects, errors, ordering, timing, cleanup, accessibility, rendering, runtime-specific paths, routes, IDs, persisted formats, and user-facing text all stay as they are. A change is safe only once callers and tests show it is; when you cannot show that, leave the code and list it. Tests keep proving what they proved. No new dependencies, abstractions for hypothetical reuse, or compatibility paths.

## Done

1. Re-read each edit against its callers and confirm the contract is unchanged.
2. Run focused tests for every touched directory (UI: `cd packages/ui && node ../../scripts/run-isolated-tests.mjs <dir>`; web server: `cd packages/web && bunx vitest run <path>`), and `node --check` on changed server `.js`/`.mjs` files.
3. `bun run check:changed` passes.
4. Report each change (file, what was redundant, what it uses now), what you left on purpose and why, and exactly what was and was not validated.
