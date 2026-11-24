import path from 'node:path';

import { canonicalizeWith, type SessionDirectoryCanonicalizer } from '../opencode/directory-canonicalization.js';

export interface StartDirectoryResult {
  directory: string;
  fallback: null | 'unknown' | 'missing' | 'unverified';
}

interface StartDirectoryDependencies {
  resolveWorktreeTopLevel: (directory: string) => Promise<{ prefix?: string }>;
  validateWorktreeDirectory: (directory: string, worktreeRoot: string) => Promise<{ valid: boolean; insideWorktreeRoot: boolean }>;
  warn?: (message: string, cause: unknown) => void;
  getSessionDirectoryCanonicalizer?: SessionDirectoryCanonicalizer | null;
}

export const createStartDirectoryResolver = ({
  resolveWorktreeTopLevel,
  validateWorktreeDirectory,
  warn = (message, error) => console.warn(message, error instanceof Error ? error.message : String(error)),
  getSessionDirectoryCanonicalizer = null,
}: StartDirectoryDependencies) => {
  const resolveFolder = async ({ projectPath, worktreeRoot }: { projectPath: string; worktreeRoot: string }): Promise<StartDirectoryResult> => {
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
  return async (input: { projectPath: string; worktreeRoot: string }): Promise<StartDirectoryResult> => {
    const start = await resolveFolder(input);
    return { ...start, directory: await canonicalizeWith(getSessionDirectoryCanonicalizer?.(), start.directory) };
  };
};
