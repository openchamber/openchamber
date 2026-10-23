# Sidebar works

The desktop and web sidebar lists works. This folder owns what a work is and
the rows that only works have; the sidebar's `DOCUMENTATION.md` (Works, One
view, In work, Drafts, Folders with worktrees) describes how they are laid out.

- `sidebarWorks.ts`: which work each listed session belongs to
  (`buildSidebarWorkIndex`, from the project sections) and works in order
  (`orderSidebarWorks`, by the first of their sessions in the lifecycle order).
  A work is a linked worktree's group (`isWorktreeWorkGroup`: not the root, not
  a space, not an archive) with every session in it, or a root session of the
  project root or a space with what nests under it. Work keys are
  `<projectId>:<groupId>` for a worktree (the group key the row model already
  uses, so collapse state is shared) and `session:<id>` for a session.
  `worktreeFolderMemberId` is a worktree's member id in a root folder.
- `workActions.ts`: the session a click opens (`pickWorkSessionToOpen`: past
  reviews and forks, newest first), Track, and Done on a worktree work
  (`finishWorktreeWork`: sessions done, then the Overview's clean up, which
  removes the worktree only when nothing is lost).
- `WorktreeWorkRow.tsx`: a worktree's work row, in its project, in a folder or
  in a zone (`mixed`).
- `SessionDraftRow.tsx`, `openSessionDraft.ts`: a left draft's row and
  reopening it in the composer.

Invariants:

- Lineage is display only (`lib/sessionWorkLineage.ts`). Archive, restore,
  move and the Archive page follow OpenCode's `parentID`.
- The folder decides before origin: a session never nests under a session of
  another folder, so a worktree's sessions are all of that worktree's work.
- A subagent's work state never puts a work in work and is not counted on a
  folded row.
- VS Code has no worktree works and no server drafts; it keeps works in work
  in their projects.
