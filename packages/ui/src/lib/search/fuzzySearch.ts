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

const RANK_TOKEN_MISS = Number.POSITIVE_INFINITY;

const tokenizeRankQuery = (query: string): string[] =>
  query.trim().toLowerCase().split(/\s+/).filter(Boolean);

const compactText = (value: string): string => value.replace(/[^a-z0-9]+/g, '');

type RankFields = { fields: string[]; compact: string[] };

const buildRankFields = (texts: ReadonlyArray<string | null | undefined>): RankFields => {
  const fields: string[] = [];
  const compact: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    const lower = text.toLowerCase();
    fields.push(lower);
    compact.push(compactText(lower));
  }
  return { fields, compact };
};

const scoreRankToken = (token: string, { fields, compact }: RankFields): number => {
  const compactToken = compactText(token);
  let best = RANK_TOKEN_MISS;
  for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex++) {
    const field = fields[fieldIndex];
    const fieldPenalty = fieldIndex * 0.01;
    const idx = field.indexOf(token);
    let score = RANK_TOKEN_MISS;
    if (idx === 0) {
      score = fieldPenalty;
    } else if (idx > 0) {
      const boundary = !/[a-z0-9]/.test(field[idx - 1]);
      score = (boundary ? 0.1 : 0.2) + idx / 1000 + fieldPenalty;
    } else if (compactToken.length > 0) {
      const compactIdx = compact[fieldIndex].indexOf(compactToken);
      if (compactIdx >= 0 && token.length > 1) {
        score = 0.4 + compactIdx / 1000 + fieldPenalty;
      }
    }
    if (score < best) best = score;
  }
  return best;
};

export interface RankByQueryOptions {
  limit?: number;
  fuzzy?: boolean;
}

export function rankByQuery<T>(
  items: readonly T[],
  query: string,
  getTexts: (item: T) => ReadonlyArray<string | null | undefined>,
  options?: RankByQueryOptions,
): T[] {
  const tokens = tokenizeRankQuery(query);
  const limit = options?.limit ?? items.length;
  if (tokens.length === 0) return items.slice(0, limit);

  const scored: { item: T; score: number; order: number }[] = [];
  const missed: { item: T; joined: string; order: number }[] = [];

  for (let order = 0; order < items.length; order++) {
    const item = items[order];
    const rankFields = buildRankFields(getTexts(item));
    let total = 0;
    for (const token of tokens) {
      const tokenScore = scoreRankToken(token, rankFields);
      if (tokenScore === RANK_TOKEN_MISS) {
        total = RANK_TOKEN_MISS;
        break;
      }
      total += tokenScore;
    }
    if (total === RANK_TOKEN_MISS) {
      missed.push({ item, joined: rankFields.fields.join(' '), order });
    } else {
      scored.push({ item, score: total, order });
    }
  }

  const fuzzyEnabled = options?.fuzzy ?? true;
  if (fuzzyEnabled && tokens.length === 1 && tokens[0].length >= 3 && missed.length > 0) {
    const fuse = new Fuse(
      missed.map((entry) => entry.joined),
      { threshold: 0.35, ignoreLocation: true, distance: 100, includeScore: true, minMatchCharLength: 2 },
    );
    for (const result of fuse.search(tokens[0])) {
      const entry = missed[result.refIndex];
      scored.push({ item: entry.item, score: 1 + (result.score ?? 1), order: entry.order });
    }
  }

  scored.sort((a, b) => (a.score - b.score) || (a.order - b.order));
  return scored.slice(0, limit).map((entry) => entry.item);
}

export function matchesRankQuery(
  texts: ReadonlyArray<string | null | undefined>,
  query: string,
  options?: { wordStart?: boolean },
): boolean {
  const tokens = tokenizeRankQuery(query);
  if (tokens.length === 0) return true;
  const rankFields = buildRankFields(texts);
  if (options?.wordStart) return tokens.every((token) => matchesTokenAtWordStart(token, rankFields));
  return tokens.every((token) => scoreRankToken(token, rankFields) !== RANK_TOKEN_MISS);
}

export const SIDEBAR_SEARCH = { wordStart: true } as const;

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

const matchesTokenAtWordStart = (token: string, { fields }: RankFields): boolean => {
  const compactToken = compactText(token);
  return fields.some((field) => {
    for (let index = 0; index < field.length; index += 1) {
      if (index > 0 && WORD_CHARACTER.test(field[index - 1])) continue;
      if (field.startsWith(token, index)) return true;
      if (token.length > 1 && compactToken.length > 0 && compactText(field.slice(index)).startsWith(compactToken)) return true;
    }
    return false;
  });
};

