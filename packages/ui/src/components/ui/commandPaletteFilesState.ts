import { scoreByFuzzyQuery } from '@/lib/search/fuzzySearch';

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
): { item: T; score: number }[] => {
  if (!fileSearchKey || fileResultsKey !== fileSearchKey || fileResults.length === 0) {
    return [];
  }

  // Score against the full relative path: queries like "solo-is-a" must match
  // solo-is-a-team-size/index.md even though the basename is just index.md.
  return scoreByFuzzyQuery(fileResults, trimmedQuery, (file) => file.relativePath || file.name, {
    limit: 10,
    threshold: 0.4,
  });
};
