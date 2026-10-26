# Feature-request fact brief

Handed to the `explore` subagent together with a batch file during issue triage (phase 3 of the `triage-issues` skill).

Gather the facts on feature-request issues for the OpenChamber repository. The current working directory is the maintainer's branch, which carries everything on `main`. Git and `gh` stay read-only: no commits, branch changes, pushes, comments, labels, or closes. The task names a batch file with the issues' full text and comments. You gather facts; the maintainer's lead agent makes every judgment about whether an idea is worth doing. Do not rate ideas as good or bad.

For every issue in the batch, in order, find out two things.

**1. Is it already done?** Search the current code for the feature, not for the issue number: grep for the setting name, UI label, command, component, or behavior the request describes (`packages/ui/src`, `packages/web`, `packages/electron`, `packages/vscode`, `packages/mobile`; locale strings live in `packages/ui/src/lib/i18n` and are a fast way to find UI labels). Then check history: `git log --oneline -i --grep='<terms>'`, `git log -S'<identifier>' --oneline`, and the release notes in `changelog/*.md`. Check open PRs with `gh pr list --state open --search '<number> OR <terms>'`. Read maintainer comments in the thread (btriapitsyn, yulia-ivashko): a maintainer reply that says it shipped, or that declines it, is a fact to report.

Status is one of:
- `DONE`: the requested behavior exists today. Evidence names the file (path:line) and, when you found it, the commit or release.
- `PARTIAL`: part of it exists. Say exactly which part exists and which part is missing.
- `NOT-DONE`: you searched and found nothing. Say what you searched for.
- `IN-PR`: an open PR implements it. Give the PR link.
- `UNCLEAR`: the request is too vague to check. Say why.

Never mark `DONE` from a hunch, a similar-sounding name, or a commit message alone: open the code and confirm the behavior is there. A commit counts only if `git merge-base --is-ancestor <sha> origin/main` succeeds.

**2. What is being asked?** Two or three plain sentences: what the user wants, and the concrete pain behind it in the user's own situation. If the only reason given is "tool X has it", say so. Note the rough size as scope, never as time: "one setting", "touches the sidebar only", "new subsystem". Note any duplicate you notice within the batch or against another open issue.

Output one block per issue, in batch order, and count your blocks against the issue count before replying, and never drop one:

```
### #<number>: <title>
Status: DONE | PARTIAL | NOT-DONE | IN-PR | UNCLEAR
Evidence: <path:line, commit sha, release, PR link, or what you searched>
Ask: <2–3 sentences: what and why>
Size: <scope>
Thread: <maintainer decisions or notable replies; "none" if none>
Duplicate: <#N or "none">
```

Write in English. Do not post, close, label, comment, edit files, or change branches. Do not run builds, type-checks, tests, or servers.
