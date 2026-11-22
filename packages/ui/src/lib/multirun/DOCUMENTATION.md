# Multi-run membership, runs and fusion

A multi-run ("Run in parallel" in the UI) is one prompt, or several prompt
variants, sent to several models at once. Each lane is its own session, usually
in its own worktree. The UI treats the lanes as one run: one sidebar row, one
overview screen, one header tab.

## Authority

`identity.ts` owns the version-1 `session.metadata.openchamber.multirun` contract.
Each launch gets a UUID group identity; its prompt variants keep their `g1`,
`g2` names (`runGroup`, shown as A, B). Provider/model IDs and display labels
are data, not keys. Members carry a `run`, `fusion`, or `parent` role and their owning
`sessionID`. Optional fields: `title` (the run's display title) and
`autoFusion` (judge model plus the launching page id). Older markers lack them
and stay valid; a missing title falls back to the group slug. Titles are
trimmed and clamped at 200 code units on a surrogate pair boundary before they
are persisted, so a stored title never ends in a lone surrogate.

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

Optional `guidance` is saved on the source member, capped at 20,000 code units
to bound session metadata. It changes future fusion inputs without rewriting
the source output. Fusion results carry a `fusion` receipt with a UUID `passID`,
optional starting commit, and each input's session ID, directory, and code
snapshot reference and commit. Older records without these fields remain valid.

`membership.ts` owns importing and confirmed removal. Import revalidates the
anchor and existing session, requires an active root in the same directory or
canonical Git repository, and rejects other runs and unknown membership markers. Native
project IDs are not used as a cross-worktree ownership oracle. The picker uses
registered project/worktree ownership and computes candidates only while open. It writes an
ID-bound marker without moving files, restarting work, or renaming the
conversation. The imported session gets its own prompt variant so the caption
and fusion task keep its original prompt. Imports currently require an ID-bound
target; legacy title-only runs expose a disabled import action. Their lanes can
still be opened and removed with confirmation in the owning project scope.
Saved source guidance is offered for ID-bound members and stored fusion results.

Removal requires `confirmed: true`; cancellation performs no operation.
Confirmed removal revalidates the expected run before writing. It removes only
the marker and stores `openchamber.multirunDetached: true`, which suppresses
legacy-title fallback while preserving the conversation title. Attaching again
clears that flag. A failed write publishes nothing. Neither operation archives
a conversation or deletes a worktree.

A failed binding attempts to delete only that newly created session. Worktrees
are retained because setup may already have written files. A lane, added lane
or code fusion whose new worktree never populated has nothing in it; that
worktree and its branch are removed (`resolveCreatedWorktreeStartDirectory`)
and the lane counts as failed. Successful siblings
remain usable and creation reports the failed count. A failure while checking
new-checkout readiness preserves the directory and any artifacts for recovery.
Runtime changes stop later
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
An isolated run gives each lane a branch of its own
(`laneBranches.uniqueLaneBranchName`): the `<run>/<model>` seed, suffixed past
the repository's local branches and the launch's earlier lanes. The server
refuses an existing branch, so without this a second run with the same title,
or two models whose slugs match (`gpt-5`, `gpt.5`), failed those lanes. Every lane of a launch starts from one ref, read once:
the picked base branch, else `worktreeStartFrom` (the Settings start for
parallel runs), else the project root's `HEAD`. A failed read fails the launch
instead of starting lanes elsewhere. A
shared run puts every lane in `sharedDirectory`, the draft's directory.
Separate worktrees are the composer's default. A non-Git project cannot fall
back from requested isolation to shared files; creation reports
`MULTIRUN_ISOLATION_UNAVAILABLE` until `isolateRuns: false` explicitly chooses
sharing. The launch dialog warns that shared files can overwrite each other.
Every newly created lane, parent and fusion checkout waits for Git readiness
before a session is created there, even for a project at the repository root.
The setup-command wait preference controls setup only; it cannot authorize a
model to write into a checkout that is still being populated.
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

A member of a project opened on a folder of its repository runs in that folder
of its worktree (`<worktree>/ai`). `memberLocation.locateRunMember` finds the
checkout that holds the member's directory and never answers a checkout that
holds a registered project: git lists the primary checkout `repo` among the
worktrees of the project `repo/ai`, and removing it would remove the project.
OpenCode lists sessions by exact directory, so step 4 asks both the worktree
root and the member's folder for other active chats.

A failed step stops cleanup for that member only and leaves its worktree in
place; the result reports it. The project root is never removed. Snapshot refs
stay until someone deletes them; cleaning them up is not implemented.
Ignored files are outside the snapshots and are removed with the worktree.
The cleanup confirmation says so before the user chooses it. Fusion never calls
this cleanup operation.

## Fusion

`fusion.startRunFusion` fuses selected finished lanes or existing fusion
results, across variants. Parent conversations cannot be selected as sources.
Sources are revalidated and their latest replies read; a read failure stops the
fusion instead of silently dropping a source, an unanswered lane is left out,
and no answer at all is `NoFusionOutputsError`.
Running sources and sources moved to different projects are rejected. Duplicate
source IDs count once. Each pass appends a new session; sources stay active in
their original worktrees, including ignored files.

- **Answers mode** (a source shares a directory, or nothing changed): the
  fusion session runs in the project directory and receives the task prompts
  and final answers.
- **Code mode** (every source has a worktree and at least one changed files or carries a code-fusion receipt):
   every source is snapshotted to a unique per-pass ref, the fusion gets its own worktree (a fresh `<slug>/fusion-<UUID>` branch) at the lanes'
  starting commit, and receives a manifest: task, final
  answer, change counts and snapshot commit per lane. Diffs are inlined only
  when they fit a tenth of the judge's context window (`shouldInlineDiffs`);
  otherwise the judge reads them with git, as the editable magic prompt
   `session.fusion.codeInstructions` tells it.

The snapshot refs append `-fusion-<passID>` to the member ref, preserving earlier
passes instead of updating the same ref. The receipt makes the exact sources
and snapshots available for later combinations. Combining fusion results follows
their receipts back to the original task prompts, with visited-session deduplication.
Saved source guidance, current pass instructions, and recent parent conversation
join the fusion context. A parent read failure stops the pass rather than silently
omitting guidance. A failed send retains the created result and snapshots for recovery.
Code-fusion receipts keep code mode for later combinations even after a result's
changes are committed. The new checkout and source diffs use the retained original
base commit, so a clean working index does not omit committed result changes.

Fusion results keep the group identity with role `fusion`, so they join the run
as its first card. `autoFusion.ts` starts the configured fusion exactly once, on
the page that launched the run (`RUN_LAUNCHER_ID`), when every lane was seen
running on this page and has since left the live busy set with an outcome.
Persisted history never counts as finished; another client, or the launcher
after a reload, fuses from the overview instead.

### Why combining results creates another fusion session

The existing fusion mechanism already reads results and builds a combined answer
or checkout. Reusing it for finished fusion outputs keeps every pass separately
accessible and avoids cleanup or branch application as a side effect. Applying
the final checkout to a project branch stays in the Git workflow.

## Parent conversation

`parent.ts` creates an ordinary editable root session with role `parent` on
demand. It sends no automatic prompt and uses the currently chosen fusion model
until the user changes the chat's model. An isolated run gives the parent its own
worktree. The overview and normal session navigation both open it.

Normal parent sends through `routeMessage` use `parentContext.ts` to revalidate current known members and
attach live status, blocking requests and available final results. Failed member
reads are explicitly unavailable and do not hide successful siblings. These reads
are user-triggered; streamed status updates create no requests. Parent conversation
uses the normal composer and its existing queue or steer behavior. A queued message
affects fusion only after it is delivered into the conversation.

Parent guidance affects its own conversation and future fusion inputs. It is never
automatically broadcast to member sessions. The UI and model instructions direct
the user to open an individual session to steer its ongoing work; completed work
changes only when another instruction runs. Creating a parent does not suppress
the optional automatic first fusion.

### Why parent context is separate from creation

Message routing needs read-only context, while parent creation depends on the
session-registration store. Importing creation back into that store through
message routing caused an import-order crash. Keeping the read module independent
of registration makes initialization safe from either entry point.

## Overview

`components/multirun/RunOverview.tsx` is a main-area surface
(`useUIStore.runOverviewKey`), closed by selecting any session. "Clean up others"
sits on finished cards of an isolated run and opens the separate cleanup
confirmation. Each card gets its own source checkbox while fusion sources are
chosen; opening the chat or diff remains available and changes no membership.
"Add a model" sits in the header, per variant section when there are several.
"Add session" imports an existing conversation from the same project. Card
removal and archive each require their own confirmation. Removal keeps work
running in the same session; archiving keeps its conversation and worktree in
the archive. A run left with one active member stops being a run on its own.

### Why explicit removal is remembered separately from the title

Slash-style legacy titles can look like membership even after the marker is
removed. A detached flag prevents that fallback without making a title change
part of the removal's success condition. This keeps the user's conversation
title and makes detachment independent of a second write.

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
the timeline (`TimelineEntry` of kind `run`, `MobileTimelineRows`) put one run
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
