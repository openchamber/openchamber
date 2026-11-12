# Overview

## Ownership

The overview page: one read of what waits on the user, what runs, what looks
done, and which worktrees can go, across every registered project. It opens
from the sidebar header and the command palette on desktop and web, and from
the sessions drawer footer on the phone (`OverviewPage layout="mobile"`). VS
Code has none: without a server there are no done hints, recaps or worktrees.

Why the page exists, every decision behind its rules and its look, and what is
left to build are in `ADR.md` beside this file.

- `lib/overview/overviewModel.ts` decides where a session or worktree goes.
  It is pure and owns every rule below; tests sit beside it.
- `useOverviewData.ts` gathers the facts from stores the app already keeps
  live and follows what the page needs while it is open.
- `useWorktreeChangeRequests.ts` reads each worktree branch's change request.
- `overviewActions.ts` runs Done and Clean up.
- `OverviewView.tsx` draws the page.

The page reads; it never owns state. In work is `lib/sessionWorkMetadata.ts`,
unread is `sync/session-unread.ts`, branch PRs live in the shared
`useGitHubPrStatusStore` (the page asks for its worktree branches under the
sidebar's keys), linked items are `useTrackedItemsStore`, read through the
sidebar's one repository-thread path (`getLinkedSidebarChanges`,
`getLinkedSidebarIssues` with `useRepositoryUrlMatcher()`).

## Invariants

- The page exists only while the server reports `overviewFeatureAvailable`
  (`OPENCHAMBER_OVERVIEW_ENABLED`, `packages/web/server/lib/overview/feature-flag.js`).
  Without it there is no entry anywhere and `setOverviewOpen` does not open it.

- Rows are top-level sessions. A subagent's running and its requests roll up
  to the session the user opens; `/btw` side questions have no row.
- A permission or question shows from any session. The rest follows
  `isOverviewFollowed`: with In work on, the sessions in work; with it off,
  the sessions touched in the last two weeks, so years of sessions nobody
  reopened do not all wait on the user. A session outside that shows only
  while running or, for a scheduled run, when its last turn failed.
- A blocked PR (orange) reads as failed checks when its checks failed and the
  branch does not conflict, and as a conflict otherwise, which covers a PR
  GitHub reports it cannot merge.
- An unread session waits on the user even when it looks done: it reaches
  Looks done once it is read.
- Done signals rank: a merged PR (branch or linked) while no PR of the session
  is open or of unknown state, then every linked issue closed (none open or
  unknown: "issue closed" when any was completed, "issue dropped" when every
  one was not planned or canceled), then Jev's current `suggestDoneAt`. A
  closed unmerged PR counts neither way. A failed last turn, a current
  assist suggestion, or uncommitted files in the session's own worktree veto
  any of them; the row stays under In work and shows the veto. No Jev call is
  made for the page.
- Stalled is in work, idle, not done, and untouched for 3 days
  (`OVERVIEW_STALLED_AFTER_MS`).
- The page reads every project's worktree list itself (`listProjectWorktrees`)
  on open and on window return: the sidebar's map holds only the projects its
  Tree view expands. It also reads each worktree branch's change request itself
  (`useWorktreeChangeRequests`): the directory's repository binding names the
  account, and the shared status store asks the host once per branch under the
  same key the sidebar uses. Without that read the page knew PR state only for
  the branches the sidebar showed, and Clean up stayed empty in List view. A
  branch whose repository has no connected account, or whose read failed, is
  unknown and never offered.
- Clean up offers only linked worktrees of registered projects, never the
  primary checkout, never one in use (a
  running session, the open session, the directory on screen), never one
  holding a session in work (that session's row offers it), and nothing git
  has not answered for. Merged, or no open PR and nothing for 14 days.
- A Looks done row offers Clean up only when it is the last session in work
  in that worktree; otherwise Clean up would close another session's work.
- Clean up decides at the moment of the action, never from the rendered row:
  it stops when the worktree or a session there is on screen, a background
  command runs there, or the host's status map (`getActiveSessionStatuses`)
  reports a session there running; a failed status read stops it too. It reads
  git and stops if git reports more to lose than the user agreed to: nothing
  for a clean worktree, the confirmed losses otherwise. It checks what runs
  again after the git read, then takes the sessions there from the store,
  marks the ones in work done, archives all of them, and removes the worktree
  with its local branch. A failed archive stops before removal.
- Bulk actions: Mark all done covers Looks done, including rows that rest on
  Jev alone, since Done comes back with the next message. Clean up all covers
  only worktrees where nothing is lost. Each confirmation lists what it touches
  and, folded, what it leaves out and why.
- While open, the page follows the linked items and branch PRs of the sessions
  it judges (`useTrackedItems`) and reads git for the linked worktrees: once on
  open, when the set changes, when the window returns, and after an action.
  Closed, it costs nothing.

## Decisions

### Why bulk Done here and not in the sidebar

The sidebar's In work block has no "close all": nothing leaves it without the
user's own click. The overview shows each row's reason and the confirmation
lists every session, so a bulk Done here is still the user's decision, made
with the evidence on screen.

### Why Jev-only rows are in bulk Done but not in bulk Clean up

Done removes nothing and reopens on the next message; on the held-out set
Jev's hint was followed by more edits after 22 of 80 hints, which costs a
reopen. Clean up deletes a worktree and its branch, so it rests on host and git
facts only.

### Why Mark done and Clean up are two buttons

"Done" means leaving In work. Removing a worktree is a different act, so it
has its own name and a tooltip that lists what goes, and appears only where
nothing is lost.

### Why review requests are one folded line and not rows

A repository whose CODEOWNERS names the maintainer requests their review on
every pull request, so `review-requested:@me` returns the whole open queue (30
rows on the maintainer's own screen). That is the board's catalogue, not
something waiting on the user. "Waiting on you" shows one line with the count,
read from one page of the search ("30+" past it), which opens into the list.

### Why one column of rows that each carry their action

The page speaks the sidebar's language: the same marks for a request, an
unread end and a running turn, bold titles where something waits, the time at
the row's end. Sections are told apart by space and a hairline, not fills. The
project is named only when the page spans more than one.

Every row carries its own actions at rest (quiet, full on hover), since the
page exists to act without opening each session; hidden-until-hover actions
were never found. The reason a row is listed sits beside its title in the
colour of its state, so the state is readable without the 12px mark. A second
line under the title carries only what helps decide: a recap on a done row,
the question asked on a waiting one.

The top is one line of counts, each a jump to its section, in place of a
sentence: the same facts, scannable, and nothing counted is hidden below.

What runs is a section of rows with the activity mark and the turn timer: the
running sessions are what the user comes back to check, and the chips under the
summary were glanced past.

In work is grouped by project, one row per project with its counts, the
sessions underneath when opened (a single project lists them straight away).
Twelve flat titles read as the sidebar again. Stalled sessions sit last in
their project with a note instead of a section of their own. Clean up is open
by default with the bulk action in its header; a folded section at the bottom
was never opened.

Rejected on the maintainer's screen: a 640px column (thin, every section one
grey list), a main column with a rail and tinted section tiles (fills too loud,
the rail truncated every stalled title), then a 58rem column with a summary
sentence, hover-only actions, a flat In work list and folded Stalled and Clean
up sections (too simple per row, too much as a whole).

### Why review requests come from one provider

They come from one search across the registered projects
(`useRepositoryAcrossReferenceList`), which asks a single provider: the first
in registry order whose descriptor has `features.referencesAcross`. Only
GitHub has it today, so projects on GitLab, Gitea or Gerrit are left out until their
provider offers that search.
