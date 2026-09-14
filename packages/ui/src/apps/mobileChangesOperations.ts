export type GitFileRevertFailure = {
  path: string;
  error: Error | null;
};

export async function settleGitFileReverts(
  paths: string[],
  revertFile: (path: string) => Promise<void>,
): Promise<{ paths: string[]; failures: GitFileRevertFailure[] }> {
  const uniquePaths = Array.from(new Set(paths));
  const failures: GitFileRevertFailure[] = [];

  await Promise.all(uniquePaths.map(async (path) => {
    try {
      await revertFile(path);
    } catch (error) {
      failures.push({ path, error: error instanceof Error ? error : null });
    }
  }));

  return { paths: uniquePaths, failures };
}
