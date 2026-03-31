import Fuse from "fuse.js";

export interface FuzzySearchOptions {
  threshold?: number;
  distance?: number;
  ignoreLocation?: boolean;
  preferSubstring?: boolean;
}

const DEFAULT_FUZZY_OPTIONS: Required<FuzzySearchOptions> = {
  threshold: 0.4,
  distance: 100,
  ignoreLocation: true,
  preferSubstring: true,
};

export function matchesFuzzyQuery(
  target: string,
  query: string,
  options?: FuzzySearchOptions
): boolean {
  if (!query) {
    return true;
  }
  if (!target) {
    return false;
  }

  const mergedOptions = { ...DEFAULT_FUZZY_OPTIONS, ...options };

  if (mergedOptions.preferSubstring && target.toLowerCase().includes(query.toLowerCase())) {
    return true;
  }

  const fuse = new Fuse([target], {
    threshold: mergedOptions.threshold,
    distance: mergedOptions.distance,
    ignoreLocation: mergedOptions.ignoreLocation,
  });

  return fuse.search(query).length > 0;
}

function getFuzzyMatchMask<T>(
  items: T[],
  query: string,
  getText: (item: T) => string,
  options?: FuzzySearchOptions
): boolean[] {
  if (!query) {
    return items.map(() => true);
  }

  const mergedOptions = { ...DEFAULT_FUZZY_OPTIONS, ...options };
  const queryLower = query.toLowerCase();
  const matches = new Array(items.length).fill(false);
  const fuzzyCandidateTexts: string[] = [];
  const fuzzyCandidateIndices: number[] = [];

  for (let i = 0; i < items.length; i++) {
    const target = getText(items[i]);
    if (!target) {
      continue;
    }

    if (mergedOptions.preferSubstring && target.toLowerCase().includes(queryLower)) {
      matches[i] = true;
      continue;
    }

    fuzzyCandidateTexts.push(target);
    fuzzyCandidateIndices.push(i);
  }

  if (fuzzyCandidateTexts.length === 0) {
    return matches;
  }

  const fuse = new Fuse(fuzzyCandidateTexts, {
    threshold: mergedOptions.threshold,
    distance: mergedOptions.distance,
    ignoreLocation: mergedOptions.ignoreLocation,
  });

  for (const result of fuse.search(query)) {
    matches[fuzzyCandidateIndices[result.refIndex]] = true;
  }

  return matches;
}

export function filterByFuzzyQuery<T>(
  items: T[],
  query: string,
  getText: (item: T) => string,
  options?: FuzzySearchOptions
): T[] {
  const matches = getFuzzyMatchMask(items, query, getText, options);
  const matching: T[] = [];

  for (let i = 0; i < items.length; i++) {
    if (matches[i]) {
      matching.push(items[i]);
    }
  }

  return matching;
}

export function partitionByFuzzyQuery<T>(
  items: T[],
  query: string,
  getText: (item: T) => string,
  options?: FuzzySearchOptions
): { matching: T[]; other: T[] } {
  const matches = getFuzzyMatchMask(items, query, getText, options);
  const matching: T[] = [];
  const other: T[] = [];

  for (let i = 0; i < items.length; i++) {
    if (matches[i]) {
      matching.push(items[i]);
      continue;
    }
    other.push(items[i]);
  }

  return { matching, other };
}
