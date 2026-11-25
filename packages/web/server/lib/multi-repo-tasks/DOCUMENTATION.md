# Multi-repo tasks

## Ownership

A multi-repo task is a plain folder holding one git worktree per repository a
piece of work touches, all on one branch named after the task. This module
creates, inspects and deletes those folders (`/api/projects/multi-repo-tasks/*`). The
Add project dialog's "Multi-repo task" view and the sidebar's Close project
(`packages/ui/src/components/session/MultiRepoTaskPane.tsx`,
`SessionProjectScroller.tsx`) are its only callers; registering the folder as a
project stays with the projects store.

A task folder is recognised by `.openchamber-task.json` (`version`, `branch`,
`reposDir`, and `copied` when files were copied in). Its `AGENTS.md` tells the
agent which repositories are in the task, where the others live, and how to add
one. The branch is the optional prefix plus the task name.

A worktree gets the git-ignored local files its main checkout lists in
`.worktreeinclude` (`.gitignore` syntax), such as `.env` or `local.properties`,
and its submodules initialised. Only ignored files are copied, so a copy never
shows as an untracked change and `git worktree remove` can delete it.

## Invariants

- Creation fetches every selected repository first and starts each worktree from
  `origin/HEAD`; a failed fetch stops creation, so a task never starts from a
  stale default branch without saying so.
- Branches are created with `--no-track`, so a plain `git push` never targets the
  default branch.
- A failure part-way through creation removes the worktrees and branches it made,
  including a branch whose worktree checkout failed, and the folder; what it
  could not remove is listed in `problems`.
- VS Code has no task routes, so Close project there only closes the project;
  a server without the routes answers the inspection with 404, read as "not a
  task".
- Deletion refuses while any worktree or submodule has uncommitted or
  untracked files, a commit no remote has (in a submodule, on any of its local
  branches), or the folder holds anything besides the marker, `AGENTS.md`,
  worktrees and `.DS_Store`. Status runs with `--ignore-submodules=none` and
  `--untracked-files=normal`, so a repository's own status settings cannot hide
  work from it. It removes the folder
  with `rmdir`, so nothing outside the worktrees is deleted.
- Files Git ignores inside a worktree or its submodules (build output, a
  hand-made `.env`) do not block deletion, and `git worktree remove` deletes
  them, so the inspection lists all of them and the confirmation names them. A file copied from
  `.worktreeinclude` and unchanged since is left out of that list; once edited it
  is listed like any other.
- `--force` is passed only for a worktree that has submodules, which Git refuses
  to remove otherwise; the inspection has already checked it and each submodule.
- The task's local branch is deleted only when every commit on it is on a remote.

## Decisions

### Why worktrees are found by scanning the folder and not from the marker

The agent may add a repository mid-task with `git worktree add` (the command is
in `AGENTS.md`). Reading each subfolder's `--git-common-dir` finds those too, so
deletion covers every worktree the folder really holds.

### Why ignored files are named in the confirmation and do not block deletion

Nearly every worktree that was built holds ignored output (`node_modules/`,
`build/`), so blocking on them would block every deletion. Naming them in the
confirmation lets the person keep a hand-made ignored file with Close only.

### Why the routes live under `/api/projects` and register from the projects routes

A task becomes a project, and `/api/projects` already gets the server's common
request handling, so the routes need no entry of their own in the server frame.
None of the existing `/api/projects/:projectId/...` routes matches
`multi-repo-tasks` followed by `repositories`, `inspect` or `remove`.

### Why the folder is not a git repository

OpenChamber's Git, diff and PR views offer a repository picker only when the
project root is not itself a repository; a root repository would hide the
worktrees inside it.
