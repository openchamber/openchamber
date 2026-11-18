# Changed-files gate

## Ownership

`check-changed.mjs` runs the pre-commit checks and compares lint findings and file sizes with the branch base. Package scripts own the individual checks.

## Invariants

- Dead-code analysis sees the current checkout, including uncommitted and untracked files.
- Knip's gitignore rules must not match ancestors outside the checkout.
- The analysis snapshot retains root and workspace dependencies through links. Cleanup removes only the snapshot, including after a failed check.

## Decisions

### Why Knip runs in a temporary source snapshot

Knip 5.80.0 passes absolute package entry patterns to fast-glob with relative gitignore patterns. The repository's `*.local` rule then matches the `.local` ancestor of OpenCode worktrees and loses package source mappings. A root symlink also produces incorrect results because resolvers canonicalize paths back into the original checkout.

The gate copies regular files, directories and symlinks into a system temporary directory and links each `node_modules` directory. Runtime sockets and other special filesystem entries are skipped because Knip analyzes files and they cannot be copied. Copy-on-write is requested where available. No ignore rules or findings change, and the original checkout stays in place. POSIX uses `/tmp` so a hidden `TMPDIR` cannot reintroduce the failure.
