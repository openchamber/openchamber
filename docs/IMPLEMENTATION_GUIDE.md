# Implementation Guide — OpenChamber Teams

**Audience:** autonomous coding agents (e.g. Kimi 2.6 in a ralph-style loop)
and humans pairing with them. Read this before touching code.

This guide defines the cross-cutting rules that apply to *every* feature in
every mode. Per-mode docs (`MODE_1_*`, `MODE_2_*`, `MODE_3_*`) only add
mode-specific details on top.

---

## 1. Reading order

Read in this exact sequence before writing any code:

1. `AGENTS.md` (repo root) — the upstream coding standards. They apply fully.
   Non-negotiables you must respect:
   - Zustand referential-equality rules.
   - Shared-store render discipline.
   - Cross-runtime parity (web / electron / vscode).
   - Toast via `@/components/ui` wrapper, never `sonner` directly.
2. `docs/TEAMS_OVERVIEW.md` — what we're building and why.
3. `docs/IMPLEMENTATION_GUIDE.md` — this file.
4. The relevant mode doc (`MODE_1_INDIVIDUAL.md` for current work).
5. `packages/web/server/lib/github/DOCUMENTATION.md` — existing GitHub
   integration surface; you will reuse most of it.
6. The file(s) you intend to change. Read fully, not sampled.

---

## 2. How to pick the next task

```
repeat:
  1. Open the current mode doc.
  2. Find the first feature whose Status is `planned` and whose
     "Dependencies" (order hint in the doc) are satisfied.
  3. Run the "Stuck checks" for that feature. If any fail, log to
     docs/BLOCKERS.md and try the next feature.
  4. Apply the "Commit plan" commit-by-commit.
  5. Run the verification gates after each commit (not only at the end).
  6. Flip Status to `shipped (commit: <short-sha>)` in the mode doc.
until all features are shipped or all remaining are blocked.
```

Never invent a new feature. If a user request arrives mid-run that doesn't
map to an existing doc entry, stop and surface it as a question.

---

## 3. Verification gates (mandatory)

After every logical commit, every one of these must exit 0:

```bash
bun run type-check
bun run lint
bun run build
```

Additionally, when a feature's commit plan includes a test file:

```bash
bun test
```

Do not bundle multiple features behind one verification pass. A commit that
breaks the gate is not allowed to land. If a failure is in code you did not
touch in this branch, treat it as a pre-existing blocker, log it, and stop.

---

## 4. Commit policy

- **Small, scoped commits.** One feature = 1–4 commits as laid out in its
  mode-doc "Commit plan". Never mix two features in one commit.
- **Subject format:**
  `<type>(teams/mode<N>/<feature-slug>): <short description>`
  - Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`.
  - Example: `feat(teams/mode1/issue-to-work): add branch-naming helper`
- **Body:** one paragraph explaining *why*, not *what*. Link the mode-doc
  section if relevant.
- **Never:** force-push, amend after push, skip hooks, commit secrets,
  commit `.env` files, commit failing code.
- **Git config:** don't touch it. Author identity is the developer's.

---

## 5. Dependency policy

- **No new runtime dependencies** unless a feature fundamentally cannot be
  built without one. "Fundamentally" means: the functionality requires a
  widely-adopted protocol (Yjs for CRDT in Mode 3, for example), not
  "would be nicer with X".
- **If you need a new dep, stop and log to `BLOCKERS.md`.** Do not `bun add`
  on your own. Humans approve deps.
- **Already-allowed deps** are everything in `package.json` right now plus:
  - Mode 2 may add: nothing (GitHub App uses existing Octokit).
  - Mode 3 may add: `yjs`, `y-websocket` (only when Mode 3 starts).

---

## 6. File placement conventions

| Kind | Path pattern |
| --- | --- |
| Server route (Express) | extend `packages/web/server/lib/github/routes.js` or add a new file in the same dir |
| Server pure module | `packages/web/server/lib/github/<module>.js` |
| Server pure module test | `packages/web/server/lib/github/__tests__/<module>.test.js` |
| Client API wrapper | extend `packages/web/src/api/github.ts` |
| UI feature | `packages/ui/src/features/<feature>/` with `index.tsx`, `hooks.ts`, `api.ts` |
| Narrow zustand store | `packages/ui/src/stores/<feature>/index.ts` |
| Cross-runtime contract | document any new route in its mode doc AND here if shared |

Do NOT:
- Add new folders under `packages/web/server/` without a matching module
  `DOCUMENTATION.md`.
- Invent a parallel `packages/ui/src/components/teams/` tree. Use the
  existing `features/` convention.
- Add routes to `packages/web/server/index.js` directly. Register from a
  lib module.

---

## 7. State and performance rules (summary — full rules in `AGENTS.md`)

- **Never put streaming or 60/sec state in broad shared stores.**
- **Select leaf values, not containers,** in zustand selectors.
- **Preserve references** for untouched branches when updating state.
- **Don't poll without a TTL.** Every background fetcher has a visible,
  documented interval and a "hidden tab → pause" rule.
- **New UI state default lives in a narrow feature store,** not in a
  catch-all.
- **Any high-frequency data consumer** (check runs, streaming session
  output) is wrapped in `React.memo` so it doesn't re-render the parent.

Violating these causes the kind of regressions the upstream repo spent
months fixing. Don't reintroduce them.

---

## 8. Error shape (server ↔ client)

All new `/api/github/*` endpoints return:

**Success:**

```json
{ "ok": true, "data": { ... } }
```

**Error:**

```json
{ "ok": false, "error": { "code": "string_tag", "message": "human readable" } }
```

Common `code` values:
- `not_authenticated` — no GitHub auth configured (HTTP 401)
- `not_found` — repo, branch, issue, PR not found (HTTP 404)
- `forbidden` — scope or permission insufficient (HTTP 403)
- `rate_limited` — GitHub returned 429 or we detected low remaining quota
  (HTTP 429)
- `conflict` — branch already exists, etc. (HTTP 409)
- `upstream_error` — GitHub returned 5xx (HTTP 502)
- `bad_input` — invalid request body (HTTP 400)
- `internal` — true server bug, not a modeled failure (HTTP 500)

Existing routes may not follow this shape yet. **Do not retrofit them** in
the same PR as a new feature. If you need uniformity later, do it in a
dedicated `chore(teams): unify github error shape` PR after mode features
have shipped.

---

## 9. Tests

- **Pure modules must have unit tests.** Examples: `branch-naming.js`,
  `issue-brief.js`, `log-excerpt.js`. Tests live in `__tests__/` alongside.
- **Route handlers:** no integration-test infra is required by the repo;
  ship them without a test file unless the upstream repo already tests
  similar routes (check first).
- **UI features:** no snapshot tests. Manual verification + running the
  dev server counts as sufficient.
- **What not to do:** don't introduce Vitest, Jest, or any new test harness.
  Use `bun test` which is already available.

---

## 10. Stuck protocol

When a "Stuck check" fails or a default doesn't fit:

1. Stop working on the current feature.
2. Append to `docs/BLOCKERS.md`:
   ```
   ## <YYYY-MM-DD> · mode<N>/<feature-slug>
   - What I was trying to do: …
   - Where I got stuck: <file:line or "design-level">
   - What I tried: …
   - Minimum info needed to unblock: …
   ```
3. Move on to the next feature whose Stuck checks pass.
4. Do **not** commit partial code for the blocked feature. If you already
   created a branch, delete it locally.

Never "guess and ship". A silent default that turns out wrong is worse than
a clear block.

---

## 11. Cross-runtime parity

Every new route is accessed from at least the web UI. Before declaring a
feature shipped, check whether:

- **Electron** — automatically inherits the web UI; no extra work unless the
  feature uses native dialogs. If it does, surface the decision in the
  mode doc's "Open questions".
- **VS Code webview** — has its own render path. If the feature is a
  panel/view that the VS Code extension should surface, wire it in
  `packages/vscode/src/` and `packages/vscode/webview/`. If you're not
  sure whether it should surface there, leave a note in the mode doc and
  don't wire it — a human will decide.

Never ship a feature that assumes "only the browser runtime exists".

---

## 12. Don't-touch list

- `../opencode` (separate repo). Never clone, never patch.
- `packages/web/server/lib/github/auth.js` — current token handling works;
  any change requires a human.
- Git config. Never edit.
- `bun.lock` — only changes via `bun install` after approved dep changes.
- Upstream-originated `.github/workflows/*` — leave CI config alone in
  feature PRs; touch only in dedicated `chore(ci)` commits.

---

## 13. When to ask a human

- A mode doc has no "default" for a decision you need, AND logging a blocker
  would halt more than one feature.
- You believe the documented design is wrong (don't silently fix it — ask).
- You would need to add a new dependency.
- Two features have an unresolvable order conflict that the mode doc
  doesn't cover.
- GitHub returns unexpected shapes that aren't documented failure modes.

Keep these questions in one batch whenever possible. The user is not your
live pair; they're your periodic reviewer.
