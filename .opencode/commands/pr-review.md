---
description: Review a pull request and deliver a maintainer verdict with the ready-to-post action
---

Review this pull request: $ARGUMENTS

Load `.agents/skills/pr-review/SKILL.md` from the base checkout and follow it exactly — it owns the verdict ladder (DECLINE / PUSH-BACK / MERGE-THEN-FIX / MERGE), the product-fit escalation, the ache-salvage rule for declines, the output format, and the voice. Do not reproduce the automated review bot's comment template or metadata marker; this is an interactive maintainer review.

Review-only by default: no checkouts, edits, GitHub posts, or merges until the maintainer approves a specific action from your ready action.
