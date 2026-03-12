---
description: Draft user-facing CHANGELOG.md entries for [Unreleased]
agent: build
---

You are updating @CHANGELOG.md and @packages/vscode/CHANGELOG.md.

Goal: write user-facing bullet points for the `## [Unreleased]` section that summarize the changes since the latest git tag up to `HEAD`.

Style rules:
- Match the writing style of the existing changelog (tone + level of detail).
- User-facing and benefit-oriented; avoid internal component names unless users see them (ex: "VS Code extension", "Desktop app", "Web app").
- For @packages/vscode/CHANGELOG.md: Craft entries specifically for the VS Code extension. Exclude features or fixes specific to the Desktop app, Web app, or Mobile/PWA. Focus on core UI improvements and VS Code integration. Do NOT use "VSCode:" or "VS Code:" prefixes in this file.
- Prefer 5-9 bullets; group by platform only if it reads better.
- No new release header; only update the `[Unreleased]` bullets.
- Don't include implementation notes, commit hashes, or file paths in the changelog text.
- Use area prefixes when helpful for grouping in the main @CHANGELOG.md (e.g., "Chat:", "VSCode:", "Settings:", "Git:", "Terminal:", "Mobile:", "UI:").
- Credit contributors inline using "(thanks to @username)" at the end of the bullet. Find contributor usernames from commit authors or PR metadata when available. Skip if contributor is btriapitsyn, since this is a repo owner.

Determine the base version:
- Use the latest tag (ex: `v1.3.2`) as the base.
- Inspect all commits after the base up to `HEAD`.

Repo context for style:
!`head -140 CHANGELOG.md`

Git context (base tag, commits, changed files):
!`BASE=$(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD); echo "Base: $BASE"; echo "Commits since base: $(git rev-list --count "$BASE"..HEAD)"; echo "Diff stats: $(git diff --shortstat "$BASE"..HEAD)"; echo; echo "=== Top 30 commits ==="; git log --oneline -30 "$BASE"..HEAD; echo; echo "=== Changed files ==="; git diff --stat "$BASE"..HEAD`

Additional hints (optional, use only if needed):
- If there are breaking changes or user-visible behavior changes, call them out first.
- If changes are mostly internal refactors, summarize them as reliability/performance improvements.

Now:
1) Propose the new `[Unreleased]` bullet list for the main @CHANGELOG.md.
2) Propose the VS Code-specific `[Unreleased]` list for @packages/vscode/CHANGELOG.md.
3) Edit both files to update their respective `[Unreleased]` sections.
