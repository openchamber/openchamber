# Contributing to OpenChamber

## Before you start

Every pull request links an issue, and which issue depends on the change.

- **Bug fix.** Open a [bug report](https://github.com/openchamber/openchamber/issues/new?template=bug_report.yml), or find the existing one, and put `Fixes #N` in the PR description. You don't need to wait for anyone.
- **New feature or a change to how something behaves.** Open a [feature request](https://github.com/openchamber/openchamber/issues/new?template=feature_request.yml) and wait. Building starts after the maintainer marks it `accepted`. Write it in a few sentences of your own: what you were trying to do, what got in your way, what you'd want instead. A long generated write-up with headings, implementation plans and file lists isn't read.

A pull request without a linked bug report or accepted feature request is closed automatically with the `needs-accepted-issue` label. It reopens on its own once its description links one (`Fixes #N`, or `Part of #N` for one piece of a larger feature), or once the linked feature request gets `accepted`. Pull requests that only change documentation or tests don't need an issue.

**What counts as a feature request?** Anything where two reasonable people
could disagree about whether it should exist or how it should behave. In
practice: a new button, panel, setting or command; a changed default; a
shortcut or gesture that now does something else; different wording, ordering
or grouping in the UI; anything that turns existing behavior on or off for
everyone. Also removing or working around behavior the code marks as
deliberate: if a comment says something is skipped on purpose, then "is that
actually a bug?" is a product question, and it comes first.

A bug is a crash, wrong data, something that doesn't work the way it plainly
says it does, or a performance fix that keeps behavior identical. A feature
filed as a bug report gets relabeled, and its pull request closes with it.

Not sure which one it is? Open a feature request and ask. It costs you one
paragraph and saves you the whole pull request.

Repository collaborators and the people listed in
[`.github/trusted-contributors`](.github/trusted-contributors) skip the
automatic close. Their pull requests still carry product decisions only after
the maintainer agreed to them.

Maintainers review everything by hand. Small, focused PRs get reviewed first;
a PR that mixes unrelated fixes waits for the largest of them.

## Getting Started

```bash
git clone https://github.com/openchamber/openchamber.git
cd openchamber
bun install
```

To start over from a fresh state, `bun run clean` removes every `node_modules`
and build output (`dist`, `dist-*`, built-in extensions), packaged desktop
builds in `packages/electron/dist` included. Then run `bun install` again. Add
`-- --dry-run` to see the list without deleting anything.

## Dev Scripts

Run commands from the project root unless a section says otherwise.

### Web

| Script | Description | Ports |
|--------|-------------|-------|
| `bun run dev` | Vite dev server + Express API. **Open the Vite URL for HMR**, not the backend. | `5180` (Vite HMR), `3902` (API) |
| `bun run start:web` | Start the packaged web server. | `3000` by default |

Both are configurable via env vars: `OPENCHAMBER_PORT`, `OPENCHAMBER_HMR_UI_PORT`, `OPENCHAMBER_HMR_API_PORT`.

### Desktop (Electron)

```bash
bun run electron:dev          # HMR web UI + Electron shell
bun run electron:dev:bundled  # Electron shell using built web assets
bun run electron:build        # Package desktop app for the current platform
```

Desktop supports macOS, Windows, and Linux. The build output is written to `packages/electron/dist`.

macOS builds create `dmg` and `zip` files. You need Xcode/build tools for notarized packaging and icon asset work.

Windows builds create an NSIS installer. If signing env vars are not set, the build script makes an unsigned installer.

Linux builds produce an AppImage, a `.deb` and an `.rpm` for the native x64 or arm64 host. The `.rpm` needs `rpmbuild` (the `rpm` package on Debian/Ubuntu).

For desktop-specific details, see [`packages/electron/README.md`](./packages/electron/README.md).

### VS Code Extension

```bash
bun run vscode:dev      # Watch mode + Extension Development Host
bun run vscode:build    # Build extension + webview
bun run vscode:package  # Create a local .vsix package
```

`bun run vscode:dev` opens an Extension Development Host automatically. You can override the editor or workspace with `OPENCHAMBER_VSCODE_BIN` and `OPENCHAMBER_VSCODE_DEV_WORKSPACE`.

Example: `OPENCHAMBER_VSCODE_BIN=cursor bun run vscode:dev`.

### Shared UI (`packages/ui`)

No standalone app server. This is a source-level library used by Web, Desktop, and VS Code.

Useful package commands:

```bash
bun run build:ui
bun run type-check:ui
bun run lint:ui
```

## Build And Package Commands

| Command | What it does |
|---------|--------------|
| `bun run build` | Build all workspaces |
| `bun run build:web` | Build only `packages/web` |
| `bun run build:ui` | Build only `packages/ui` |
| `bun run build:electron` | Run Electron package build script without full packaging |
| `bun run electron:build` | Build packaged desktop app for the current OS |
| `bun run vscode:build` | Build the VS Code extension |
| `bun run vscode:package` | Package the VS Code extension as `.vsix` |
| `bun run pack:web` | Create a package archive for `@openchamber/web` |

## Platform Build Notes

You usually build desktop installers on the target platform.

macOS:

```bash
bun run electron:build
bun run release:test:intel
bun run release:test:arm
```

Windows:

```bash
bun run electron:build
```

Linux x64 and arm64 packages are built natively on the matching host architecture. Use Bun for dependency installation and packaging orchestration:

```bash
OPENCHAMBER_TARGET_ARCH=x64 bun run electron:build
# On an arm64 host:
OPENCHAMBER_TARGET_ARCH=arm64 bun run electron:build

bun run --cwd packages/electron verify:linux-appimage
```

The final AppImage verifier checks desktop identity and the architecture of Electron, the bundled OpenCode CLI, and packaged native modules.

## Before Submitting

```bash
bun run type-check   # Must pass
bun run lint         # Must pass
bun run test         # Must pass
bun run build        # Must succeed
```

`bun run test` runs every suite in the repository: shared UI, VS Code, Electron,
web/server, and the root scripts. The UI, VS Code, and Electron suites keep
module-level singletons, so `scripts/run-isolated-tests.mjs` gives each test file
its own process instead of letting load order decide the result. Run a single
file directly while iterating (`bun test <file>`).

UI tests run on happy-dom, where DOMPurify stops visiting the siblings of a node
it removed: test each malicious payload in its own call, or a combined payload
passes or fails for the wrong reason. The UI's `bun:test` type shim is trimmed
(no `test.each`, no `toMatch`): use loops and `regex.test()` with `toBe`.

For docs-only changes, validation may be enough:

```bash
bun run docs:validate
```

## Code Style

- Functional React components only
- TypeScript strict mode — no `any` without justification
- Use existing theme colors/typography from `packages/ui/src/lib/theme/` — don't add new ones
- Components must support light and dark themes
- Prefer early returns and `if/else`/`switch` over nested ternaries
- Tailwind v4 for styling; typography via `packages/ui/src/lib/typography.ts`

## Pull Requests

Pull requests are review handoffs, not just diffs. A reviewer must be able to
understand the intended behavior, assess the risk, and verify the result
without reconstructing the contributor's work.

Before opening a pull request:

1. Link the issue: `Fixes #N` for a bug report or a whole accepted feature
   request, `Part of #N` for one piece of an accepted feature request (see
   *Before you start*).
2. Read [`AGENTS.md`](./AGENTS.md), every project skill matching the character
   of the change, and the nearest package README and module `DOCUMENTATION.md`.
3. Keep the change focused. Separate unrelated cleanup or refactors.
4. Run the validation required by the applicable project guidance, not only
   the broad commands above.
5. Complete the pull request template with concrete, current evidence.

### Pull Request Contract

Every pull request must explain:

- **What and why:** the story of the change in plain words, the way you'd
  tell it to a colleague in chat: what was wrong as the user saw it, what
  they see now, why this way. Not a walk through the diff, not a file list,
  not a bullet per commit; the reviewer reads the diff. If nearby behavior is
  deliberately left unchanged and a reader might expect otherwise, say so in
  a line.
- **Affected surfaces:** packages, persisted/external contracts, and
  user-visible states affected by the change, plus one line per runtime (web,
  desktop, VS Code, hosted mobile, Capacitor mobile) saying what the change
  does there. "Not applicable" is an answer; a blank row is not. Write that
  list while deciding what to build, not after: it is the same list the pull
  request template asks for.
- **Validation:** exact automated and manual checks performed, their result,
  and anything that was not verified. A command name without a result is not
  evidence.
- **Live run:** if your change touches behavior a user can reach at run time,
  say that you ran the built or running app and exercised the changed path.
  This is in addition to any screenshot, recording, or measurement the change
  needs, never instead of one: a screenshot shows what a surface looks like,
  a live run says a person reached it in a running build.
  Name the runtime you used (web, desktop, VS Code, hosted mobile, or Capacitor
  mobile), the operating system, and what you saw. Reading the diff, passing
  types, and green CI are not a live run. If you genuinely cannot run it, say
  so and explain why; an honest gap is reviewable, a claim we later find hollow
  is not.
- **Risks:** meaningful failure, rollback, cleanup, compatibility, security,
  performance, or cross-runtime considerations.

You still have to read the project skills and module docs that match your
change (step 1 above); the reviewer checks the code against them. You don't
have to list them in the PR.

Do not claim a runtime, platform, relay path, performance characteristic, or
interaction is correct based only on type-checking or linting. If required
validation could not be performed, state that explicitly and explain why.

### Visual Evidence

User-visible changes require evidence that lets a reviewer compare the
behavior before and after the change. Attach screenshots for static states and
a short recording for motion, gestures, drag-and-drop, focus, or multi-step
interactions.

Evidence goes in the PR description, never in the branch: committed images,
recordings, logs and traces ship in every clone of the repository, and the
intake check asks you to remove them. Two ways to attach it:

- By hand: drag the files into the PR description editor and GitHub hosts them.
- From an agent or a script: `node scripts/pr-evidence.mjs --title "openchamber #123 evidence" before.png after.png`
  uploads PNG, JPEG, GIF or WebP files to a secret gist and prints the Markdown
  to paste into the description. Record motion as a GIF. It needs an
  authenticated `gh`.

Changes to the translation catalogs, where all UI wording lives, need no
screenshots.

Both rules are checked on every pull request. A branch that adds screenshots,
recordings or logs gets `evidence-in-branch`; a change to UI files
(`packages/ui/src`, `.tsx` and `.css`) whose description has no image gets
`needs-visual-evidence`. The review starts once the label is gone, and it comes
off on its own when the files leave the branch or the description gains a
screenshot.

Claims about performance, memory, CPU, rendering, startup, or similar empirical
behavior require relevant before and after measurements.

Choose evidence based on the affected behavior:

- Include before and after states. If a meaningful before state cannot be
  captured, explain why.
- Include narrow/mobile and desktop states when shared or responsive UI is
  affected.
- Include light and dark states when colors, styling, surfaces, or visual
  states change.
- Include relevant loading, empty, error, disabled, long-content, or
  high-contrast states when the change affects them.
- For Settings changes, show the relevant narrow and wide settings pane states.

Evidence must represent the current pull request HEAD. After implementation
changes that can affect the demonstrated behavior, refresh the evidence or
state why it remains valid. If a UI change genuinely shows nothing on screen,
say why in the description; the maintainer then lifts the label by hand.
Deleting the evidence section is not an exemption.

### Review enforcement

The automated reviewer performs one unified review of correctness, repository
guidance compliance, pull request quality, and evidence. It independently
determines which project skills apply from the character of the current diff,
reads those skills and their required references, and checks the implementation
against them.

The reviewer records the exact HEAD it inspected and returns one verdict:

- `PASS`: no blocking correctness, compliance, or evidence issue was found.
- `NEEDS_EVIDENCE`: no correctness, repository-guidance, or contribution-contract
  blocker was found, but a required screenshot, interaction recording,
  empirical measurement, or live-run statement is missing, stale,
  contradictory, or inadequate. A change to user-reachable behavior with no
  live-run statement does not reach `PASS`.
- `BLOCKED`: a concrete correctness, security, repository-rule, or contribution
  contract violation must be fixed.
- `HUMAN_REVIEW_REQUIRED`: the change affects review policy or another boundary
  that automation must not approve on its own.

The workflow exposes the current state as exactly one readiness label:
`review:pending`, `review:ready`, `review:needs-evidence`, `review:blocked`,
`review:human-required`, or `review:automation-failed`. A new review removes
the previous readiness label before it starts, and only `review:ready` means
the pull request is ready to enter the maintainer review queue. Draft pull
requests have no readiness label.

AI review verdicts are advisory and never fail the pull request check. Readiness
is communicated only through the `review:*` label and immutable review comment.
The `automation` job fails only when the workflow itself cannot complete or
verify a trustworthy result, in which case it applies `review:automation-failed`.

Each completed review creates a new comment tied to its reviewed HEAD so the
conversation remains chronological. Previous review comments are not rewritten.

### Size label

Every PR gets a `size:XS` to `size:XXL` label from its changed lines. Tests,
lockfiles and translation catalogs (`packages/ui/src/lib/i18n/messages`) don't
count, so a one-line settings change that touches twelve locale files is still
`size:XS`.

### Keeping PRs active

Stale PRs add review load and make it hard to tell what's still being worked on, so the stale bot keeps the open list current. A PR with no activity for 28 days is automatically labeled `stale`, and closed 7 days later if it stays inactive. To keep a PR open:

- Push updates or respond to review feedback
- Leave a comment if you're waiting on a reviewer
- Add the `pinned`, `security`, or `help wanted` label to exempt a long-running PR from the stale bot

Reopening a closed PR is fine if it becomes relevant again.

## Project Structure

```
packages/
  ui/        Shared React components, hooks, stores, and theme system
  web/       Web server (Express) + frontend (Vite) + CLI
  electron/  Electron desktop shell
  vscode/    VS Code extension (extension host + webview)
```

See [AGENTS.md](./AGENTS.md) for detailed architecture reference.

## Not a developer?

You can still help:

- Report bugs. Even "this felt confusing" is useful. Write issues in English (machine translation is fine); reports in other languages wait until someone translates them
- Test on different devices, browsers, or OS versions
- Suggest features with a [feature request](https://github.com/openchamber/openchamber/issues/new?template=feature_request.yml)
- Answer questions in [Q&A discussions](https://github.com/openchamber/openchamber/discussions/categories/q-a)

## Questions?

Open a [Q&A discussion](https://github.com/openchamber/openchamber/discussions/categories/q-a).
