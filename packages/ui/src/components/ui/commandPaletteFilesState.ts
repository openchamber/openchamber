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

export const scoreCommandPaletteFiles = <T extends { name: string }>(
  fileResults: T[],
  trimmedQuery: string,
  fileSearchKey: string,
  fileResultsKey: string,
): { item: T; score: number }[] => {
  if (!fileSearchKey || fileResultsKey !== fileSearchKey || fileResults.length === 0) {
    return [];
  }

  return scoreByFuzzyQuery(fileResults, trimmedQuery, (file) => file.name, {
    limit: 10,
    threshold: 0.4,
  });
};
