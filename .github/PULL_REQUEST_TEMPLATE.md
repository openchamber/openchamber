<!--
Every PR links an issue in "What and why" below:
- `Fixes #N` for a bug report, or for a whole feature request the maintainer
  marked `accepted`;
- `Part of #N` for one piece of an accepted feature request.

A new feature or behavior change starts as a feature request, and building
starts after it is `accepted`. A PR with no linked bug report or accepted
feature request is closed automatically with `needs-accepted-issue`, and
reopens once its description links one. Documentation-only and test-only
PRs need no issue. See CONTRIBUTING.md, "Before you start".

Keep one change per PR. Unrelated fixes in the same diff wait for the biggest one.
Size labels count changed lines without tests, lockfiles and translation
catalogs, so a small change with many locale files stays small.
-->

## What and why

<!-- Tell the story in plain words, the way you'd explain it to a colleague
     in chat. A few short paragraphs:
     - what was wrong or missing, as the user saw it
     - what the user sees now instead
     - why this way, if there was a real choice
     Link the issue: `Fixes #N` if this PR fixes all of it, so GitHub closes
     it on merge; `Part of #N` if it fixes only part.
     If nearby behavior is deliberately left alone and a reader might expect it
     changed, say so in a line.

     Not here: file lists, function names, a walk through the diff, or a
     bullet per commit. The reviewer reads the diff; this section is what the
     diff can't say. -->

## Affected surfaces

<!-- Packages, user-visible states, and persisted or external contracts touched.
     Then one line per runtime. "Not applicable" is an answer; a blank row is not.
     If a runtime behaves differently on purpose, say so. -->

| Runtime | Behavior after this change |
|---|---|
| Web |  |
| Desktop (Electron) |  |
| VS Code |  |
| Hosted mobile |  |
| Capacitor mobile |  |

## Validation

<!-- Exact commands or manual checks and their results. Say what was not verified.
     Type-check and lint alone do not prove runtime behavior. -->

| Check | Result |
|---|---|
|  |  |

**Live run:** <!-- Did you run the built or running app and exercise the changed path? Name the runtime (web / desktop / VS Code / hosted mobile / Capacitor mobile), the OS, and what you saw. Required in addition to any screenshot or recording below, not instead of one. Not required when no user-reachable behavior changes. If you could not run it, say so and why. -->

## Visual evidence

<!-- User-visible change: current before/after screenshots or recordings for the
     affected desktop/mobile, narrow/wide, theme, and interaction states.
     Attach them here in the description; never commit them to the branch.
     From an agent: `node scripts/pr-evidence.mjs` uploads them to a secret
     gist and prints the Markdown.
     A UI change with no screenshot here is labeled `needs-visual-evidence`
     and waits. No visible change: one concrete sentence on why the diff
     cannot affect rendered behavior; the maintainer lifts the label. -->

## Risks

<!-- Failure, rollback, cleanup, compatibility, security, performance, data-loss,
     or cross-runtime concerns that a reviewer should weigh. "None identified"
     needs a reason. -->
