# OpenChamber Agent Guide

## Purpose

OpenChamber provides shared web, desktop, VS Code, hosted-mobile, and native-mobile UI surfaces for OpenCode.

This file contains only always-on repository rules and routing. Detailed workflows belong to project skills and module documentation.

## Instruction Order

These steps are mandatory. Before editing, you **MUST**:

1. Follow this root guide.
2. Load every project skill whose `description` matches the change, and every
   reference those skills require. Any source change starts with
   `openchamber-change-discipline`.
3. Read the nearest `DOCUMENTATION.md` (under `packages/**`) for each module you
   change, and the package `README.md` for package-level work.
4. Follow local code and test precedent.

If these sources materially conflict, stop and resolve the conflict instead of silently choosing one.
Do not start editing before every matching skill and required reference is read.

## Working a Change

Every fix and feature goes through these steps, in order. What counts as proof, and where to run each kind of change, is in `openchamber-change-discipline` (*Proof*, *Where to run it*).

1. **Reproduce.** Make the failure happen the way a user hits it, in the runtime that runs the code; for a feature, see what that runtime does today where the feature goes. Unreproduced goes to the report with what you tried before any fix.
2. **Fix the cause.** The smallest change that removes it. A correctness problem you trip over in code you touch is fixed in the same change; one elsewhere goes to the report or its own pull request.
3. **Prove it.** Run the same reproduction and watch it pass. Report what the proof covered and what it did not.
4. **Second look.** The `review` agent on the diff (`.opencode/agent/review.md`), or a reviewer on another model where your tool has no such agent; one-line and text-only edits go without. Answer findings per `openchamber-change-discipline` (*Answering Review Findings*).
5. **Hand off.** The working tree for the person you work with, or a pull request (*Pull Request Handoff*).

## Runtime Boundaries

- `packages/ui`: shared React UI, state, sync, and runtime contracts.
- `packages/web`: web surfaces, OpenChamber server, managed/external OpenCode lifecycle, and CLI.
- `packages/electron`: native desktop shell and privileged Electron boundary.
- `packages/vscode`: extension host, webview, and runtime bridge.
- `packages/mobile`: Capacitor iOS/Android shell; bundles the mobile web surface and connects to an existing OpenChamber server.
- `packages/docs`: product documentation; not a Bun workspace.
- `packages/sdk`: guest contract for third-party panels. Manifest parse, iframe envelope, `connectHost`. Host and guest import from here; do not copy these types into `packages/ui`.
- `packages/extensions`: app-owned SDK extensions and their build registry, not a Bun workspace. See its `DOCUMENTATION.md` for trust, packaging, and migration rules.

Shared UI data access and OpenCode calls: `ui-api-decoupling`.

Shared contracts must define intentional behavior for every applicable runtime: web, desktop, VS Code, hosted mobile, and Capacitor mobile.

## Always-On Constraints

- Do not modify `../opencode`; it is a separate repository.
- Do not run git or GitHub commands unless the user explicitly asks.
- Do not add dependencies unless explicitly requested.
- Never add or log secrets, bearer tokens, pairing credentials, or sensitive user data.
- Launch Google Chrome for automation with `--disable-features=MacAppCodeSignClone` (`scripts/perf/cdp.mjs` does). Without it each launch on macOS copies the 1.4 GB app into `$TMPDIR`, and a killed browser leaves the copy.
- Preserve unrelated worktree changes.
- Several agent sessions often work in the same checkout at once. Never `git stash` to compare against a clean tree or to test something: a stash takes every session's uncommitted work, and a session writing to a stashed file meanwhile makes the pop fail. Compare in a detached worktree instead (`git worktree add --detach /tmp/<name> HEAD`, with `node_modules` symlinked).
- `changelog/` is read-only, and a fix, feature, or merged PR lands without a changelog line. Release notes are written only when the maintainer asks to update the changelog, through the `update-changelog` skill.
- Enforce security and correctness in core/runtime logic, not only UI visibility or prompts.

## Correctness Invariants

- Prefer authoritative state over heuristics.
- Derive live activity from live channels, not persisted history.
- Scope temporary fallbacks narrowly and clear them when authoritative state arrives.
- Never let fetch failure masquerade as authoritative empty success.
- Make partial results, rollback, cleanup, and stale-data behavior explicit.
- One failed entity must not erase or block unrelated complete entities.

## Communication

Answer in the language you were addressed in; code, comments, and docs stay in English.

Load the `communication-style` skill once, at the start of the session, before your first reply. It stays in context for the rest of the session: every reply, in any language, and every text people read follows it. Later turns use it as loaded; they do not load it again.

## Project Skills

Project skills live in `.agents/skills/*/SKILL.md`, and each skill's `description`
says when it applies. If your tool does not list skill descriptions, read them in
those files before you start. Pure code-reading or explanation needs no
implementation skills unless a specialized subsystem has to be interpreted.

## Validation

- Use `package.json` scripts as the command source of truth. Which checks a change needs is in `openchamber-change-discipline`.
- Before every commit of source changes, `bun run check:changed` passes (`scripts/check-changed.mjs` says what it runs). Fix the new findings; the pre-existing backlog stays out of scope unless the task is that cleanup. Never silence a rule, weaken severity, or launder types to make a check pass.

## Fork and upstream

This checkout is a personal fork: `upstream` is the source repository, `fork`
(github.com/Meiuxs/openchamber) is where work is published. Feature branches push to
`fork`; `upstream` stays read-only. Work meant for the source repository follows
*Pull Request Handoff* below; fork-only work needs no upstream issue or pull request.

To fold an upstream update in: `git fetch upstream`, `git merge upstream/main`, resolve
conflicts, run `bun run check:changed`, then push the branch to `fork`. Merge rather
than rebase: the fork carries long-lived customizations (the intranet policy features,
for example), and one merge per upstream update resolves those conflicts once. Keep
customizations small and layered so future merges stay cheap.

## Pull Request Handoff

Before creating or updating a pull request, read `CONTRIBUTING.md` (*Pull Requests*) and fill `.github/PULL_REQUEST_TEMPLATE.md` with evidence for the final HEAD.

A **product decision** belongs to the maintainer and is settled before the code,
never inside the diff. A product decision is anything where two reasonable people
could disagree about whether it should exist or how it should behave: a new
button, panel, setting or command; a changed default; a shortcut or gesture that
now does something else; different wording, ordering or grouping in the UI;
anything that turns existing behavior on or off for everyone. Removing or
bypassing behavior the code marks as deliberate is one too, and there the first
question is whether it is a defect at all. A crash, wrong data, behavior that
contradicts what it plainly claims, or a performance fix that keeps behavior
identical is a bug, not a product decision.

Where that decision is settled depends on who is working:

- **Working with the maintainer or a team member** (anyone with repository
  access): raise the product question in the session and get an answer there.
  The decision already happened off GitHub; no discussion thread and no link is
  expected on the pull request.
- **Working as an outside contributor**: open a feature request and build only after the maintainer marks it `accepted`, as `CONTRIBUTING.md` (*Before you start*) describes; the pull request links it with `Fixes #N` or `Part of #N`. A pull request without that link is closed automatically.

When the call is unclear, ask before building. Deciding it silently is the one
thing that is always wrong.
