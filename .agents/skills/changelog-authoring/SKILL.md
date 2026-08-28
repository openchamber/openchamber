---
name: changelog-authoring
description: Use when drafting or updating user-facing CHANGELOG.md entries for the OpenChamber `[Unreleased]` section, including the VS Code extension changelog, summarizing changes since the latest git tag.
license: MIT
compatibility: opencode
---

## Overview

Draft user-facing bullet points for the `## [Unreleased]` section that summarize changes since the latest git tag up to `HEAD`.

Two files are maintained:

- `CHANGELOG.md` — main app (Web, Desktop, Mobile/PWA, shared UI).
- `packages/vscode/CHANGELOG.md` — VS Code extension only.

Only update the `[Unreleased]` bullets. Never add a new release header.

## Gather Context First

Read recent release sections for style. Determine the latest tag (or initial commit fallback), then inspect every commit and changed path through `HEAD`:

```bash
BASE=$(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)
git log --oneline "$BASE"..HEAD
git diff --stat "$BASE"..HEAD
```

Context gathering is complete when each user-visible change has evidence, platform reach, and contributor identity where available.

## Squashed PR Merges

A squashed merge commit often collapses a whole PR into a single terse subject line that omits valuable detail. When a commit looks like a squashed PR merge (subject ending in `(#123)`, or a `Merge pull request #123` commit), inspect the PR itself — its title and description usually carry the real user-facing context.

Use `gh pr view <number> --json number,title,body,author,mergedAt` for PR evidence.

- Prefer the PR description over the squashed commit subject when the description explains the user-visible change more accurately.
- Do not copy PR descriptions verbatim; distill them into the changelog style below.
- Use PR author/metadata to attribute contributor credit (see Contributor Credit).
- If `gh` is unavailable or the PR cannot be fetched, fall back to the commit message and diff, and note any uncertainty rather than inventing details.

## Writing Style

- Match the tone and level of detail of the existing changelog.
- Write like release notes for real users, not marketing. Be concrete and plain-spoken.
- Avoid generic payoff clauses ("making X faster", "improving reliability", "for a smoother workflow", "so you can...") unless the diff clearly proves that exact user-visible outcome.
- Prefer short direct bullets: what changed, where users see it, and only one obvious consequence.
- Omit internal implementation details; do not replace them with vague benefits. If a technical change has no user-visible effect, omit it or group under a plain reliability bullet.
- Avoid internal component names unless users see them (ex: "VS Code extension", "Desktop app", "Web app").
- Use area prefixes in the main changelog when they help grouping (e.g., "Chat:", "VSCode:", "Settings:", "Git:", "Terminal:", "Mobile:", "UI:").
- Do not include commit hashes, file paths, or implementation notes in changelog text.
- Do not mention low-level mechanics ("local refs first", "source of truth", "route", "store", "cache", "payload", "ref resolution"). Translate only when there is a clear user-facing symptom.
- Avoid LinkedIn-style language. Bad: "commit review is faster and branch history is more reliable." Better: "commit history can now show file diffs inline."

## Highlights and Ordering

- Sort bullets by user impact, not commit order. Breaking changes first, then significant new capabilities or broad user-visible improvements, then smaller features, fixes, and visual polish.
- Keep the opening highlight block contiguous. Place every bold highlight before the first regular bullet; a regular bullet marks the end of the highlight block.
- Mark only the strongest highlights with a bold area prefix, such as `- **Chat attachments:** ...`. Usually the first 1–3 bullets; fewer when the release lacks substantial changes, more only when clearly justified.
- Treat a change as a highlight only when it introduces a substantial user-facing capability, materially changes a common workflow, or fixes a severe/widespread problem. Do not bold merely because a bullet is first, has a large diff, or was hard to implement.
- Keep related platform bullets together only when that does not push a more important change too far down.
- Rank highlights independently in each changelog. A main-app highlight is not automatically a VS Code highlight.

## VS Code Changelog Rules

- Craft entries only for behavior present in the VS Code extension. Exclude Desktop, Web, Mobile/PWA, and main-app-only UI.
- **Reachability check before every entry.** A change touching shared UI or the VS Code bridge earns a VS Code changelog entry only when the surface is actually mounted from the VS Code entrypoint (`packages/vscode/webview/main.tsx` → `VSCodeApp` → `VSCodeLayout` — which mounts only a subset of shared surfaces; consult the surface map in `packages/vscode/src/DOCUMENTATION.md` when present, trace the mount when not). Shared code that VS Code never mounts is dead there — an entry for it is a false claim users will file bugs about. When in doubt, leave the entry out of the VS Code changelog.
- Do not copy shared/main bullets here unless changed files or code paths show the feature exists in the extension.
- Focus on core UI improvements and VS Code integration.
- Do NOT use "VSCode:" or "VS Code:" prefixes in this file.
- When unsure whether a change reaches the extension, leave it out.

## Contributor Credit

- Credit contributors inline with "(thanks to @username)" at the end of the bullet.
- Find usernames from commit authors (GitHub username, not email) or PR metadata when available.
- Skip credit when the contributor is `btriapitsyn` (repo owner).

## Completion Criteria

- For every bullet: "Could a user point to this in the UI or behavior?" If not, rewrite or drop it.
- For every VS Code bullet: verify the change applies to the extension, not just shared web UI or server code.
- For every bold bullet: "Would a user reasonably call this a headline change?" If not, unbold or move it lower.
- Read the finished list top to bottom; confirm each bullet is no more important than those above it, except where keeping related platform bullets together improves readability.
- Do not bundle unrelated changes to reduce bullet count. Prefer omitting minor internal fixes over vague catch-all sentences.
- Mention mostly-internal refactors only when there is a concrete user-visible fix; otherwise add no bullet.

The lists are complete when every bullet is supported by inspected evidence, points to user-observable behavior, is ranked by impact, appears only in changelogs whose runtime receives it, and credits eligible contributors.

## Workflow

1. Gather repo style and complete git/PR context.
2. Propose the new `[Unreleased]` bullet list for the main `CHANGELOG.md`.
3. Propose the VS Code-specific `[Unreleased]` list for `packages/vscode/CHANGELOG.md`.
4. Edit both files to update their respective `[Unreleased]` sections.
