---
description: Pick an accepted feature and build it — "чим нині займемось?" starter
---

Focus, if any: $ARGUMENTS

The maintainer wants to start feature work without touching the GitHub UI. Run this as a conversation, not a report:

1. **Gather the menu.** `gh issue list -R openchamber/openchamber --state open --label accepted --json number,title,labels,comments` — these are features the maintainer already approved; the acceptance comment on each records the approved scope ("welcome shape"), which is binding.
2. **Propose 3–5 candidates**, one line each: what the user gets, rough size (small / medium / large by mechanism, never hours), and which areas it touches. Favor small wins and anything the maintainer's focus hints at. Ask which one to take (or accept "surprise me" — then pick the best value-to-size).
3. **Build it properly.** Re-read the issue and its acceptance comment for the approved scope; follow AGENTS.md instruction order (matching skills, owning DOCUMENTATION.md); implement with tests per local precedent; run the focused validation the change class requires.
4. **Close the loop.** When the maintainer confirms it works and asks to commit, include `fixes #<N>` in the commit message so GitHub closes the issue automatically. Never commit or push without being asked.

If nothing carries the `accepted` label yet, say so and suggest running `/triage-issues enhancements` first to build the menu.
