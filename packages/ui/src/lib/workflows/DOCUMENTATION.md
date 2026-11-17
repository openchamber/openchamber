# Workflow client state

## Ownership

This module owns workflow response parsing, event-fed run state, saved-workflow discovery and project scope. The server owns execution and full scripts and answers; the panel owns presentation.

## Invariants

- Failed reads preserve known runs and saved workflows. Events arriving after a read starts supersede that read; monotonically increasing request identities reject responses from retired runtimes, and deleted run IDs never return through a late read.
- Session and project reads merge run by run so independent reads and events cannot erase each other. Turning workflows off marks reads stale without discarding known state, and re-enabling permits fresh admission.
- Projects include sessions in their root and worktrees, while saved scripts remain at the project root. An isolated space keeps its own scope so host scripts and runs cannot leak inside.
- Saved workflow files refresh when a showing surface mounts because agent-created files have no dedicated discovery event. Open workflow tabs retain their entry point; availability remains separate from the user's tool toggle.
- Run reports use a server-authored synthetic-message envelope and metadata identity. Agent spend excludes cache reads and replayed answers so the displayed work reflects this attempt; summaries omit scripts and full answers until requested.
