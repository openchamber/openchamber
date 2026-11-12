/**
 * Resolve OpenCode's `worktree.directory` into the absolute parent directory for
 * new worktrees. Returns null when the setting is absent or not a non-empty
 * string, so the caller keeps its own default.
 */
export function resolveWorktreeDirectory(
  config: unknown,
  primaryWorktree: string,
  homeDirectory?: string,
): string | null;
