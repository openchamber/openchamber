# Trackers (shared UI)

## Ownership

This module owns what the shared UI knows about work-item trackers (Linear,
and the trackers installed extensions serve): the contract types (`types.ts`, the same shapes as
`packages/web/server/lib/trackers/tracker-contract.d.ts`), the registry of the
connected server's trackers, their per-id presentation, and the neutral helpers
every surface uses: state looks, link matching, the agent context text, session
status posts and project mapping. `extension.ts` tells an extension's tracker
(`ext-<guest id>`) from a built-in one and finds the installed extension behind
it; `hooks/useTrackerProviderSync.ts` keeps the registry current while the
server's tracker list changes.

Surfaces (references, board, composer, sidebar, work status, overview, New
Worktree, Settings cards and search) consume it; none of them names a tracker. Data
access is `RuntimeAPIs.trackers` (`TrackerAPI`, every call names its tracker),
implemented by `packages/web/src/api/trackers.ts` for web, desktop and mobile;
VS Code has none. Auth status per tracker lives in
`stores/useTrackerAuthStore.ts`. Repository issues are not trackers: they stay
on the source-control side (`lib/source-control/`).

## Invariants

- The registry (`registry.ts`) mirrors the source-control provider registry: the
  server's descriptors (`TrackerAPI.providers()`), remembered per runtime in
  `localStorage` (`openchamber.trackerProviders.v1`, at most 16 runtimes,
  validated on read) for first paint, refreshed by `refreshTrackers` next to
  source-control auth, and reset by `runtimeEndpointReset.ts`. A failed refresh
  keeps the held list (`stale`) and is `error` only with nothing to show, which
  the registry retries with a growing wait; an answered empty list, or a
  runtime without the API, is authoritative. Like the source-control registry
  it reads `getRuntimeKey()` when it refreshes, never writes a snapshot under a
  transient key, and keeps the held objects when an answer is unchanged.
- An id the registry does not hold reads as `unknownTrackerDescriptor(id)`: the
  id as its name, no auth methods, every capability off, only the `open` and
  `all` filters, no URL patterns (it matches no link). One object per id.
- Tracker ids match `^[a-z][a-z0-9-]{0,31}$` and share a namespace with
  source-control ids: `guest`, `link`, `external` and `repository` are refused
  by syntax, and the registry leaves out any id the source-control registry
  serves, re-checking whenever that list changes, so whichever list lands
  first a provider's id is never also a tracker. One malformed descriptor is
  left out, never the list; a capability an older server does not name is off;
  an unknown auth method is dropped.
- No surface picks behavior by comparing a tracker id: the source-control
  neutrality guard (`lib/source-control/providers/neutrality.test.ts`) also
  refuses string-literal comparisons against `linear`. Per-id words and marks
  live in `presentation.ts`; the legacy readers below still produce `linear`
  for data written before trackers.
- Translated text never comes from the server. `presentation.ts` holds the
  mark, the sentences that name a tracker, the branch prefix and the Settings
  search words per id, with a generic fallback: the generic mark and the
  generic `{provider}` sentences (`GENERIC_COPY` in `presentation.ts` and in
  `components/sections/integrations/trackerSettingsCopy.ts`), which take the
  tracker's served name.
- Links are a tracker's only through its served `urlPatterns`
  (`matchTrackerUrl.ts`), the same rule as the server's `matchUrl`; one URL
  table is asserted on both sides (`linearUrlCases.fixture.ts`). A pattern
  with `query` names the parameter that carries the identifier (Jira's
  `?selectedIssue=KEY-1`); its path still has to match, and the value is
  checked against the descriptor's `identifierPattern`. The host compiles both
  from an extension's link templates; the UI never sees a template. The
  templates, their compiled patterns and the links each names are one table
  (`extensionLinkCases.fixture.ts`) that this matcher and the server's
  compiler and matcher are both held to.
- The server's tracker list changes while the app runs: an extension that
  serves a tracker is approved, paused, removed, or connects its first server
  (which fixes its link patterns). The server announces each with
  `openchamber:tracker-providers-changed` on the event stream, and
  `useTrackerProviderSync` (mounted once in `App` and `MobileApp`) answers it,
  and the stream's reconnect, with `refreshTrackers`, so the registry and every
  auth status follow. A tracker that leaves the list reads as
  `unknownTrackerDescriptor` wherever an item still names it: its items stay in
  the session's linked items and the tracked list, unavailable until the
  extension is back. VS Code mounts no sync and serves no trackers.
- An extension's tracker is a tracker like any other to every surface: nothing
  reads `isExtensionTrackerId` to change behavior except the Integrations page,
  which draws the card under Extension accounts (`components/sections/`), and
  the card itself, which asks the server for the connect form.
- Persisted identity strings do not change: tracked-items key
  `${provider}|${IDENTIFIER}`, Tracker tab key `${provider}:${IDENTIFIER}`,
  linked id `${provider}:${identifier}`, composer and picker key
  `${provider}:${IDENTIFIER}`, Linear branches `issue-${IDENTIFIER}-<slug>`.
  Data written before trackers (`kind: 'linear'` links, `linear-issue` context
  parts and display types, the board's `linear` tab and `linearTeamId`, tracked
  records without `kind`, live states `{ name, type }` without `category`)
  still reads as Linear's. `legacyLinear.ts` holds Linear's state-type table,
  shared with the web adapter's legacy wire.
- A Linear link is stored and sent as `kind: 'linear'` with `provider: 'linear'`
  beside it (`toStoredLinkedIssue`); other trackers as `kind: 'tracker'`.
  Clients from before trackers read only `linear` and rewrite the list without
  entries they cannot read, so a `tracker` Linear link would vanish for good.
- State looks are by category (`stateLook.ts`): a glyph for lists and status
  menus (in progress open, done merged, canceled closed, the rest not
  started), an issue look for badges (done completed, canceled not planned,
  the rest open), the status menu's order (triage, backlog, todo, in progress,
  done, canceled, unknown last), and settled (done or canceled: not followed).
- Capabilities gate what a surface offers: `stateUpdate` the status menu,
  `children` parent and children, `labels`, `priority`, `filters` the list
  filters, `projectMapping` the container picker and start-in project,
  `multipleAccounts` the account switch, `sessionComments` the session status
  post. A session started before the tracker list is held waits for it
  (bounded, dropped on a runtime switch) before that gate is read.
- Where a tracker is offered depends on sign-in (`sources.ts`):
  `useTrackerSources()` is the served trackers with a connected account, and
  it alone feeds the board's tabs, the composer's attach rows and New
  Worktree's sources, so nothing there shows a tracker that would only ask to
  connect. Settings, Settings search, link matching and name lookups read every
  served tracker (`useTrackerDescriptors()`), since connecting happens there.
  Until a tracker's status answers it is not offered. `useTrackerSourcesPending()`
  says whether that answer may still change (the list or a served tracker's
  status has not arrived), so the board can wait instead of reading "none
  connected"; it asks a served tracker nobody asked yet, and a failed read
  ends the wait without counting as a disconnect.
- A status of `connected: false` may still carry `accounts`: every stored
  account was written off (the server refused its credential). Such a tracker
  is not signed in for any surface; only the Settings card reads the list, to
  show the attention state and let the user remove the account.
- Settings follows the capability gates: one `TrackerSettings` card per served
  tracker (`components/sections/integrations/`), with the account switch and a
  second sign-in only where `multipleAccounts` is set, `TrackerProjectMapping`
  where `projectMapping` is, `TrackerSessionComments` where `sessionComments`
  is, and browser sign-in only where `authMethods` has `oauth`.

## Decisions

### Why descriptors are fetched and only presentation is compiled in

The phone bundles its UI and talks to servers of other versions, so the server
says which trackers exist; a static copy would describe the UI's release. The
snapshot covers first paint. Words and marks cannot come from the server, so a
small per-id table adds them, with a generic fallback.

### Why the agent context text is the neutral item

`buildTrackerItemContextText` sends `<name> issue context (JSON)` followed by
`{ item, comments }` in the neutral tracker shape, so every tracker produces the
same format. It replaced Linear's own field names (`team`, `subIssues`,
numeric priority, comment `user`) and no longer sends the comments twice
(inside the issue and beside it). The header keeps Linear's wording.

### Why the web adapter maps the legacy Linear routes

A server older than `/api/tracker` serves exactly Linear, in Linear's shapes.
Answering only its built-in descriptor would show a Linear tab that fails every
read; the adapter instead reads those routes and maps them to the neutral
shapes, so `packages/ui` never sees which server version answered.

### Why surfaces offer only signed-in trackers and not every served one

Every tracker the server serves used to get a board tab and an attach row
that asked to connect. A server ships trackers whether or not anyone uses
them, so people who never use Linear saw a Linear tab and menu row that led
only to a sign-in prompt. Connecting is a Settings task; the working surfaces
show what the person can already read.
