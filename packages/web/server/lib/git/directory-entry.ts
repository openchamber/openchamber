export const GIT_PATH_NOT_FOUND = 'path_not_found';
export const GIT_PATH_IS_NESTED_REPOSITORY = 'nested_repository';
export const GIT_PATH_IS_UNTRACKED_DIRECTORY = 'untracked_directory';

const GIT_PATH_ERROR_MESSAGES = {
  [GIT_PATH_IS_NESTED_REPOSITORY]: (filePath: string) => `Path is a separate Git repository: ${filePath}`,
  [GIT_PATH_IS_UNTRACKED_DIRECTORY]: (filePath: string) => `Path is a directory of untracked files: ${filePath}`,
  [GIT_PATH_NOT_FOUND]: (filePath: string) => `Path not found in working tree, index, or HEAD: ${filePath}`,
};

export const createGitPathError = (code: keyof typeof GIT_PATH_ERROR_MESSAGES, filePath: string) => Object.assign(new Error(GIT_PATH_ERROR_MESSAGES[code](filePath)), { code });

type ListFiles = (cwd: string, args: string[], options: { timeoutMs: number }) => Promise<{ success: boolean; stdout: string; message?: string }>;

const LISTING_TIMEOUT_MS = 60_000;

export const resolveDirectoryEntry = async (runGitCommand: ListFiles, repoRoot: string, repoPath: string, absolutePath: string) => {
  const entry = `${repoPath}/`;
  const listing = await runGitCommand(repoRoot, ['ls-files', '-o', '--exclude-standard', '-z', '--', `:(literal)${entry}`], { timeoutMs: LISTING_TIMEOUT_MS });
  if (!listing.success) throw new Error(listing.message || `Failed to list ${entry}`);
  if (listing.stdout.split('\0').some((file) => file.endsWith('/'))) return null;
  return { absolutePath, repoPath: entry, repoRoot, isSymbolicLink: false, isSubmodule: false };
};

export const expandDirectoryEntries = (selected: string[], changed: string[]) => changed.filter((file) => selected.some((entry) => (
  entry.endsWith('/') ? file.startsWith(entry) : file === entry
)));
