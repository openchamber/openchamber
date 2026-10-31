---
description: Create, find and update local issues (markdown files in .issues/)
---

Manage local issues in this project. Issues live in `.issues/` as `LOCAL-<n>-<slug>.md` files.

$ARGUMENTS

Rules:

1. Creating: read `.issues/`, take the highest `LOCAL-<n>` number, use n+1. If the target file already exists, increment and retry. Slug is lowercase `[a-z0-9-]`, max 60 chars. Frontmatter (exactly these keys, in this order): `identifier`, `title`, `state` (one of `triage`, `backlog`, `todo`, `in-progress`, `done`, `canceled`), `priority` (`urgent`|`high`|`medium`|`low`|`null`), `labels` (array), `assignee` (`null`), `createdAt` and `updatedAt` (ISO), `feature` (`null`), `blockedBy` (array). The body below the frontmatter is the description.
2. Finding: list the directory, match by identifier prefix or search titles and bodies.
3. Updating state: edit the `state` frontmatter value only, and bump `updatedAt`.
4. Code references: when a session fixed something, append the touched file paths (with `:line` when useful) to the issue body so the UI can link them.
5. Never rename files: the identifier in the name is permanent.
6. Comments: the board appends entries under a `## Comments` heading as `### <ISO> · <source>` sections. When you edit an issue body, keep that heading and every entry under it unchanged.
