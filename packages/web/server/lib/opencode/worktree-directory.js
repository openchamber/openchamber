/**
 * OpenCode's `worktree.directory` setting decides where new worktrees land.
 * This module owns the path rule so the web server and the VS Code extension
 * host agree on one location: relative paths start at the project's canonical
 * checkout, absolute paths are used as-is, and a leading `~` means the user's
 * home directory. OpenCode appends the requested or generated worktree name, so
 * the resolved value is always the parent directory, never the worktree itself.
 *
 * The function is pure (no filesystem access) so `packages/vscode` can bundle it
 * through `packages/vscode/src/worktree-directory.ts`, matching the shared
 * config-shape modules beside it.
 *
 * Reference: https://opencode.ai/v2/docs/config#worktrees
 */
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
