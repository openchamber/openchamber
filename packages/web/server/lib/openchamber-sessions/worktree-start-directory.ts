import path from 'node:path';

export interface StartDirectoryResult {
  directory: string;
  fallback: null | 'unknown' | 'missing' | 'unverified';
}

interface StartDirectoryDependencies {
  resolveWorktreeTopLevel: (directory: string) => Promise<{ prefix?: string }>;
  validateWorktreeDirectory: (directory: string, worktreeRoot: string) => Promise<{ valid: boolean; insideWorktreeRoot: boolean }>;
  warn?: (message: string, cause: unknown) => void;
}

export const createStartDirectoryResolver = ({
  resolveWorktreeTopLevel,
  validateWorktreeDirectory,
  warn = (message, error) => console.warn(message, error instanceof Error ? error.message : String(error)),
}: StartDirectoryDependencies) => {
  return async ({ projectPath, worktreeRoot }: { projectPath: string; worktreeRoot: string }): Promise<StartDirectoryResult> => {
    let folder;
    try {
      folder = (await resolveWorktreeTopLevel(projectPath)).prefix;
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
