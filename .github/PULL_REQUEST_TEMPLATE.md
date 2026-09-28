<!--
Bug fix or small improvement? Fill in the sections below and open it.

New feature, behavior change, or rework? It needed an Ideas discussion before
the code: https://github.com/openchamber/openchamber/discussions/categories/ideas
Link it here. That post asks about the problem in your own words; it is not a
summary of this PR. A discussion opened after the implementation, describing
what you already built, closes together with the PR behind it, because it
arrives after the only moment when talking could have changed anything.
Without a discussion at all, a large PR gets parked with `needs-discussion`
until the product side is settled.

A PR that carries a product decision with no discussion behind it and no
maintainer go-ahead is not getting reviewed. Don't spend the evening on it. A "yes, go ahead"
from a maintainer in the discussion is what makes the PR worth writing.
See CONTRIBUTING.md.

Keep one change per PR. Unrelated fixes in the same diff wait for the biggest one.
Size labels count changed lines without tests, lockfiles, translation catalogs
and evidence images, so a small change with many locale files stays small.
-->

## What and why

<!-- Tell the story in plain words, the way you'd explain it to a colleague
     in chat. A few short paragraphs:
     - what was wrong or missing, as the user saw it
     - what the user sees now instead
     - why this way, if there was a real choice
     Link the issue or Ideas discussion.
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
     No visible change: one concrete sentence on why the diff cannot affect
     rendered behavior. -->

## Risks

<!-- Failure, rollback, cleanup, compatibility, security, performance, data-loss,
     or cross-runtime concerns that a reviewer should weigh. "None identified"
     needs a reason. -->
