import { rankBySubsequence, type RankedMatch } from '@/lib/search/subsequenceSearch';

export const buildCommandPaletteFileSearchKey = (
  currentRoot: string | null,
  trimmedQuery: string,
): string => {
  if (!currentRoot || trimmedQuery.length === 0) {
    return '';
  }

  return JSON.stringify([currentRoot, trimmedQuery]);
};

export const scoreCommandPaletteFiles = <T extends { name: string; relativePath: string }>(
  fileResults: T[],
  trimmedQuery: string,
  fileSearchKey: string,
  fileResultsKey: string,
): RankedMatch<T>[] => {
  if (!fileSearchKey || fileResultsKey !== fileSearchKey || fileResults.length === 0) {
    return [];
  }

  // Matches in the file name rank first, but the whole relative path counts:
  // "solo-is-a" must still find solo-is-a-team-size/index.md.
  return rankBySubsequence(fileResults, trimmedQuery, (file) => file.relativePath || file.name, { limit: 10, paths: true });
};
