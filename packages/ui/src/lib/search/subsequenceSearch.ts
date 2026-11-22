import type { MatchRange } from './matchSegments';


const SCORE_MATCH = 16;
const GAP_START = -3;
const GAP_EXTENSION = -1;
const BONUS_AFTER_WHITESPACE = 10;
const BONUS_AFTER_DELIMITER = 9;
const BONUS_AFTER_PUNCTUATION = 8;
const BONUS_CAMEL = 7;
const BONUS_CONSECUTIVE = -(GAP_START + GAP_EXTENSION);
const FIRST_LETTER_MULTIPLIER = 2;

const CharClass = { Whitespace: 0, Delimiter: 1, Punctuation: 2, Lower: 3, Upper: 4, Digit: 5 } as const;
type CharClass = (typeof CharClass)[keyof typeof CharClass];

const classify = (char: string): CharClass => {
  if (char === '/' || char === '\\') return CharClass.Delimiter;
  if (char >= '0' && char <= '9') return CharClass.Digit;
  if (char !== char.toLowerCase()) return CharClass.Upper;
  if (char !== char.toUpperCase()) return CharClass.Lower;
  return char.trim() === '' ? CharClass.Whitespace : CharClass.Punctuation;
};

const positionBonuses = (text: string): Int8Array => {
  const bonuses = new Int8Array(text.length);
  let previous: CharClass = CharClass.Whitespace;
  for (let index = 0; index < text.length; index++) {
    const current = classify(text[index]);
    const isLetterOrDigit = current >= CharClass.Lower;
    if (isLetterOrDigit && previous === CharClass.Whitespace) bonuses[index] = BONUS_AFTER_WHITESPACE;
    else if (isLetterOrDigit && previous === CharClass.Delimiter) bonuses[index] = BONUS_AFTER_DELIMITER;
    else if (isLetterOrDigit && previous === CharClass.Punctuation) bonuses[index] = BONUS_AFTER_PUNCTUATION;
    else if (current === CharClass.Upper && previous === CharClass.Lower) bonuses[index] = BONUS_CAMEL;
    else if (current === CharClass.Digit && (previous === CharClass.Lower || previous === CharClass.Upper)) bonuses[index] = BONUS_CAMEL;
    else if (current === CharClass.Upper && previous === CharClass.Upper && index + 1 < text.length
      && classify(text[index + 1]) === CharClass.Lower) bonuses[index] = BONUS_CAMEL;
    else if (current === CharClass.Punctuation) bonuses[index] = BONUS_AFTER_PUNCTUATION;
    previous = current;
  }
  return bonuses;
};

const lowerPerPosition = (text: string): string => {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let result = '';
  for (const char of text) {
    const lowered = char.toLowerCase();
    result += lowered.length === char.length ? lowered : char;
  }
  return result;
};

type Prepared = { lower: string; bonuses: Int8Array };

type TokenMatch = { score: number; positions: number[] };

const isSubsequence = (lower: string, token: string): boolean => {
  let at = 0;
  for (const char of token) {
    at = lower.indexOf(char, at);
    if (at < 0) return false;
    at += 1;
  }
  return true;
};

const alignToken = ({ lower, bonuses }: Prepared, token: string): TokenMatch | null => {
  const m = token.length;
  const n = lower.length;
  const scores = new Float64Array(m * n).fill(Number.NEGATIVE_INFINITY);
  const runBonuses = new Int8Array(m * n);
  const previousAt = new Int32Array(m * n).fill(-1);

  for (let j = 0; j < n; j++) {
    if (lower[j] === token[0] && bonuses[j] >= BONUS_CAMEL) {
      scores[j] = SCORE_MATCH + bonuses[j] * FIRST_LETTER_MULTIPLIER;
      runBonuses[j] = bonuses[j];
    }
  }

  for (let i = 1; i < m; i++) {
    const row = i * n;
    const previousRow = row - n;
    let gapBest = Number.NEGATIVE_INFINITY;
    let gapBestAt = -1;
    for (let j = i; j < n; j++) {
      if (j >= 2) {
        const fromFurther = gapBest + GAP_EXTENSION;
        const fromAdjacentGap = scores[previousRow + j - 2] + GAP_START;
        if (fromAdjacentGap >= fromFurther) {
          gapBest = fromAdjacentGap;
          gapBestAt = j - 2;
        } else {
          gapBest = fromFurther;
        }
      }
      if (lower[j] !== token[i]) continue;
      const bonus = bonuses[j];
      const viaGap = gapBest + SCORE_MATCH + bonus;
      const consecutive = scores[previousRow + j - 1];
      const runBonus = Math.max(runBonuses[previousRow + j - 1], BONUS_CONSECUTIVE, bonus);
      const viaRun = consecutive + SCORE_MATCH + runBonus;
      if (viaRun >= viaGap && viaRun > Number.NEGATIVE_INFINITY) {
        scores[row + j] = viaRun;
        runBonuses[row + j] = runBonus;
        previousAt[row + j] = j - 1;
      } else if (viaGap > Number.NEGATIVE_INFINITY) {
        scores[row + j] = viaGap;
        runBonuses[row + j] = bonus;
        previousAt[row + j] = gapBestAt;
      }
    }
  }

  const lastRow = (m - 1) * n;
  let bestAt = -1;
  for (let j = m - 1; j < n; j++) {
    if (scores[lastRow + j] > Number.NEGATIVE_INFINITY && (bestAt < 0 || scores[lastRow + j] > scores[lastRow + bestAt])) {
      bestAt = j;
    }
  }
  if (bestAt < 0) return null;

  const positions = new Array<number>(m);
  for (let i = m - 1, at = bestAt; i >= 0; i--) {
    positions[i] = at;
    at = previousAt[i * n + at];
  }
  return { score: scores[lastRow + bestAt], positions };
};

const substringToken = ({ lower, bonuses }: Prepared, token: string): TokenMatch | null => {
  const at = lower.indexOf(token);
  if (at < 0) return null;
  const firstBonus = bonuses[at];
  const score = SCORE_MATCH * token.length + firstBonus * FIRST_LETTER_MULTIPLIER
    + (token.length - 1) * Math.max(firstBonus, BONUS_CONSECUTIVE);
  return { score, positions: Array.from({ length: token.length }, (_, offset) => at + offset) };
};

const matchToken = (prepared: Prepared, token: string): TokenMatch | null => {
  const unbroken = substringToken(prepared, token);
  if (unbroken && unbroken.score === perfectTokenScore(token.length)) return unbroken;
  const aligned = alignToken(prepared, token);
  if (!aligned) return unbroken;
  if (!unbroken) return aligned;
  return unbroken.score > aligned.score ? unbroken : aligned;
};

const perfectTokenScore = (length: number): number => (
  SCORE_MATCH * length + BONUS_AFTER_WHITESPACE * FIRST_LETTER_MULTIPLIER + (length - 1) * BONUS_AFTER_WHITESPACE
);

const toRanges = (positions: number[]): MatchRange[] => {
  const sorted = [...new Set(positions)].sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const position of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === position) last[1] = position + 1;
    else ranges.push([position, position + 1]);
  }
  return ranges;
};

const tokenize = (query: string): string[] => query.trim().toLowerCase().split(/\s+/).filter(Boolean);

type SubsequenceMatch = {
  score: number;
  ranges: MatchRange[];
};

const matchTokens = (text: string, tokens: string[]): SubsequenceMatch | null => {
  if (!text) return null;
  const lower = lowerPerPosition(text);
  if (!tokens.every((token) => token.length <= lower.length && isSubsequence(lower, token))) return null;
  const prepared: Prepared = { lower, bonuses: positionBonuses(text) };
  let total = 0;
  let perfect = 0;
  const positions: number[] = [];
  for (const token of tokens) {
    const match = matchToken(prepared, token);
    if (!match) return null;
    total += match.score;
    perfect += perfectTokenScore(token.length);
    positions.push(...match.positions);
  }
  return { score: Math.min(1, total / perfect), ranges: toRanges(positions) };
};

const lastSegmentStart = (path: string): number => {
  const end = path.endsWith('/') ? path.length - 1 : path.length;
  return path.lastIndexOf('/', end - 1) + 1;
};

const matchPathTokens = (path: string, tokens: string[]): SubsequenceMatch | null => {
  if (!tokens.some((token) => token.includes('/'))) {
    const start = lastSegmentStart(path);
    const end = path.endsWith('/') ? path.length - 1 : path.length;
    const inName = matchTokens(path.slice(start, end), tokens);
    if (inName) {
      return {
        score: 0.5 + inName.score / 2,
        ranges: inName.ranges.map(([rangeStart, rangeEnd]): MatchRange => [rangeStart + start, rangeEnd + start]),
      };
    }
  }
  const inPath = matchTokens(path, tokens);
  return inPath ? { score: inPath.score / 2, ranges: inPath.ranges } : null;
};

export type RankedMatch<T> = { item: T; score: number; ranges: MatchRange[] };

export function rankBySubsequence<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => string,
  options?: {
    limit?: number;
    paths?: boolean;
  },
): RankedMatch<T>[] {
  const limit = options?.limit ?? items.length;
  const tokens = tokenize(query);
  if (tokens.length === 0) return items.slice(0, limit).map((item) => ({ item, score: 1, ranges: [] }));

  const ranked: (RankedMatch<T> & { length: number; order: number })[] = [];
  for (let order = 0; order < items.length; order++) {
    const item = items[order];
    const text = getText(item);
    const match = options?.paths ? matchPathTokens(text, tokens) : matchTokens(text, tokens);
    if (match) ranked.push({ item, ...match, length: text.length, order });
  }
  ranked.sort((a, b) => (b.score - a.score) || (a.length - b.length) || (a.order - b.order));
  return ranked.slice(0, limit).map(({ item, score, ranges }) => ({ item, score, ranges }));
}
