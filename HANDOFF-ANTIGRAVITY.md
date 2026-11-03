# Handoff: Antigravity CLI delegation

Branch: `feat/antigravity-delegation`
Fork: `https://github.com/nicholaicascio/openchamber` (remote `fork`)
Base: `6cd8058d5` on `openchamber/openchamber` `main`

This branch adds an Antigravity CLI entry under Settings → Providers. It is delegation only: an `agy` tool and an `/agy` command, no Antigravity model in the picker. Read these first:

- `packages/web/server/lib/antigravity/DOCUMENTATION.md`
- `packages/ui/src/components/sections/DOCUMENTATION.md` (Providers)
- `packages/web/server/lib/opencode/DOCUMENTATION.md` (managed plugins)

## Current state

Implemented and verified on Windows 11 with Node 22.23.3, Bun 1.4.2, OpenCode 2.2.5 and agy 1.4.12:

- `bunx tsc -b packages/ui/tsconfig.build.json packages/web/tsconfig.json`: pass.
- `bun run lint`: pass (one pre-existing react-hooks warning).
- `bun run --cwd packages/web build`: pass.
- `bun run --cwd packages/vscode build`: pass.
- `bun run --cwd packages/mobile build:assets`: pass.
- `bun run docs:validate`: pass, 720 pages.
- Focused web suites (`server/lib/antigravity`, `enterprise-mode`, `managed-config-file`, `settings-runtime`): 181 passed, 1 skipped.
- Focused UI suites (`registry.test.ts`, `i18n/messages.test.ts`, `sections/providers`, `lib/antigravity.test.ts`): 141 passed.
- Live run: status, enable, model selection, a permission denial, and a successful delegated file write.

Not verified:

- The full web suite on Linux. On Windows it reports 69 failed files; none relates to this change. The failures are platform classes: `/bin/sh` missing, file modes, pnpm, network, process signals. Re-run on Ubuntu before judging.
- Desktop shell, VS Code (the card is hidden there by design), hosted mobile and Capacitor.
- The pinned `bun run type-check` command: Bun 1.4.2 has no `bun check`, so `tsc -b` was used instead. `bun run check:changed` could not run for the same reason.

## First steps on Ubuntu

```bash
git remote add fork https://github.com/nicholaicascio/openchamber.git   # if not present
git fetch fork
git switch --track fork/feat/antigravity-delegation
bun --version    # must be 1.4.4
node --version   # must be >= 24.14
bun install --frozen-lockfile
bun run settings-registry:generate   # must produce no diff
bun run check:changed                # the pre-commit gate
bun run type-check
bun run lint
bun run test
bun run build
bun run docs:validate
```

If a command fails, fix it in place and keep commits focused. Check whether a failure already exists on `origin/main` before changing unrelated code.

## Live run on Ubuntu

The screenshots below are from Windows. A fresh Ubuntu run needs the Antigravity CLI:

```bash
# Install agy: https://antigravity.google/docs/getting-started/
agy models   # proves the CLI is installed and signed in
bun run dev
```

Then open Settings → Providers → Antigravity CLI, enable delegation, pick a model, and in a session ask the agent to call `agy` (or use `/agy`). A delegated write may be denied by the CLI's headless permission rules; enable "Run commands without asking" to prove the success path, then turn it off.

For a disposable session, avoid writing into a project you care about. Delete the test file and the session afterwards.

## Evidence

Gist: https://gist.github.com/nicholaicascio/c1503c0c6938c442600b5b6288a94e7b

![Providers grid before](https://gist.githubusercontent.com/nicholaicascio/c1503c0c6938c442600b5b6288a94e7b/raw/6c970ba6b001a44375e2cf669f36d747f9d4c786/antigravity-before-2026-11-03T18-53-39-134.jpg)
![Providers grid after](https://gist.githubusercontent.com/nicholaicascio/c1503c0c6938c442600b5b6288a94e7b/raw/6c970ba6b001a44375e2cf669f36d747f9d4c786/antigravity-grid-2026-11-03T18-51-22-989.jpg)
![Page not enabled](https://gist.githubusercontent.com/nicholaicascio/c1503c0c6938c442600b5b6288a94e7b/raw/6c970ba6b001a44375e2cf669f36d747f9d4c786/antigravity-page-2026-11-03T18-43-09-470.jpg)
![Page enabled](https://gist.githubusercontent.com/nicholaicascio/c1503c0c6938c442600b5b6288a94e7b/raw/6c970ba6b001a44375e2cf669f36d747f9d4c786/antigravity-live-page-2026-11-03T18-46-30-116.jpg)
![Permission denied in chat](https://gist.githubusercontent.com/nicholaicascio/c1503c0c6938c442600b5b6288a94e7b/raw/6c970ba6b001a44375e2cf669f36d747f9d4c786/antigravity-live-chat-2026-11-03T18-50-31-035.jpg)
![Successful tool result](https://gist.githubusercontent.com/nicholaicascio/c1503c0c6938c442600b5b6288a94e7b/raw/6c970ba6b001a44375e2cf669f36d747f9d4c786/antigravity-live-result-2026-11-03T18-51-04-000.jpg)
![Mobile page](https://gist.githubusercontent.com/nicholaicascio/c1503c0c6938c442600b5b6288a94e7b/raw/6c970ba6b001a44375e2cf669f36d747f9d4c786/antigravity-mobile-2026-11-03T18-52-00-473.jpg)

## Review focus

- Enterprise mode: no plugin materialization, no CLI process for status, and every run refused.
- Callback auth: per-child token, same-machine check, `NO_PROXY` exemption inside the child.
- Error details: model and conversation ids token-validated; `stderr` redacted.
- External OpenCode: reported as unmanaged, with the switch disabled.
- Skill registration: a skill failure must never disable the tool.
- Translation catalogs: 15 UI locales, 11 docs locales.

## Before the pull request

1. Fill `Fixes #` in the PR body with the accepted feature request.
2. Remove this file from the branch. It is the tip commit, so after confirming the tree is clean: `git reset --hard HEAD~1`. Or `git rm HANDOFF-ANTIGRAVITY.md && git commit`.
3. Use the description below as the PR body.
4. Say plainly what was and was not run on Ubuntu.

## PR body

````markdown
## What and why

Antigravity's CLI (`agy`) gives a Google AI Plus, Pro or Ultra subscription a coding agent, but OpenChamber had no way to reach it. People could run it in a terminal beside the app or install a third-party OpenCode plugin.

Settings → Providers now has an Antigravity CLI entry. It finds the CLI on the machine that runs OpenCode, lists the models the account may use, and stores a default model. When enabled, it adds an `agy` tool and an `/agy` command, so the main model hands over a scoped task, receives the result as a tool result, and reviews the files that changed. Antigravity never appears in the model picker. A skill ships with the tool so the model knows when delegating is worth the handoff.

Antigravity works with its own tools and permissions. Headless mode cannot ask for approval, so a tool that needs it is denied and the result names the rule. "Run commands without asking" is off by default and always pairs auto-approval with the CLI's terminal sandbox. The status route does not start the CLI in enterprise mode, the run route refuses every call there, and the plugin is not materialized.

The design started from chigarow/antigravity-for-opencode (MIT): the tool and command shape, failures returned as text, and timeout handling. It changes where OpenChamber already has infrastructure. The CLI runs beside the OpenChamber server, so web, desktop and mobile clients share one implementation; the session directory is resolved on the server; the model list comes from the CLI instead of a fixed tier table; and a connection to an external OpenCode server reports itself and disables the feature.

Fixes #

## Affected surfaces

| Runtime | Behavior after this change |
|---|---|
| Web | New Providers card and page. The CLI runs on the server; enabling rewrites the managed OpenCode config, so the tool appears without a restart. |
| Desktop (Electron) | Same UI and the same in-process server. No shell change. |
| VS Code | Not supported. The extension host runs no OpenChamber server, so the card is hidden. |
| Hosted mobile | Same server and page through the host. The CLI and the session directory live on the host. |
| Capacitor mobile | Same as hosted mobile. The app connects to a host that runs the CLI. |

## Validation

| Check | Result |
|---|---|
| `bun run type-check` | PASS_OR_FAIL_ON_UBUNTU |
| `bun run lint` | PASS_OR_FAIL_ON_UBUNTU |
| `bun run test` | PASS_OR_FAIL_ON_UBUNTU |
| `bun run build` | PASS_OR_FAIL_ON_UBUNTU |
| `bun run docs:validate` | PASS_OR_FAIL_ON_UBUNTU |
| `bun run check:changed` | PASS_OR_FAIL_ON_UBUNTU |
| Live run on Ubuntu | DESCRIBE_OR_STATE_NOT_RUN |

**Live run:** On Windows 11 with Bun 1.4.2 and OpenCode 2.2.5: opened Settings → Providers in the running app, found the Antigravity CLI card, saw version 1.4.12 with six models, enabled delegation and chose Gemini 3.8 Flash Medium. Delegated a file write in a real session. The first call was denied by the CLI's headless permission rules and the tool reported `AGY_ERROR [PERMISSION_DENIED]`. After turning on "Run commands without asking", the retry created `.openchamber/antigravity-live.txt` with the expected content, and the result appeared in the chat. The test session and file were removed afterwards, and delegation was switched off. Desktop, VS Code, hosted mobile and Capacitor were not separately run.

## Visual evidence

![Providers grid before](https://gist.githubusercontent.com/nicholaicascio/c1503c0c6938c442600b5b6288a94e7b/raw/6c970ba6b001a44375e2cf669f36d747f9d4c786/antigravity-before-2026-11-03T18-53-39-134.jpg)
![Providers grid after](https://gist.githubusercontent.com/nicholaicascio/c1503c0c6938c442600b5b6288a94e7b/raw/6c970ba6b001a44375e2cf669f36d747f9d4c786/antigravity-grid-2026-11-03T18-51-22-989.jpg)
![Page not enabled](https://gist.githubusercontent.com/nicholaicascio/c1503c0c6938c442600b5b6288a94e7b/raw/6c970ba6b001a44375e2cf669f36d747f9d4c786/antigravity-page-2026-11-03T18-43-09-470.jpg)
![Page enabled](https://gist.githubusercontent.com/nicholaicascio/c1503c0c6938c442600b5b6288a94e7b/raw/6c970ba6b001a44375e2cf669f36d747f9d4c786/antigravity-live-page-2026-11-03T18-46-30-116.jpg)
![Permission denied in chat](https://gist.githubusercontent.com/nicholaicascio/c1503c0c6938c442600b5b6288a94e7b/raw/6c970ba6b001a44375e2cf669f36d747f9d4c786/antigravity-live-chat-2026-11-03T18-50-31-035.jpg)
![Successful tool result](https://gist.githubusercontent.com/nicholaicascio/c1503c0c6938c442600b5b6288a94e7b/raw/6c970ba6b001a44375e2cf669f36d747f9d4c786/antigravity-live-result-2026-11-03T18-51-04-000.jpg)
![Mobile page](https://gist.githubusercontent.com/nicholaicascio/c1503c0c6938c442600b5b6288a94e7b/raw/6c970ba6b001a44375e2cf669f36d747f9d4c786/antigravity-mobile-2026-11-03T18-52-00-473.jpg)

## Risks

- Headless Antigravity denies tools it cannot get approval for. The result carries the CLI's notice, and the opt-in auto-approval runs commands inside the CLI's terminal sandbox.
- The conversation map is in memory per OpenCode process. A follow-up continues the session's conversation until OpenCode restarts; the tool result always carries the exact id, and passing it back resumes.
- Token counts from the CLI are not shown in Usage.
- The plugin callback is authenticated per managed OpenCode child, answers only this machine, and exempts itself from `NO_PROXY` inside the child. Enterprise mode does not materialize the plugin, does not start the CLI for status, and refuses every run.
- With an external OpenCode server, no managed plugin is injected, so the page disables enabling and says why.
- The tool is named `agy`, the same as the reference plugin. Installing both registers the name twice and the later transform wins.
- There is no `dir` argument and no attachment support. A task runs in the session's directory only.
- The skill is registered at runtime by the plugin, so agents have it but it does not appear in Settings → Skills, which lists files.
- The implementation is rewritten for OpenChamber's server-side callback and settings model, with the reference repository's MIT notice kept in the module documentation.
````
