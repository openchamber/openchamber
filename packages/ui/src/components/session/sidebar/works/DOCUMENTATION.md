# Sidebar works

The sidebars of the desktop, the web and the phone list works. This folder owns what a work is and
the rows that only works have; the sidebar's `DOCUMENTATION.md` (Works, One
view, In work, Drafts, Folders with worktrees) describes how they are laid out.

- `sidebarWorks.ts`: which work each listed session belongs to
  (`buildSidebarWorkIndex`, from the project sections) and works in order
  (`orderSidebarWorks`, by the first of their sessions in the lifecycle order;
   In work's selection is `orderInWorkWorks`, where a session must resolve to a
   registered project work, directly or through its top-level session),
  and where a worktree's archived sessions hold it in that order
  (`buildWorktreeArchiveAnchors`), so archiving does not move a worktree.
  By project and custom time sections (`anchors`) take the gaps between root
  sessions, and worktrees in the same gap keep the project's order. The list
  by time (`timelineAnchors`) takes the gaps between top-level rows, so a
  subagent shown at the top level because its parent is not loaded counts as
  one and a nested one does not, and worktrees in the same gap keep the order
  of their archived sessions, newest first.
  A work is a linked worktree's or an isolated space's group (`isGroupWork`:
  not the root, not an archive) with every session in it, or a root session of
  the project root with what nests under it. Work keys are
  `<projectId>:<groupId>` for a worktree or a space (the group key the row
  model already uses, so collapse state is shared) and `session:<id>` for a
  session. `worktreeFolderMemberId` is a worktree's or a space's member id in
  a root folder.
- `workActions.ts`: the session a click opens (`pickWorkSessionToOpen`: past
  reviews and forks, newest first), Track, and Done on a worktree work
  (`finishWorktreeWork`: sessions done, the work left, and with `archive` the
  worktree archived with its sessions) or a space work (`finishSpaceWork`:
  sessions done, the work left and the space stopped unless an agent still
  works in it; the space stays). Bulk Mark done from the sidebar's bulk bar
  (`markSessionsDone`) marks the selected sessions, then runs that same Done
  on each work it finished whole (`selectFinishedWorks`, `finishBulkDoneWork`).
- `useWorktreeWork.ts`, `useSessionDraftRow.ts`: what a worktree's or a
  space's work row and a draft's row know and do (the label, selection, open,
  Done, Archive, rename; open and discard), shared by the desktop's rows and
  the phone's (`apps/mobileSidebar/MobileWorkRows.tsx`), which differ only in
  how they are drawn and used.
- `WorktreeWorkRow.tsx`: the desktop's worktree or space work row, in its
  project, in a folder or in a zone (`mixed`). A space's state and actions
  come from `components/session/spaces` (`SpaceStatus.tsx`, `SpaceActions.tsx`).
- `SessionDraftRow.tsx`, `openSessionDraft.ts`: the desktop's row of a left
  draft and reopening it in the composer.

Invariants:

- Draft restoration cites every attachment in its text because sending includes
  only cited files. Server attachments can arrive later; they apply only while
  that same draft is still open, and a failed download leaves other files usable.
- A session or worktree keeps a folder membership only for display under that
  folder's own project. Adding a nested directory as a project leaves old stored
  membership intact without displaying the work under its former project.
- Bulk Done captures works before writes can remove them from In work. A runtime
  change, including switching away and back, stops queued writes and suppresses
  results for the new runtime; a failed session never blocks unrelated successes.
- Done leaves a work before optional worktree archival, because archival cannot
  remove the checkout still on screen. Busy or unreadable activity keeps the
  worktree after its sessions leave In work.
- Display lineage belongs to `lib/sessionWorkLineage.ts`. Archive, delete and
  restore follow OpenCode's `parentID` plus linked reviews. Forks and promoted
  `/btw` conversations remain independent; move also carries the rendered tree.
- The folder decides before origin: a session never nests under a session of
  another folder, so a worktree's sessions are all of that worktree's work.
- A subagent's work state never puts a work in work and is not counted on a
  folded row.
- VS Code has no worktree works and no server drafts; it keeps works in work
  in their projects.
