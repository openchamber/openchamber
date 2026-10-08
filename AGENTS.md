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

## Runtime Boundaries

- `packages/ui`: shared React UI, state, sync, and runtime contracts.
- `packages/web`: web surfaces, OpenChamber server, managed/external OpenCode lifecycle, and CLI.
- `packages/electron`: native desktop shell and privileged Electron boundary.
- `packages/vscode`: extension host, webview, and runtime bridge.
- `packages/mobile`: Capacitor iOS/Android shell; bundles the mobile web surface and connects to an existing OpenChamber server.
- `packages/docs`: product documentation; not a Bun workspace.
- `packages/sdk`: guest contract for third-party panels. Manifest parse, iframe envelope, `connectHost`. Host and guest import from here; do not copy these types into `packages/ui`.
- `packages/extensions`: app-owned SDK extensions and their build registry, not a Bun workspace. See its `DOCUMENTATION.md` for trust, packaging, and migration rules.

Shared UI calls official OpenCode APIs through `@opencode/client` (OpenCode 2.x) via `opencodeClient`; wire shapes stay inside `packages/ui/src/lib/opencode/`. OpenChamber-owned capabilities use `RuntimeAPIs`, `runtimeFetch`, and shared browser/realtime transport helpers. Server-side upstream integrations may use their owning runtime modules.

Electron starts the OpenChamber backend in-process, never as a sidecar. Development may load loopback/HMR UI; packaged builds load staged assets through `openchamber-ui://` while the loopback server remains the API backend. Keep domain backends in web/runtime modules unless behavior is inherently native.

Shared contracts must define intentional behavior for every applicable runtime: web, desktop, VS Code, hosted mobile, and Capacitor mobile.

## Always-On Constraints

- Do not modify `../opencode`; it is a separate repository.
- Do not run git or GitHub commands unless the user explicitly asks.
- Do not add dependencies unless explicitly requested.
- Never add or log secrets, bearer tokens, pairing credentials, or sensitive user data.
- Keep changes minimal and preserve unrelated worktree changes.
- `changelog/` is read-only, and a fix, feature, or merged PR lands without a changelog line. Release notes are written only when the maintainer asks to update the changelog, through the `update-changelog` skill.
- Enforce security and correctness in core/runtime logic, not only UI visibility or prompts.
- Keep entrypoints and bridges thin; place domain logic in focused owning modules.
- Update owning documentation when module ownership, contracts, or invariants change.

## Correctness Invariants

- Prefer authoritative state over heuristics.
- Derive live activity from live channels, not persisted history.
- Scope temporary fallbacks narrowly and clear them when authoritative state arrives.
- Never let fetch failure masquerade as authoritative empty success.
- Make partial results, rollback, cleanup, and stale-data behavior explicit.
- One failed entity must not erase or block unrelated complete entities.
- Runtime-specific differences must be intentional and visible in code.

## Communication

You and the person you work with are two people solving a problem together. Talk like a trusted colleague: plain words, short sentences, mechanisms explained through what the user experiences. Warm and direct, never familiar. A reply is read in minutes, so the conclusion comes first and you stand behind it. Answer in the language you were addressed in; code, comments, and docs stay in English.

Load the `communication-style` skill once, at the start of the session, before your first reply. It stays in context for the rest of the session: every reply, in any language, and every text people read follows it. Later turns use it as loaded; they do not load it again.

## Project Skills

Project skills live in `.agents/skills/*/SKILL.md`, and each skill's `description`
says when it applies. If your tool does not list skill descriptions, read them in
those files before you start. Pure code-reading or explanation needs no
implementation skills unless a specialized subsystem has to be interpreted.

## Validation

- Use `package.json` scripts as the command source of truth. Which checks a change needs is in `openchamber-change-discipline`.
- Before every commit of source changes, `bun run check:changed` passes. It runs type-check, lint, and dead code (Knip, kept at zero findings), then an anti-slop ratchet: the vendored `anti-slop` oxlint plugin (low-evidence typing: unjustified type assertions, `unknown`/`object`/`Record<string, unknown>` contracts, ad hoc `typeof` narrowing, module mocking) may report no more findings per rule across the changed files than at the base. Fix the new findings; the pre-existing backlog stays out of scope unless the task is that cleanup. Never silence a rule, weaken severity, or launder types to make a check pass.
- Report exactly what was and was not validated. Static checks alone do not prove runtime, relay, performance, or platform correctness.

## Pull Request Handoff

Before creating or updating a pull request, read `CONTRIBUTING.md` and
`.github/PULL_REQUEST_TEMPLATE.md`. Complete the template with concrete,
current evidence for the final PR HEAD; do not make the reviewer reconstruct
intent, affected surfaces, validation, visual behavior, or failure and
rollback considerations from the diff alone.

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
- **Working as an outside contributor**: the decision happens in an agreed
  [Ideas discussion](https://github.com/openchamber/openchamber/discussions/categories/ideas)
  before the code, linked from the pull request. Without the maintainer's
  go-ahead such a pull request is not reviewed, and a discussion opened
  afterwards to describe finished work is closed along with it.

When the call is unclear, ask before building. Deciding it silently is the one
thing that is always wrong.
