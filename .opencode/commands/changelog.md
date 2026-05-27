---
description: Draft user-facing CHANGELOG.md entries for [Unreleased]
agent: build
---

You are updating @CHANGELOG.md and @packages/vscode/CHANGELOG.md.

Goal: write user-facing bullet points for the `## [Unreleased]` section that summarize the changes since the latest git tag up to `HEAD`.

Style rules:
- Match the writing style of the existing changelog (tone + level of detail).
- Write like release notes for actual users, not a marketing summary. Be concrete and plain-spoken.
- Avoid generic payoff clauses like "making X faster", "improving reliability", "for a smoother workflow", or "so you can..." unless the diff clearly proves that exact user-visible outcome.
- Prefer short direct bullets: what changed, where users see it, and only one consequence if it is obvious.
- Avoid internal implementation details, but do not replace them with vague benefits. If a technical change has no clear user-visible effect, omit it or group it under a plain reliability bullet.
- Avoid internal component names unless users see them (ex: "VS Code extension", "Desktop app", "Web app").
- For @packages/vscode/CHANGELOG.md: Craft entries specifically for behavior that is present in the VS Code extension. Exclude Desktop app, Web app, Mobile/PWA, and main-app-only UI. Do not copy shared/main changelog bullets into this file unless changed files or code paths show the feature exists in the extension. Focus on core UI improvements and VS Code integration. Do NOT use "VSCode:" or "VS Code:" prefixes in this file.
- Prefer 5-9 bullets; group by platform only if it reads better.
- No new release header; only update the `[Unreleased]` bullets.
- Don't include implementation notes, commit hashes, or file paths in the changelog text.
- Use area prefixes when helpful for grouping in the main @CHANGELOG.md (e.g., "Chat:", "VSCode:", "Settings:", "Git:", "Terminal:", "Mobile:", "UI:").
- Credit contributors inline using "(thanks to @username)" at the end of the bullet. Find contributor usernames from commit authors (not email, but a github username) or PR metadata when available. Skip if contributor is btriapitsyn, since this is a repo owner.

Quality checks before editing:
- For every bullet, ask: "Could a user point to this in the UI or behavior?" If not, rewrite it or drop it.
- For every VS Code bullet, verify the change applies to the extension, not just shared web UI or server code. When unsure, leave it out of @packages/vscode/CHANGELOG.md.
- Do not mention low-level mechanics such as "local refs first", "source of truth", "route", "store", "cache", "payload", or "ref resolution". Translate only when there is a clear user-facing symptom.
- Do not bundle unrelated changes just to reduce bullet count. It is better to omit minor internal fixes than to create a vague catch-all sentence.
- Avoid LinkedIn-style language. Bad: "commit review is faster and branch history is more reliable." Better: "commit history can now show file diffs inline." Bad: "installed-state accuracy is improved." Better: "the skills list now matches OpenCode's installed skills more closely."

Determine the base version:
- Use the latest tag (ex: `v1.3.2`) as the base.
- Inspect all commits after the base up to `HEAD`.

Repo context for style:
!`head -140 CHANGELOG.md`

Git context (base tag, commits, changed files):
!`BASE=$(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD); echo "Base: $BASE"; echo "Commits since base: $(git rev-list --count "$BASE"..HEAD)"; echo "Diff stats: $(git diff --shortstat "$BASE"..HEAD)"; echo; echo "=== Top 30 commits ==="; git log --oneline -30 "$BASE"..HEAD; echo; echo "=== Changed files ==="; git diff --stat "$BASE"..HEAD`

Additional hints (optional, use only if needed):
- If there are breaking changes or user-visible behavior changes, call them out first.
- If changes are mostly internal refactors, mention them only when there is a concrete user-visible fix. Otherwise do not add a changelog bullet for them.

Now:
1) Propose the new `[Unreleased]` bullet list for the main @CHANGELOG.md.
2) Propose the VS Code-specific `[Unreleased]` list for @packages/vscode/CHANGELOG.md.
3) Edit both files to update their respective `[Unreleased]` sections.
