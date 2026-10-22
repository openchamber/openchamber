# ADR: the overview page

Status: in progress, shipped dark behind `OPENCHAMBER_OVERVIEW_ENABLED`.
Decided with the maintainer, 2026-10-20 and 2026-10-21. `DOCUMENTATION.md`
beside this file holds the invariants the code must keep; this file holds why
the page exists, what was decided, what was tried and dropped, and what is
next, so a later session can continue without the original conversation.

## Why the page exists

People who run many agents in parallel lose track. Sessions finish while they
look elsewhere, agents stop on a permission prompt in a project that is not on
screen, branches get merged and their worktrees stay behind. The sidebar shows
all of it, spread over projects, folders and rows built for navigation.

The overview is one read of the state of things right now, across every
registered project, for "a tired person with a lot of work". It answers four
questions in order: what waits on me, what is running, what looks done and can
be closed, what can be cleaned up. The user's attention is the scarce resource,
so the page shows as little as it can, and lets the user close finished work
from where they read it.

It is not a kanban board. The maintainer does not believe in a board for
managing sessions by state; columns of states were never on the table. It is
also not a second Issues and PRs board: the board is a catalogue the user goes
to on purpose, the overview is a status read.

## What it shows

Sections, top to bottom (`lib/overview/overviewModel.ts` decides membership):

- **Summary.** One to three sentences ("3 things wait on you. 2 agents are
  running, 4 sessions look done."), then the running sessions as a line of
  chips with the sidebar's activity mark and turn timer.
- **Waiting on you.** A permission or question request from any session,
  shown on the top-level session the user opens (a subagent's request is
  answered in its parent). An unread end with an error. A failed scheduled run.
  An own PR with failed checks or a conflict. An unread finished session. At the
  end, one folded line "PRs asking for your review: N" that opens into the list.
- **Looks done.** Sessions in work, idle, read, with a done signal and no veto.
  Each row: Mark done, and Clean up where that is safe. A bulk "Mark all done".
- **In work.** The rest of the sessions in work: idle, read, no done signal or
  a veto, touched in the last three days. The veto shows as a note.
- **Stalled** (folded). In work, not done, untouched for three days.
- **Can be cleaned up** (folded). Linked worktrees whose PR is merged, or that
  have no open PR and no activity for 14 days. Bulk "Clean up all" for the
  ones where nothing is lost.

"In work" means the sidebar's In work set (`metadata.openchamber.work`). With
the In work feature off, the page follows every session touched in the last
two weeks instead (`isOverviewFollowed`).

## Decisions and why

### Which unread ends wait on the user

With In work on, only sessions in work count, plus a failed scheduled run;
otherwise every scheduled run and quick chat would become a row. With In work
off, every top-level session counts, limited to two weeks, or years of sessions
nobody reopened would wait forever. Subagents never count on their own.

An unread session stays in Waiting even when it looks done: the user reads it
first, then it moves to Looks done.

### What "looks done" means

Signals rank by how much they can be trusted:

1. **Host facts.** A merged PR, branch or linked, while no PR of the session is
   still open or of unknown state (a closed unmerged PR counts neither way).
   Otherwise every linked issue or ticket closed, none open or unknown. A
   completed one gives "issue closed"; if every one was not planned or
   canceled, "issue dropped", since nothing is left to do but the work was not
   done either.
2. **Git facts.** Clean and pushed, from the worktree's git state (shared with
   the merged-worktree cleanup in `lib/worktrees/mergedWorktreeCleanup.ts`).
3. **Jev's hint** (`suggestDoneAt`), which session work already computes once
   per turn. The page makes no Jev call of its own.

Vetoes keep a session in work whatever the signal: the last turn failed, the
assist has a current suggestion (it only suggests a next message when requested
agent work is unfinished), or the session's own worktree has uncommitted files.
A session in the project root cannot have files attributed to it, so there only
the suggestion and the failed turn veto.

The maintainer asked that it be visible why a session is not done: every vetoed
row names its veto, and the bulk confirmation lists the left-out sessions with
theirs.

Measured on Jev (session-work lab, 190 held-out sessions): it missed 28 of 81
real shipping turns and 22 of its 80 hints were followed by more edits. Misses
outnumber false hints, and Done comes back with the next message, so Jev-only
rows are trusted for Done but never for removing anything.

### Two actions with two names

"Mark done" is only Done: the session leaves In work, nothing else changes.
"Clean up" is Done for the sessions in work there, archive of every session in
the worktree, and removal of the worktree with its local branch. The maintainer
asked for distinct names, since Done had always meant leaving In work, never
archiving. Clean up appears on a Looks done row only when its PR is merged,
nothing would be lost, nothing there runs or is open, and no other session in
that worktree is still in work.

### Bulk actions here, not in the sidebar

The sidebar's In work block has no "close all": nothing leaves it without the
user's own click. The maintainer's point was that the overview is different
because it builds a definition of done the user can trust, with the evidence on
screen. So bulk exists only here: Mark all done covers Looks done, Jev-only rows
included; Clean up all covers only worktrees where nothing is lost. Each
confirmation lists every item with its reason and, folded, what it leaves out.

### Cleanup proposes worktrees, never plain sessions

Offering to archive old sessions outside worktrees would list thousands of rows
for a long-time user. Only worktrees are proposed: merged ones, and stale ones
(no open PR, 14 days without commits or session activity). A stale worktree
with uncommitted files or unpushed commits is offered one at a time, with a
confirmation that names what will be lost; it never joins a bulk action.

Clean up decides at the moment of the action, never from the drawn row: it
re-reads what runs there (background commands, the host's session status map,
whether it is on screen), re-reads git, and stops if anything changed.

### Review requests are one folded line

The repository's CODEOWNERS names the maintainer for everything, so
`review-requested:@me` returned the whole open queue: 30 rows on the first try.
Those are the board's catalogue, not something waiting on the user, so they are
counted on one line that opens into the list. GitHub only for now: the search
across repositories asks one provider with `features.referencesAcross`, and
GitLab and Gitea do not have it.

### The page reads what it needs itself

The sidebar's worktree map and its branch PR status exist only for the projects
its Tree view expands. Relying on them left Clean up empty in List view (and
merged-PR signals missing for sessions in collapsed projects). The page now
lists every project's worktrees itself and reads each worktree branch's change
request through the same status store, under the same keys
(`useWorktreeChangeRequests`). It follows linked items and those branch PRs live
only while open; closed, it costs nothing.

### Shipping dark

The page is behind `OPENCHAMBER_OVERVIEW_ENABLED` (server,
`packages/web/server/lib/overview/feature-flag.js`), reported to the client as
`overviewFeatureAvailable` in the settings payload. Unset, there is no sidebar
button, no command palette item, no phone footer button, and `setOverviewOpen`
refuses to open the page. It is absent rather than switched off, so the code can
reach `main` and releases while the design is still being iterated. VS Code has
no OpenChamber server, so it never has the page.

## How the look was arrived at

Three passes on the maintainer's screen:

1. **A 640px centered column**, sections as tinted cards, a reason on every
   row. Rejected: thin on a desktop window, every section one grey list, and
   30 review rows drowned everything.
2. **A main column with a right rail**, sections on tinted tiles, a coloured
   text badge and a project chip on every row. Rejected: the fills were too
   loud, the rail truncated every stalled title, and chips plus badges ran
   together into mush.
3. **One wide column (~58rem) in the sidebar's visual language.** The same
   marks the sidebar uses (`SessionActivityIndicator` for running and unread,
   the shield and question marks for requests), bold titles where something
   waits, the time at the row's end, sections separated by space and a hairline
   only. The project is named only when the page spans more than one project.
   This is the current pass.

Feedback on pass 3: the title was hard to tell from the metadata. The title is
now always full strength (medium, semibold when waiting), recaps are one muted
line with the full text on hover, notes and project names are smaller and
lighter, and stalled rows carry no recap.

Principle that came out of it: the page should not invent a visual language.
Colour lives on marks and on notes that name a problem; everything else is the
text colour or muted.

## Not built yet

- **Projects section.** One quiet row per project with counts: PRs merged,
  open PRs and issues with new ones, tracker items done. Counts use calendar "today /
  yesterday" in local time; the maintainer found that simpler than a rolling
  24 hours, and "since your last visit" was rejected because opening the page
  without reading it would wipe the counts.
- **All my open PRs across projects** (v1 knows only the PRs of session
  branches and linked ones).
- **GitLab parity** for review requests and the counts: the maintainer requires
  GitLab to match GitHub.
- **Tracker completed counts** (Linear today).

## Where to look

- `lib/overview/overviewModel.ts`: every membership rule, pure, tested.
- `components/overview/useOverviewData.ts`: facts from the stores.
- `components/overview/useWorktreeChangeRequests.ts`: worktree branch PR state.
- `components/overview/overviewActions.ts`: Mark done and Clean up.
- `components/overview/OverviewView.tsx`: the page.
- `lib/i18n/messages/overview.i18n.ts`: all strings, every locale.
