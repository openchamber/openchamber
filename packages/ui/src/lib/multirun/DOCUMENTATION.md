# Multi-run membership, runs and fusion

A multi-run ("Run in parallel" in the UI) is one prompt, or several prompt
variants, sent to several models at once. Each lane is its own session, usually
in its own worktree. The UI treats the lanes as one run: one sidebar row, one
overview screen, one header tab.

## Authority

`identity.ts` owns the version-1 `session.metadata.openchamber.multirun` contract.
Each launch gets a UUID group identity; its prompt variants keep their `g1`,
`g2` names (`runGroup`, shown as A, B). Provider/model IDs and display labels
are data, not keys. Members carry a `run` or `fusion` role and their owning
`sessionID`. Optional fields: `title` (the run's display title) and
`autoFusion` (judge model plus the launching page id). Older markers lack them
and stay valid; a missing title falls back to the group slug.

OpenCode copies metadata when forking, sometimes without a `parentID`. A marker
belongs only to the matching session ID. A copied, pending, malformed or future
marker is ineligible and never falls back to a title. Metadata is not an access
grant; all reads, writes and deletions still go through the authenticated SDK
and OpenChamber server routes.

`createSession.ts` creates a pending marker with `sessionID: null`, then binds
the server-assigned ID with a second write. Callers register and dispatch only
after the returned metadata confirms binding. OpenCode 2.x accepts `metadata`
only at creation, so the binding write goes to OpenChamber's own metadata route
(`/api/openchamber/sessions/:id/metadata`, see `sync/session-archive-batch.ts`).
That route applies an RFC 7386 merge patch, so only the marker travels and
whatever another feature stored under `openchamber` in the meantime survives.
Renaming a run patches `multirun.title` alone on every member; a member whose
write fails keeps the old title and is reported.

The run's model and agent are set on the session at creation (`selection`),
because v2 pins a session to a model instead of taking one per prompt.

A failed binding attempts to delete only that newly created session. Worktrees
are retained because setup may already have written files. Successful siblings
remain usable and creation reports the failed count. Runtime changes stop later
requests, registration and dispatch.

## Runs

`runs.ts` derives runs from active root sessions: `buildMultiRunIndex` groups
by identity key and keeps groups with at least two active members. Archived
sessions never form or join a run, so after "Keep" the survivor is an ordinary
session again without any stored "resolved" state. Parsed identities are cached
per session object (records are replaced on update), so the index can be
rebuilt on every session-list change. Lanes sort by variant then creation;
fusions come first.

Consumers: the sidebar row model and mobile sheet (see the sidebar
DOCUMENTATION), the overview (`useMultiRun`), the header title
(`useMultiRunTitle`) and the header tabs (`useMultiRunMemberIds`: the lanes of a
run share one tab, `useSessionTabsStore.ensureTab` reuses the slot). The last
two read the global cache through primitive selectors because they are always
mounted.

## Launching

The composer's parallel mode (`components/chat/composer/parallel/`) and the
overview's "Ask another model" launch lanes; `useMultiRunStore.createMultiRun`
creates them and `dispatchRunPrompt` sends each lane its prompt with the
project's session knowledge. The Auto routing model is never a lane.
`runActions.askOtherModels` turns a chat into a run by writing membership onto
it and adding lanes that re-send its first prompt; it refuses any turn but the
first, because new lanes would start without the conversation that followed.
Launching is desktop, web and VS Code only; mobile shows runs but does not
launch them.

## Keep

Lane work is normally uncommitted: agents do not commit, so a lane's branch
still points at its start commit and `git worktree remove --force` would
destroy the work. `keep.keepRunMember` therefore, for every member other than
the kept one:

1. revalidates membership against the server record;
2. snapshots its worktree (`snapshotGitWorktree`, see the git service
   DOCUMENTATION) into `refs/openchamber/runs/<group>/<session>`: tracked,
   staged, unstaged and untracked-but-not-ignored files, with the real index,
   HEAD and branch untouched;
3. archives its chat;
4. removes its worktree and local branch, unless another active chat still
   lives there.

A failed step stops cleanup for that member only and leaves its worktree in
place; the result reports it. The project root is never removed. Snapshot refs
stay until someone deletes them; cleaning them up is not implemented.

## Fusion

`fusion.startRunFusion` fuses the selected finished lanes, across variants.
Sources are revalidated and their latest replies read; a read failure stops the
fusion instead of silently dropping a source, an unanswered lane is left out,
and no answer at all is `NoFusionOutputsError`.

- **Answers mode** (a source shares a directory, or nothing changed): the
  fusion session runs in the project directory and receives the task prompts
  and final answers.
- **Code mode** (every source has a worktree and at least one changed files):
  every source is snapshotted, the fusion gets its own worktree (a fresh `<slug>/fusion-<suffix>` branch) at the lanes'
  starting commit, and receives a manifest: task, final
  answer, change counts and snapshot commit per lane. Diffs are inlined only
  when they fit a tenth of the judge's context window (`shouldInlineDiffs`);
  otherwise the judge reads them with git, as the editable magic prompt
  `session.fusion.codeInstructions` tells it.

Fusion results keep the group identity with role `fusion`, so they join the run
as its first card. `autoFusion.ts` starts the configured fusion exactly once, on
the page that launched the run (`RUN_LAUNCHER_ID`), when every lane was seen
running on this page and has since left the live busy set with an outcome.
Persisted history never counts as finished; another client, or the launcher
after a reload, fuses from the overview instead.

## Overview

`components/multirun/RunOverview.tsx` is a main-area surface
(`useUIStore.runOverviewKey`), closed by selecting any session. Cards are not
selectable: "Keep this" sits on each finished card of an isolated run, and
cards turn into checkboxes only while fusion sources are chosen. "Add a model"
sits in the header (per variant section when there are several). Each card can
also archive just that member, or leave the run: `runActions.detachFromRun`
deletes the membership marker with a `null` merge patch and renames the lane to
the run title, so it is an ordinary session in its own directory or worktree.
A run left with one active member stops being a run on its own.

Each card's state comes from `laneStatus.resolveLaneStatus`, over live and
recorded facts only: a pending permission or question (the global blocking
index) wins over busy, then the live busy set, then OpenCode's recorded outcome
(`failed`, `interrupted` as stopped), a lane that never ended a turn, and a
normal end with or without answer text. A normal end is grey, never green: it
says the turn ended, not that the work is good; an unread dot marks replies
the user has not opened. A failed card shows the error recorded on the newest
assistant message (`laneData.loadLaneLastTurn`) or says to open the chat. The
header counts lanes per state, and the bottom bar names lanes waiting for the
user, because they block the run and auto-fusion. Each variant's prompt is one
line until "Show all" expands it into a bounded scrollable block. Cards read each
member's latest reply and worktree changes once per finished turn
(`useLaneSummaries`); a read failure is shown as unavailable, never as an empty
reply or zero changes. Web, desktop and VS Code mount it over the chat; mobile
mounts it in `MobileApp` with its own back button and without "Add a model",
in one card column; while it is open the mobile header names the run and hides
the session metadata button.

## Mobile lists

`MobileSessionsSheet` builds its own lists instead of the sidebar row model, so
each one collapses runs itself: the grouped tree and Recent (`MobileRunRow`) and
the timeline (`TimelineEntry` of kind `run`, `MobileTimelineList`) put one run
row at the first lane's position, with the lanes' combined activity. Search
results and the header switcher list lanes as sessions.

## Legacy sessions

Unmarked sessions use `title.ts` only for compatibility. Embedded model slashes,
prompt groups, duplicate indices and old empty-group segments are supported.
Legacy groups are scoped to their resolved project directory and become a run
only when two or more members parse into the same scope. Native and legacy
groups never join just because their labels match.

Old titles ending in `/2` or `/fusion` are inherently ambiguous. Preserve their
previous suffix interpretation; do not write guessed membership back to them.
Legacy names can still collide or lose recognition after renaming. Only new
ID-bound records provide exact membership.
