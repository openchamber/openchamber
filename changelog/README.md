# Release notes source

One file per release, plus `unreleased.md` for what has not shipped. At release time `oc-dev create-release` turns `unreleased.md` into `<version>.md` with today's date and renders `packages/vscode/CHANGELOG.md` (extension, shown by the Marketplace as is) and `index.json` (website and the app's update dialog) from the released files. Edit the files here; the generated ones are overwritten and hold released versions only, so editing `unreleased.md` never leaves them stale.

```markdown
---
version: 1.22.2
date: 2026-09-06
title: One-line headline, two to six words
---

Optional intro paragraph shown above the groups.

## App

### New
- Something the user could not do before.

### Improvements
- Something they could do works better now.

### Fixes
- Something was broken; name the symptom.

### Misc
- Bundled tool versions, packaging, platform support, retirements.

## VS Code

### Fixes
- Only what the extension actually mounts. Written separately, on purpose.
```

Groups may appear in any order in a source file; the generator emits them as New, Improvements, Fixes, Misc and drops empty ones. A release without a `## VS Code` section is absent from the extension changelog. Every release needs a `title`; `unreleased.md` carries only the `title` line in its front matter and gets `version` and `date` at release time.

`bun run changelog:check` validates every source file and fails when a generated file is behind the released sources; CI runs it. It writes nothing.

`CHANGELOG.md` at the repo root is legacy: app versions up to 1.22.1 fetch it from `main` for their update notes. It is refreshed while it exists and never recreated; delete it after 2026-09-19 and it is gone for good.

How to write the title and the bullets lives in `.agents/skills/update-changelog/SKILL.md`.
