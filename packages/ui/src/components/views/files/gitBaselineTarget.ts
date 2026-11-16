import { getRelativeFilePath, isFilePathWithinDirectory } from '@/lib/path-utils';

type GitBaselineTarget = { directory: string; relativePath: string };

// Whitespace at the end of an open file's path is part of its name.
const EXACT_FILE_NAME = { preserveWhitespace: true };

/**
 * Where the editor's change markers read an open file's git baseline: the
 * repository selected in Changes when it holds the file, else the project
 * folder. A project folder need not be a repository itself.
 */
export const gitBaselineTarget = (
  filePath: string | null | undefined,
  projectDirectory: string,
  selectedRepository: string | null,
): GitBaselineTarget | null => {
  if (!filePath) return null;
  const directory = selectedRepository && isFilePathWithinDirectory(filePath, selectedRepository, EXACT_FILE_NAME)
    ? selectedRepository
    : projectDirectory;
  if (!directory || !isFilePathWithinDirectory(filePath, directory, EXACT_FILE_NAME)) return null;
  return { directory, relativePath: getRelativeFilePath(filePath, directory, EXACT_FILE_NAME) };
};
