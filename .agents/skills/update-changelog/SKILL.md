---
name: update-changelog
description: Use only when the maintainer explicitly asks to update the changelog — then write `changelog/unreleased.md` (main app and VS Code extension) summarizing changes since the latest git tag.
license: MIT
compatibility: opencode
---

## Gate

Proceed only when the current message asks to update the changelog.

Write `changelog/unreleased.md` and nothing else. Never run `oc-dev create-release` or edit what it generates; `changelog/README.md` has the format. `bun run changelog:check` validates and writes nothing.

`unreleased.md` opens with a `title:` front matter line (see The title) and holds two sections:

- `## App` — Web, Desktop, Mobile/PWA, shared UI.
- `## VS Code` — the extension only, written separately (see below).

## The shape of a release

Each section (`## App`, `## VS Code`) is grouped; list only non-empty groups:

```markdown
### New
- **VS Code: comments on code.** Select lines, click the `+` in the gutter ... (thanks to @felipegenef)
- Project actions in worktrees: a session in a worktree can use the parent project's saved actions (thanks to @mattv8).

### Improvements
- Chat: Markdown tables are readable again, columns take the width their content needs (thanks to @ChangeHow).

### Fixes
- Chat: huge patches in tool cards open without freezing the page (thanks to @karimodm).

### SDK
- Actions: use `mode: "background"` to handle a message action without opening a panel.

### Misc
- Bundled OpenCode updated to 2.1.
```

Where a change goes:

- **New** — something the user could not do before: a feature, a surface, a language.
- **Improvements** — something they could do works better or reads clearer now.
- **Fixes** — something was broken and showed a wrong result; the bullet names the symptom.
- **SDK**: capabilities and API changes for extension authors, under `## App`. Name the API in backticks and what an author can build with it. Keep the same short bullet format; implementation internals belong in the PR. User-visible extension features and fixes stay in the regular groups.
- **Misc** — bundled tool versions, packaging, platform support, retirements. Rarely more than a few lines.

The maintainer's calls on the borderline cases:

- A rework of something that already existed (multi-run moved into the composer) is an **Improvement**, however large.
- Something that made the app hang or stutter (tooltips or menus jolting the whole window) is a **Fix**, named by that symptom.
- Minor polish (a dialog laid out in two columns, quieter metadata text) gets no bullet at all.

The generator orders the groups and drops empty ones; version and date are its concern.

## The title

Every release carries a one-line `title:` in its front matter. The website lists it beside the version and uses it as the heading of the release page, so it is the one line most people read. It answers "what would a user remember this release for":

- **Two to six words** naming the change most users will notice. For a fix-only patch, name what works again: `Terminal works again on Windows`, `Faster session switching`.
- **Plain words, sentence case**; product names keep their casing. No area prefix with a colon, no trailing period, no version number, no credit.
- **Never a category alone** (`Fixes`, `Stability`, `Improvements`, `Polish`) and **never a bare area** (`Git`, `Chat`): the title has to teach the reader something.
- Two headliners at most, joined with `and`, and only when the release really has two.
- **A small joke that still names the change** is the tradition: `Warm sessions, cold diffs`, `Tea time for git`, `Our monthly sidebar redesign`. Self-irony about our own habits lands best. Offer the maintainer a few, with a recommendation.

In `unreleased.md` it sits at the top:

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
BASE=$(git describe --tags --match 'v*' --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)
git log --oneline "$BASE"..HEAD
git diff --stat "$BASE"..HEAD
```

A hotfix ships from a `release/X.Y` branch, so its tag is not in `main`'s history and `BASE` stays at the release before it. Its changes already reached users: leave out every commit a hotfix since `BASE` cherry-picked. The hotfix tags are the `v*` tags newer than `BASE` that are not ancestors of `HEAD`, and each picked commit carries a `(cherry picked from commit <sha>)` line:

```bash
for tag in $(git tag --list 'v*' --no-merged HEAD); do
  git log --format=%B "$BASE".."$tag" | grep -oE 'cherry picked from commit [0-9a-f]+' | awk '{print $NF}'
done
```

On a release branch, writing a hotfix's own notes, the range is `BASE..HEAD` of that branch: only the picked changes.

A squashed merge (subject ending in `(#123)`) or a `Merge pull request #123` commit hides the real change behind a terse subject. Read the PR: `gh pr view <number> --json number,title,body,author,mergedAt`. Distill its intent into the bullet shape above; the body's own wording is reviewer-facing and stays there. When `gh` cannot fetch it, use the commit and diff and say what remains uncertain.

**Follow-ups fold in.** A maintainer commit that completes or reworks a merged PR (a "complete ... follow-ups" commit, a reshaping merge) has no bullet of its own; its user-visible effect goes into the bullet of the PR it finished, written as one behaviour. Changes that affect neither app users nor extension authors (tooling, CI, tests, docs, dead-code removal, internal guards) get no bullet.

Gathering is complete when every user-visible or SDK change has evidence, a known platform reach, and a contributor identity where one exists.

## Order and highlights

- Inside each group, sort by user impact: breaking changes, then what most users meet daily, then the rest, visual polish last.
- Bold the prefix of the strongest one to three bullets in the whole release and put each at the top of its group. A highlight introduces a capability, changes a common workflow, or fixes something severe. Size of the diff and effort spent are not reasons to bold.
- A change that is both a feature and a fix (a reworked area) gets one bullet in the group that describes what the user gains most; a second bullet only when the two halves are things a user would look for separately.
- Rank each changelog on its own; a main-app highlight is not automatically a VS Code highlight.

## VS Code section

An entry belongs here only when the extension actually mounts the surface. Read the surface map in `packages/vscode/src/DOCUMENTATION.md`. Server-side changes have no entry here; the extension runs no OpenChamber server. Prefixes drop the `VS Code:` part. Bullets are written separately from the App section rather than tagged, so reachability is a decision made per bullet. When reachability is uncertain, leave the entry out; a false entry becomes a bug report.

## Credit

End the bullet with `(thanks to @username)` using the GitHub login from the PR or commit. `yulia-ivashko` is credited like any contributor; her commits carry the author name `𝖎𝖚𝖑𝖎𝖎𝖆` or `Iuliia Ivashko` with the email `yulia.ivashko@gmail.com`, and both are her. The maintainer `btriapitsyn` gets no credit line: his work is the project's own and goes in like any other OpenChamber change. In a shared credit, drop only his login.

## Done when

Read each finished section top to bottom and check every bullet:

- A user could point at it in the app within five seconds of reading it; an SDK entry tells an extension author which API to use and why.
- It is one or two sentences (three for a highlight) in plain words, with no mechanism and no contrast against the old behaviour.
- It sits in the group its wording claims (a Fix names a symptom, a New names a capability) and no higher than the bullets above it in impact.
- Empty groups are absent.
- It appears only in the section whose runtime receives it.
- Its contributor is credited.
- The `title:` line names the release's headline change in two to six plain words.
- `bun run changelog:check` passes; nothing else in the repo changed.
