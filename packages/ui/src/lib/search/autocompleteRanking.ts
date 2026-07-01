import { scoreByFuzzyQuery } from '@/lib/search/fuzzySearch';

type Ranked<T> = { item: T; score: number };

type RankAutocompleteOptions<T> = {
  threshold?: number;
  limit?: number;
  noFuzzy?: boolean;
  compare?: (a: T, b: T) => number;
};

/**
 * Shared autocomplete ranking helper built on top of scoreByFuzzyQuery.
 *
 * When query is empty, returns items sorted by compare (or unsorted if no compare).
 * When query is non-empty, delegates to scoreByFuzzyQuery and applies compare as a
 * secondary tiebreaker after score.
 */
export function rankAutocompleteItems<T>(
  items: T[],
  query: string,
  getText: (item: T) => string,
  options: RankAutocompleteOptions<T> = {},
): T[] {
  const normalizedQuery = query.trim();

  if (!normalizedQuery) {
    return options.compare ? [...items].sort(options.compare) : items;
  }

  const ranked = scoreByFuzzyQuery(
    items,
    normalizedQuery,
    getText,
    {
      threshold: options.threshold ?? 0.4,
      limit: options.limit,
      noFuzzy: options.noFuzzy,
    },
  );

  if (options.compare) {
    const compare = options.compare;
    ranked.sort((a: Ranked<T>, b: Ranked<T>) => {
      if (a.score !== b.score) return a.score - b.score;
      return compare(a.item, b.item);
    });
  }

  return ranked.map((r) => r.item);
}
