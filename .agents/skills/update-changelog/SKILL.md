---
name: update-changelog
description: Use only when the maintainer explicitly asks to update the changelog — then write `changelog/unreleased.md` (main app and VS Code extension) summarizing changes since the latest git tag.
license: MIT
compatibility: opencode
---

## Gate

The changelog is written once per release, by the maintainer, as one story. `changelog/` stays untouched by every other task; a fix or a merged PR lands without a changelog line. Proceed only when the current message asks to update the changelog.

Write `changelog/unreleased.md` and nothing else. Generation is not your job: `oc-dev create-release` turns the file into `changelog/<version>.md` with the date and renders `packages/vscode/CHANGELOG.md` and `changelog/index.json` from it. Never run the generator or touch those files. `bun run changelog:check` only validates the shape of what you wrote and writes nothing; `changelog/README.md` describes the format.

`unreleased.md` opens with a `title:` front matter line (see The title) and holds two sections:

- `## App` — Web, Desktop, Mobile/PWA, shared UI.
- `## VS Code` — the extension only, written separately (see below).

## The shape of a release

Every release section is grouped. Under the version header come, in this order and only when non-empty:

```markdown
### New
- **VS Code: comments on code.** Select lines, click the `+` in the gutter ... (thanks to @felipegenef)
- Project actions in worktrees: a session in a worktree can use the parent project's saved actions (thanks to @mattv8).

### Improvements
- Chat: Markdown tables are readable again, columns take the width their content needs (thanks to @ChangeHow).

### Fixes
- Chat: huge patches in tool cards open without freezing the page (thanks to @karimodm).

### Misc
- Bundled OpenCode updated to 1.19.
```

Where a change goes:

- **New** — something the user could not do before: a feature, a surface, a language.
- **Improvements** — something they could do works better or reads clearer now.
- **Fixes** — something was broken and showed a wrong result; the bullet names the symptom.
- **Misc** — bundled tool versions, packaging, platform support, retirements. Rarely more than a few lines.

The generator emits the groups in this order whatever order the source lists them and drops empty ones; version, date, and headers are its concern, not yours.

## The title

Every release carries a one-line `title:` in its front matter. The website lists it beside the version and uses it as the heading of the release page, so it is the one line most people read. It answers "what would a user remember this release for":

- **Two to six words** naming the change most users will notice. For a fix-only patch, name what works again: `Terminal works again on Windows`, `Faster session switching`.
- **Plain words, sentence case**; product names keep their casing. No area prefix with a colon, no trailing period, no version number, no credit.
- **Never a category alone** (`Fixes`, `Stability`, `Improvements`, `Polish`) and **never a bare area** (`Git`, `Chat`): the title has to teach the reader something.
- Two headliners at most, joined with `and`, and only when the release really has two.

`oc-dev create-release` refuses a release without a title. In `unreleased.md` it sits at the top:

```markdown
---
title: Comments on code in VS Code
---

## App
```

## The bullet

The reader is a user of the app. They never opened the code, they will not open the PR, and they give a bullet about five seconds. Write for that reader:

- **One sentence, two at most.** A bold highlight may take three. Under about 200 characters for a regular bullet.
- **Name what they see or do.** The screen, the button, the gesture, the outcome. When a fix removed a symptom, name the symptom in plain words ("froze the page", "sent the comment by accident", "stopped at the first page").
- **Plain words only.** Anything a user would have to look up is out: store, cache, route, payload, reconcile, authoritative, lifecycle, runtime, listing, revision, PTY, bridge. Internal component names are out unless the user sees them on screen.
- **State the new behaviour directly.** Say what happens now. Framing it against the old way ("X, not Y", "instead of Y", "rather than Y") is the tell of machine-written notes; drop the second half and let the sentence stand.
- **Area prefix, then the fact.** `Chat:`, `Settings/Providers:`, `Git:`, `Mobile:`, `Server:`, `CLI:`, `VS Code:` in the main file. A highlight bolds its prefix: `- **Project actions:** ...`.
- **Details stay in the PR.** No commit hashes, file paths, numbers that do not change what the user does, or mechanism. One concrete number is fine when it is the whole point ("more than 200 sessions").

Worked example, same change:

> Weak: *a saved action counts as running exactly while its command runs. When the command exits, the stop icon goes away even if the terminal tab stays open, and a second client can start the action again. Every client shows the same run, and the sidebar marks a directory that has one. Sessions in a linked worktree can use the parent project's actions; they run in the worktree by default.*
>
> Good: *the running state of a saved action is reliable now. It shows as running only while the command is really running, every device sees the same state, and the sidebar shows which project has something running. Worktrees can use the parent project's actions.*

The weak version is accurate and lost the reader at the first comma. The good version keeps the three things a user notices and drops the mechanics that explain them.

Load `.agents/skills/communication-style/SKILL.md` and run its pattern scan over the finished sections; its rules on em dashes, hedging, and puffery apply here unchanged.

## Gather

Determine the base and read everything through `HEAD`:

```bash
BASE=$(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)
git log --oneline "$BASE"..HEAD
git diff --stat "$BASE"..HEAD
```

A squashed merge (subject ending in `(#123)`) or a `Merge pull request #123` commit hides the real change behind a terse subject. Read the PR: `gh pr view <number> --json number,title,body,author,mergedAt`. Distill its intent into the bullet shape above; the body's own wording is reviewer-facing and stays there. When `gh` cannot fetch it, use the commit and diff and say what remains uncertain.

**Follow-ups fold in.** A maintainer commit that completes or reworks a merged PR (a "complete ... follow-ups" commit, a reshaping merge) has no bullet of its own; its user-visible effect goes into the bullet of the PR it finished, written as one behaviour. A change with no user-visible effect (tooling, CI, tests, docs, dead-code removal, internal guards) gets no bullet at all.

Gathering is complete when every user-visible change has evidence, a known platform reach, and a contributor identity where one exists.

## Order and highlights

- Inside each group, sort by user impact: breaking changes, then what most users meet daily, then the rest, visual polish last.
- Bold the prefix of the strongest one to three bullets in the whole release and put each at the top of its group. A highlight introduces a capability, changes a common workflow, or fixes something severe. Size of the diff and effort spent are not reasons to bold.
- A change that is both a feature and a fix (a reworked area) gets one bullet in the group that describes what the user gains most; a second bullet only when the two halves are things a user would look for separately.
- Rank each changelog on its own; a main-app highlight is not automatically a VS Code highlight.

## VS Code section

An entry belongs here only when the extension actually mounts the surface: trace from `packages/vscode/webview/main.tsx` → `VSCodeApp` → `VSCodeLayout`, which mounts a subset of the shared UI, and read the surface map in `packages/vscode/src/DOCUMENTATION.md`. Server-side changes have no entry here; the extension runs no OpenChamber server. Prefixes drop the `VS Code:` part. Bullets are written separately from the App section rather than tagged, so reachability is a decision made per bullet. When reachability is uncertain, leave the entry out; a false entry becomes a bug report.

## Credit

End the bullet with `(thanks to @username)` using the GitHub login from the PR or commit. The repo owner `btriapitsyn` gets no credit line.

## Done when

Read each finished section top to bottom and check every bullet:

- A user could point at it in the app within five seconds of reading it.
- It is one or two sentences (three for a highlight) in plain words, with no mechanism and no contrast against the old behaviour.
- It sits in the group its wording claims (a Fix names a symptom, a New names a capability) and no higher than the bullets above it in impact.
- Empty groups are absent; present groups appear in the order New, Improvements, Fixes, Misc.
- It appears only in the section whose runtime receives it.
- Its contributor is credited.
- The `title:` line names the release's headline change in two to six plain words.
- `bun run changelog:check` passes; nothing else in the repo changed.
