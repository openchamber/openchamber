# Suggested tasks UI

The inbox page, the Configure dialog that holds a project's settings, and the
lens editor. The server side, the scan and the inbox file are in
`packages/web/server/lib/suggested-tasks/DOCUMENTATION.md`; the stores are in
`packages/ui/src/stores/DOCUMENTATION.md`.

## Ownership

- `SuggestedTasksPage.tsx`: the page. On desktop it is a `ProjectRailPage`
  over the chat area; the phone shell mounts `SuggestedTasksView` with
  `layout="mobile"` and a project picker.
- `SuggestedTasksInbox.tsx`: one project's inbox, its scan button and
  Configure.
- `SuggestedTasksSettingsDialog.tsx` and `SuggestedTasksSettingsForm.tsx`:
  Configure. The inbox opens it, and so does Edit on the scan's row of the
  Scheduled tasks page (`components/session/ScheduledTasksDialog.tsx`).
- `SuggestedLensEditorDialog.tsx`, `suggestedLensActions.ts`: one lens and the
  wording of what a lens does with its suggestions.
- `sections/shared/McpToolPermissionsEditor.tsx`: explicit per-tool MCP rules,
  project catalog reads and manual names for external OpenCode. It edits a
  controlled value and leaves persistence to its caller.

## Invariants

- Configure is the only place the settings are edited, on every runtime with
  the inbox, phones included. Settings → Projects has no Suggested tasks tab,
  and Settings search has no entries for these settings.
- The form keeps the Settings primitives (`components/sections/shared`), so it
  reads like the rest of Settings, but it is not a Settings page.
- Visits are keyed by runtime lifetime and project
  (`useSuggestedTasksRuntime`), so an old load or action cannot replace
  another project's form or navigate another inbox visit.
- Settings writes are serialized by `useSuggestedTasksSettingsStore`; closing
  the dialog does not discard edits already admitted.
- Worktree and draft-PR actions require `checkIsGitRepository` to confirm the
  project's directory. Lens model and agent pickers read the edited project's
  catalogs.
- A missing tool rule means deny. New catalog tools stay marked New until an
  explicit rule is saved. Saved tools missing from the catalog stay editable.
  Bulk actions affect the displayed server's known and saved tools only.
- Catalog reads belong to the open editor's project and runtime. Loading and
  failed reads never clear saved rules; refresh is an explicit action.
- Automatic-session permissions are separate from scan permissions. The picker
  is visible for session, worktree and draft-PR actions. Safety uses the same
  classification availability as the composer; Auto keeps its warning visible.
- Evidence stays expanded as plain source names and summaries. Only HTTP(S)
  evidence URLs become links, after parsing in `lib/suggestedTasksApi.ts`.
- Bot handoff reads definitions only after the user opens its picker. The read
  belongs to that mounted runtime/project visit; only enabled definitions can
  be submitted. Failed reads remain errors with an explicit retry.
- The source approval route owns conversion. The UI sends
  `{ action: 'bot', botId }` and applies only its parsed `{ suggestion }`
  response. The route must retain source identity, files and evidence when
  admitting the bot item. No direct bot-item POST or local suggestion-status
  write occurs.
- Persisted bot conversions use `{ kind: 'bot', botId, itemId }`.
  `lib/suggestionSchema.ts` normalizes them to the UI's `kind: 'bot'` variant;
  legacy `kind` conversions keep their existing shape. A successful handoff must
  return the requested suggestion and bot with a nonempty item ID.
- An admitted handoff locks its bot for that inbox visit, including after an
  unknown response or closing and reopening the picker. Pending submissions
  disable dismissal and bot changes. Failed responses preserve the source and
  offer a retry with the same source path and bot; server idempotency owns the
  stable admission key. The UI does not infer that a failed response undid work.
- Bot-item links set `botsPageTarget` with the source project and returned item.
  Web and Electron open the Bots page; hosted mobile and Capacitor use the
  mobile `openBots` action. Neither path invokes a source close callback after
  opening the destination. VS Code exposes no bot handoff or item link.
- Scheduled rows with `botManaged: true` require a nonempty `botId`. They offer
  Run now and Edit only. Edit targets that exact bot definition and never opens
  the scheduled-task editor; Run now stays on the page even when the response
  names a stage session. Ordinary rows and Suggested tasks scan Configure keep
  their existing behavior. The server enforces managed-row write restrictions.

## Decisions

### Why Configure is a dialog on phones too

On phones the scheduled task editor opens as a bottom sheet. The lens editor
this form opens is a dialog, and the sheet sits above dialogs, so the form
stays in a dialog and the lens editor stacks above it.

### Why the settings left Settings → Projects

Two places showed the same form: the inbox's Configure and a tab in Settings →
Projects, which phones do not have. The tab is gone, so the settings live where
the suggestions are, as scheduled tasks keep theirs on their own page.

### Why tool rules are explicit and the catalog is on demand

MCP's tool registry does not distinguish reads from writes. A new tool defaults
to deny, and the warning states that enabled tools may write. Reads run only
while this editor is open and on explicit refresh, so unopened projects do not
start MCP servers. External OpenCode accepts manual server and tool names.

### Why automatic permissions preserve the session default

`default` leaves the created session's policy to Settings. A saved Safety choice
survives temporary classifier unavailability; the editor disables choosing it
and explains the requirement without rewriting the stored choice.

### Why the source approval route owns bot handoff

Suggestion reservation and bot admission share a server operation and stable
source key. Sending only the chosen bot to that owner preserves the original
evidence and lets an unknown response retry without creating another item.

## Integration validation

Focused component/HTTP tests exercise desktop and mobile handoff, enabled-only
choices, on-demand reads, retained evidence, unknown-response retry, persisted
item navigation and the managed schedule's exact-bot Edit and Run now behavior.
These fixtures establish the UI contracts, not production admission or paint.

Combined backend/browser QA remains with the coordinator. With an enabled bot,
send an evidence-bearing suggestion and inspect its source, files and evidence
in the resulting Bots item. Repeat after a lost response, reopen the Approved
card, and confirm one item. From Scheduled tasks, edit that bot's managed row,
run it, and verify no task editor, pause, delete or session shortcut appears.
Repeat on desktop and mobile, in both themes and RTL. Switch project/runtime
while the picker loads and while approval waits; neither old visit may navigate
the new one. Verify Select arrows and Ctrl+N/P, focus return and narrow-screen
popup placement. Builds and production browser audits belong to that combined QA.
