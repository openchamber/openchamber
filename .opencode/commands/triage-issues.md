---
description: Batch-triage the issue backlog — sweep, verdicts, and approved batch actions
---

Triage the issue backlog. Focus, if any: $ARGUMENTS

Load `.agents/skills/triage-issues/SKILL.md` from the base checkout and follow it exactly — it owns the phases (mechanical sweep → approved batch actions → assessment fan-out), the verdict ladder (FIX-READY / NEEDS-REPORTER / CLOSE-FIXED / CLOSE-DUPLICATE / CLOSE-DECLINE / FEATURE-DECISION), and the message templates.

Never post, close, or label anything without the maintainer approving that specific batch. When the focus names a subset (e.g. "enhancements", "root-cause:found", a label, or a list of numbers), run the pipeline over that subset only.
