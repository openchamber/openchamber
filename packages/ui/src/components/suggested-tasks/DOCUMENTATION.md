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

## Decisions

### Why Configure is a dialog on phones too

On phones the scheduled task editor opens as a bottom sheet. The lens editor
this form opens is a dialog, and the sheet sits above dialogs, so the form
stays in a dialog and the lens editor stacks above it.

### Why the settings left Settings → Projects

Two places showed the same form: the inbox's Configure and a tab in Settings →
Projects, which phones do not have. The tab is gone, so the settings live where
the suggestions are, as scheduled tasks keep theirs on their own page.
