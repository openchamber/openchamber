---
description: Pick verified bugs and fix them — "шо в нас по ерорам?" starter
---

Focus, if any: $ARGUMENTS

The maintainer wants to fix real bugs without touching the GitHub UI. Run this as a conversation, not a report:

1. **Gather the menu.** `gh issue list --state open --label root-cause:found --json number,title,labels,comments` — bugs whose intake comment cites a traced mechanism with file:line.
2. **Check for a PR in flight.** Before proposing anything, look for an open PR that already fixes it (`gh pr list --state open --search "<N> OR <error string>"`, and the issue's linked PRs). A candidate with an open PR is dropped from the menu and named as such — the fix belongs to its author; the work is reviewing their PR with the `pr-review` skill, never re-implementing it.
3. **Propose 3–5 candidates**, one line each: the user-visible symptom, the traced mechanism (file:line), and rough size. Order by severity: data-loss and regression first, then whatever matches the maintainer's focus (an area, a platform, "щось маленьке"). Ask which to take — batches of related small fixes in one area are welcome.
4. **Verify before fixing.** Anchors age: confirm the cited mechanism still exists on current main (main moves fast). If it is gone, say so and mark the issue for a fixed-close instead of fixing air.
5. **Fix properly.** Follow AGENTS.md instruction order (matching skills — sync bugs demand `sync-state-invariants`, hot paths `performance-engineering`); minimal fix plus a regression test per local precedent; focused validation.
6. **Close the loop.** When the maintainer confirms and asks to commit, include `fixes #<N>` per bug in the commit message so GitHub closes the issues automatically. Never commit or push without being asked.
