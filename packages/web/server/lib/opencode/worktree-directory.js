// external: https://opencode.ai/v2/docs/config#worktrees OpenCode appends the worktree name to the configured parent directory.
import os from 'node:os';
import path from 'node:path';

/**
 * Resolve `worktree.directory` into an absolute parent directory.
 *
 * Returns `null` when the setting is absent or not a non-empty string, so
 * callers keep their own default (OpenChamber's data-dir project folder).
 *
 * @param {unknown} config merged OpenCode configuration
 * @param {string} primaryWorktree the project's canonical checkout
 * @param {string} [homeDirectory] overrides the home used for `~` (tests)
 * @returns {string | null}
 */
export function resolveWorktreeDirectory(config, primaryWorktree, homeDirectory = os.homedir()) {
  const worktree = config && typeof config === 'object' ? config.worktree : null;
  const directory = worktree && typeof worktree === 'object' ? worktree.directory : null;
  if (typeof directory !== 'string') {
    return null;
  }

  const trimmed = directory.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === '~') {
    return path.resolve(homeDirectory);
  }
  if (/^~[\\/]/.test(trimmed)) {
    return path.resolve(homeDirectory, trimmed.slice(2));
  }
  return path.resolve(primaryWorktree, trimmed);
}
