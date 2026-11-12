import path from 'node:path';

/**
 * Where a session in a worktree starts. A project opened on a folder inside its
 * repository (`repo/ai` rather than `repo`) works from that folder, so a
 * session made here for one of its worktrees starts in the same folder of the
 * checkout, where the OpenCode config lives. The worktree root stays the
 * checkout for Git, bootstrap, removal and carrying changes. The UI applies the
 * same rule to the sessions it creates (`packages/ui/src/lib/worktrees/worktreeStartDirectory.ts`).
 *
 * A folder the checkout lacks, a check that cannot run, or a project folder git
 * cannot report each answer with the worktree root and name the reason, so the
 * caller can report it instead of starting somewhere unexpected.
 *
 * @param {object} dependencies
 * @param {(directory: string) => Promise<{ prefix?: string }>} dependencies.resolveWorktreeTopLevel
 *   `prefix` is where the directory sits inside its checkout, empty at the root; absent when git could not report it.
 * @param {(directory: string, worktreeRoot: string) => Promise<{ valid: boolean, insideWorktreeRoot: boolean }>} dependencies.validateWorktreeDirectory
 * @param {(message: string, error: unknown) => void} [dependencies.warn]
 */
export const createStartDirectoryResolver = ({
  resolveWorktreeTopLevel,
  validateWorktreeDirectory,
  warn = (message, error) => console.warn(message, error instanceof Error ? error.message : String(error)),
}) => {
  /**
   * @param {{ projectPath: string, worktreeRoot: string }} input
   * @returns {Promise<{ directory: string, fallback: null | 'unknown' | 'missing' | 'unverified' }>}
   */
  return async ({ projectPath, worktreeRoot }) => {
    let folder;
    try {
      folder = (await resolveWorktreeTopLevel(projectPath)).prefix;
      // A read that failed answers without a prefix; that is not "at the root".
      if (folder === undefined) throw new Error('git did not report the project folder');
    } catch (error) {
      warn(`Failed to read the folder of ${projectPath} inside its repository; the session starts in the worktree root:`, error);
      return { directory: worktreeRoot, fallback: 'unknown' };
    }
    if (!folder) return { directory: worktreeRoot, fallback: null };

    const candidate = path.join(worktreeRoot, folder);
    try {
      const check = await validateWorktreeDirectory(candidate, worktreeRoot);
      return check.valid && check.insideWorktreeRoot
        ? { directory: candidate, fallback: null }
        : { directory: worktreeRoot, fallback: 'missing' };
    } catch (error) {
      warn(`Failed to check ${candidate}; the session starts in the worktree root:`, error);
      return { directory: worktreeRoot, fallback: 'unverified' };
    }
  };
};
