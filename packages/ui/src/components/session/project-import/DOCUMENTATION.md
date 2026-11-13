# OpenCode projects in Add project

## Ownership

The Add project dialog owns the "From OpenCode" entry. OpenCode supplies its
project list; this module turns it into repositories worth offering. Adding them
is the dialog's ordinary batch add. VS Code uses workspace folders and does not
show the entry, and neither does the folder choice of Move session.

## Invariants

- Only an open Add project dialog reads the list. Startup, sidebar updates and a
  closed dialog perform no discovery.
- Only git repositories are offered. Configured projects, filesystem roots,
  managed chats, duplicates, anything under a hidden, temporary or system folder
  and folders whose availability cannot be confirmed are left out.
- Nothing is added without the person selecting it, and the entry shows only
  while there is something to offer. An empty or failed read hides it; the next
  opening reads again.
- Runtime changes reject late results.

## Decisions

### Why a filtered list and not everything OpenCode knows

`project.list` holds every folder OpenCode ever started in: one machine carried
804 records, of which 45 still existed, including home, OpenCode's own config,
VS Code storage and archived isolated spaces. OpenCode's own app shows only the
projects a client used and keeps that list on the client, so the server's list
says where OpenCode ran, not what the person works on. Requiring a repository
outside machine folders leaves the real projects.

### Why a place in the dialog and not a one-time import

Adding everything in one click put that whole list in the sidebar, and a banner
inside the folder list pushed the folders down until dismissed for good. A
selectable list costs nothing while unused, so it needs no dismissal, no
completion flag and no special saving path.
