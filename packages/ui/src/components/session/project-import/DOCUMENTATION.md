# OpenCode project import

## Ownership

The Add project dialog owns the one-time import suggestion. OpenCode supplies
canonical project folders; the projects store adds them and settings persistence
saves the list. The instance-scoped `openCodeProjectImportCompleted` flag retires
the suggestion after import or explicit dismissal on any client of that server.
VS Code uses workspace folders and does not mount the suggestion.

## Invariants

- Only an open Add project dialog reads import candidates. Startup, sidebar
  updates, and a retired suggestion perform no import discovery.
- Existing projects, filesystem roots, managed chats, duplicate paths and folders
  whose availability cannot be confirmed are not offered. Worktrees remain with
  their canonical project. Existing names and order remain intact.
- Closing the dialog does not dismiss the suggestion. Empty or failed reads do
  not retire it. Reopening retries reads; a failed save keeps the actions available.
- The project list and import completion flag use one settings write. A failed
  write does not add optimistic projects. Runtime changes reject late results.
- Quick add is blocked while the import saves, so an ordinary folder addition
  cannot replace the pending imported project list in the settings queue. The
  runtime-scoped guard survives closing and reopening until the write settles,
  including failure. A previous runtime's completion cannot release a new import.

## Decisions

### Why the suggestion belongs to Add project and not startup

The accepted feature is an explicit one-time import. Opening Add project provides
that intent and avoids a permanent sidebar dependency on OpenCode's project list.

### Why pending import state belongs to the dialog owner

The suggestion unmounts when the dialog closes, while its settings write continues.
Keeping its guard in the mounted dialog owner prevents reopening from allowing a
conflicting addition. Ordinary confirmation state still resets on opening.
