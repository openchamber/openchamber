import { getRelativeFilePath, isFilePathWithinDirectory } from '@/lib/path-utils';

type GitBaselineTarget = { directory: string; relativePath: string };

const EXACT_FILE_NAME = { preserveWhitespace: true };

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
