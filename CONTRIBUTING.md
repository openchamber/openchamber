# Contributing to OpenChamber

Thanks for helping improve OpenChamber.

OpenChamber is a web, desktop, and VS Code interface for OpenCode. Contributions are welcome, especially:

* Bug fixes
* UX and accessibility improvements
* Web, desktop, mobile web/PWA, and VS Code parity fixes
* Environment-specific fixes
* Missing expected behavior
* Documentation improvements
* Build, packaging, and release reliability fixes

Large UI changes, core product changes, new runtime behavior, or new integrations should start with an issue before implementation. This helps avoid duplicate work and keeps the project direction clear.

## Before You Start

Before working on a change:

1. Search existing issues and pull requests.
2. For bugs or features, open or comment on an issue first.
3. Keep the change small and focused.
4. Read [`AGENTS.md`](./AGENTS.md) once before code changes; it contains repository-specific architecture and implementation rules.
5. Do not add new dependencies, design systems, icon packs, fonts, or broad refactors without maintainer agreement.

Small documentation fixes, typo fixes, or clearly isolated maintenance changes may go straight to a pull request.

## Getting Started

```bash
git clone https://github.com/openchamber/openchamber.git
cd openchamber
bun install
```

Use commands from the repository root unless a section says otherwise.

## Dev Scripts

### Web

| Script                 | Description                                                                | Ports                       |
| ---------------------- | -------------------------------------------------------------------------- | --------------------------- |
| `bun run dev`          | Default web HMR dev flow.                                                  | auto-selected dev ports     |
| `bun run dev:web:full` | Build watcher + Express server. No HMR -- manual refresh after changes.     | `3001` server/static        |
| `bun run dev:web:hmr`  | Vite dev server + Express API. Open the Vite URL for HMR, not the backend. | `5180` Vite HMR, `3902` API |
| `bun run start:web`    | Start the packaged web server.                                             | `3000` by default           |

These are configurable with:

```bash
OPENCHAMBER_PORT
OPENCHAMBER_HMR_UI_PORT
OPENCHAMBER_HMR_API_PORT
```

### Desktop

```bash
bun run electron:dev          # HMR web UI + Electron shell
bun run electron:dev:bundled  # Electron shell using built web assets
bun run electron:build        # Package desktop app for the current platform
```

Desktop supports macOS and Windows.

Build output is written to:

```text
packages/electron/dist
```

macOS builds create `dmg` and `zip` files. Windows builds create an NSIS installer. If signing environment variables are not set, the build script creates an unsigned installer.

For desktop-specific details, see [`packages/electron/README.md`](./packages/electron/README.md).

### VS Code Extension

```bash
bun run vscode:dev      # Watch mode + Extension Development Host
bun run vscode:build    # Build extension + webview
bun run vscode:package  # Create a local .vsix package
```

`bun run vscode:dev` opens an Extension Development Host automatically.

You can override the editor or workspace:

```bash
OPENCHAMBER_VSCODE_BIN=cursor bun run vscode:dev
```

### Shared UI

`packages/ui` is a source-level library used by Web, Desktop, and VS Code. It has no standalone app server.

Useful commands:

```bash
bun run build:ui
bun run type-check:ui
bun run lint:ui
```

## Build And Package Commands

| Command                  | What it does                                             |
| ------------------------ | -------------------------------------------------------- |
| `bun run build`          | Build all workspaces                                     |
| `bun run build:web`      | Build only `packages/web`                                |
| `bun run build:ui`       | Build only `packages/ui`                                 |
| `bun run build:electron` | Run Electron package build script without full packaging |
| `bun run electron:build` | Build packaged desktop app for the current OS            |
| `bun run vscode:build`   | Build the VS Code extension                              |
| `bun run vscode:package` | Package the VS Code extension as `.vsix`                 |
| `bun run pack:web`       | Create a package archive for `@openchamber/web`          |

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

Linux is supported for web and CLI development. Linux desktop packaging may differ from macOS and Windows.

## Issue Guidelines

Use issues for actionable bug reports, feature requests, UX problems, runtime parity gaps, and maintenance work.

Before opening an issue:

1. Search existing issues first.
2. Use a clear title.
3. Keep the report short and specific.
4. Include only information needed to reproduce, understand, or evaluate the issue.
5. Do not paste long AI-generated reports.

Good issue titles:

```text
bug: queued messages are not sent after /compact
bug(vscode): settings command opens the previous settings section
feat(git): show selectable file tree before commit
ux(sidebar): reclaim chat width after closing right sidebar
docs: clarify Ollama Cloud session cookie setup
```

Avoid vague titles:

```text
Bug
Not working
Feature request
Problem with app
Please add this
Huge list of bugs
```

### Bug Reports

A good bug report includes:

* What broke
* What you expected
* Steps to reproduce
* Runtime: web, desktop, mobile web/PWA, or VS Code
* Version, if known
* Screenshots, recordings, or logs when useful

For UI bugs, screenshots or short recordings are often the fastest way to make the issue actionable.

For data loss, broken sync, failed restore, terminal issues, provider issues, or runtime behavior, include the smallest reproduction you can.

### Feature Requests

A good feature request explains:

* The problem or workflow you are trying to solve
* The proposed behavior
* Why it belongs in OpenChamber
* Whether it affects web, desktop, mobile web/PWA, VS Code, or all runtimes
* Screenshots, mockups, or examples when relevant

For large features, wait for maintainer feedback before opening an implementation PR.

## Pull Request Expectations

### Link An Issue

Most PRs should reference an existing issue.

Use one of these in the PR description when the PR fully resolves the issue:

```text
Fixes #123
Closes #123
```

For partial fixes, use plain wording instead:

```text
Part of #123
Related to #123
```

Tiny documentation or typo fixes may be accepted without an issue.

### Keep PRs Small

Pull requests should be small, focused, and easy to review.

Avoid:

* Unrelated refactors
* Drive-by formatting changes
* Mixing multiple bugs/features in one PR
* Changing generated files without explaining how they were generated
* Adding dependencies without prior agreement
* Touching unrelated runtimes unless needed for parity

Before adding new functionality, check whether similar behavior already exists elsewhere in the codebase.

### Branch Hygiene

Before pushing or updating a PR:

```bash
git fetch origin
git rebase origin/main
```

Make sure your PR contains only commits for your change.

Do not include unrelated commits from another branch, another agent, another PR, or local experiments. If your branch picked up unrelated commits, clean it before opening or updating the PR.

### UI Changes

If your PR changes UI, include screenshots or recordings.

Show:

* Before and after, when possible
* The affected runtime: web, desktop, mobile web/PWA, or VS Code
* Light and dark theme behavior when relevant
* Empty, loading, error, and long-content states when relevant

UI changes should reuse existing shared primitives, theme tokens, typography, and Tailwind patterns.

### Logic Changes

For non-UI changes, explain how you verified the behavior.

Include:

* What you tested
* Which command or commands you ran
* How a reviewer can reproduce or confirm the fix
* Any known limitations or follow-up work

If you could not run a relevant check, say so in the PR description.

### Cross-Runtime Changes

OpenChamber has shared behavior across web, desktop, mobile web/PWA, and VS Code.

If a change affects shared runtime contracts, API payloads, auth/session behavior, filesystem behavior, terminal behavior, sync behavior, settings, or provider state, check whether the other runtimes need the same update.

Do not accidentally ship a web-only assumption into shared UI code.

### PR Titles

Use conventional PR titles:

```text
fix: resolve session restore failure
feat: add queued message indicator
docs: update contributing guidelines
chore: clean release workflow
refactor: split terminal reconnect logic
test: add sync recovery coverage
```

Optional scopes are useful:

```text
fix(web): preserve pending messages after reconnect
fix(electron): hide Windows helper console
feat(vscode): add external link handling
docs(contributing): clarify PR expectations
```

### No AI-Generated Walls Of Text

Long AI-generated issues or PR descriptions are hard to review.

Keep descriptions short and specific:

* What changed
* Why it changed
* How it was verified
* Screenshots or logs when useful

If the explanation needs to be huge, the PR is probably too large.

## Language

Use English for all public project communication:

- Issue titles and descriptions
- Pull request titles and descriptions
- Review comments
- Commit messages
- Documentation changes

Logs, stack traces, screenshots, terminal output, and external error messages may stay in their original language, but the surrounding explanation should be in English.

Issues or pull requests that are not written in English may be marked as `needs-info` until they are updated.

## Before Submitting

Run the relevant checks before opening or updating a PR.

For most code changes:

```bash
bun run type-check
bun run lint
bun run build
```

For docs-only changes, run the docs validator when the change affects repository documentation:

```bash
bun run docs:validate
```

For package-specific changes, also run the closest relevant command, for example:

```bash
bun run build:ui
bun run type-check:ui
bun run lint:ui
bun run electron:build
bun run vscode:build
```

If a command fails because of your change, fix it before requesting review.

If a command fails for an unrelated existing reason, mention that clearly in the PR description.

## Code Style

Follow existing local patterns before introducing new ones.

General rules:

* Use functional React components.
* Keep TypeScript strict.
* Avoid `any`, blind casts, and shape guessing.
* Prefer precise types.
* Prefer early returns and explicit branching over nested ternaries.
* Use existing theme colors, typography, and Tailwind v4 patterns.
* Components must support light and dark themes.
* Reuse shared UI primitives before creating feature-local markup.
* Do not import notification/toast libraries directly when a shared wrapper exists.
* Do not add clever abstractions where a direct implementation is enough.
* Keep entrypoints thin and move domain logic into focused modules.
* Do not hide data loss, partial failure, or fallback behavior.
* Never add secrets or log sensitive data.

## Architecture Notes

Important high-level rules:

* Shared UI lives in `packages/ui`.
* Web server and runtime APIs live in `packages/web`.
* Desktop shell behavior lives in `packages/electron`.
* VS Code extension behavior lives in `packages/vscode`.
* OpenCode integration should go through the existing SDK/runtime boundaries.
* Do not add OpenCode feature backends to the native desktop shell unless the capability is inherently native.
* If module ownership changes, update the relevant module documentation.

## Project Structure

```text
packages/
  ui/        Shared React components, hooks, stores, and theme system
  web/       Web server, frontend, and CLI
  electron/  Electron desktop shell
  vscode/    VS Code extension host and webview
```

## Release And Changelog Changes

Release and changelog changes must be based on real merged commits, PRs, and issues.

Do not publish placeholder release notes.

Do not invent changes.

When preparing release notes:

* Compare against the previous release.
* Group related changes.
* Mention user-visible behavior.
* Include important fixes, compatibility notes, and known limitations.
* Credit contributors when appropriate.

## Not A Developer?

You can still help:

* Report bugs or confusing UX
* Test on different devices, browsers, and operating systems
* Add screenshots or reproduction steps to existing issues
* Suggest focused improvements through issues
* Help other users in Discord

## Questions?

Open an issue when the question is actionable as a bug report or feature request.

For general discussion, support, or coordination, use Discord:

https://discord.gg/ZYRSdnwwKA
