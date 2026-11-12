import { rangesWithin, type MatchRange } from './matchSegments';
import { rankBySubsequence } from './subsequenceSearch';

export type ConversationMetadata = { sessionId: string; title: string; projectLabel: string | null; worktreeLabel: string | null; directory: string | null; archived: boolean; updatedAt?: number };
export type MetadataMatch = { sessionId: string; score: number; titleRanges: ReadonlyArray<MatchRange>; matchedField: 'id' | 'title' | 'project' | 'worktree' | 'directory' };

const metadataText = (item: ConversationMetadata): string => [item.title, item.projectLabel ?? '', item.worktreeLabel ?? '', item.directory ?? ''].join('\n');

const metadataField = (item: ConversationMetadata, ranges: ReadonlyArray<MatchRange>): MetadataMatch['matchedField'] => {
  const firstRange = ranges[0];
  if (!firstRange || firstRange[0] < item.title.length) return 'title';
  const projectStart = item.title.length + 1;
  if (firstRange[0] < projectStart + (item.projectLabel?.length ?? 0)) return 'project';
  const worktreeStart = projectStart + (item.projectLabel?.length ?? 0) + 1;
  if (firstRange[0] < worktreeStart + (item.worktreeLabel?.length ?? 0)) return 'worktree';
  return 'directory';
};

/**
 * Conversations are looked for by what the user remembers of them, and the
 * recent ones are the likely answer. Titles that hold every query word as
 * typed are the answer, the most recently changed on top. Titles matched only
 * by scattered letters ("agent" in "Add geometry notes") are noise beside
 * them, so they list only when no title holds the words, as the fallback for
 * an abbreviation or a typo. Without dates the match order stands.
 */
const byWholeWordsThenRecency = <T extends { item: ConversationMetadata }>(ranks: T[], normalizedQuery: string): T[] => {
  const words = normalizedQuery.split(/\s+/).filter(Boolean);
  const whole: T[] = [];
  const scattered: T[] = [];
  for (const rank of ranks) {
    const title = rank.item.title.toLocaleLowerCase();
    (words.every((word) => title.includes(word)) ? whole : scattered).push(rank);
  }
  // Array.prototype.sort is stable, so equal or missing dates keep the match order.
  whole.sort((left, right) => (right.item.updatedAt ?? 0) - (left.item.updatedAt ?? 0));
  return whole.length > 0 ? whole : scattered;
};

/** `titlesOnly` (the Titles only filter) skips the project, worktree and folder fields; `branchOnly` keeps the worktree's branch alone. */
export function rankConversationMetadata(items: ReadonlyArray<ConversationMetadata>, text: string, options?: { limit?: number; titlesOnly?: boolean; branchOnly?: boolean }): MetadataMatch[] {
  const query = text.trim();
  if (!query) return [];
  const normalizedQuery = query.toLocaleLowerCase();
  if (normalizedQuery.startsWith('ses_')) return items.filter((item) => item.sessionId.toLocaleLowerCase() === normalizedQuery).slice(0, options?.limit).map((item) => ({ sessionId: item.sessionId, score: 0, titleRanges: [], matchedField: 'id' }));
  const allTitleRanks = rankBySubsequence(items, query, (item) => item.title);
  const titleRanks = byWholeWordsThenRecency(allTitleRanks, normalizedQuery);
  // A title match left out as scattered must not come back through the project and folder pass.
  const titleIds = new Set(allTitleRanks.map((entry) => entry.item.sessionId));
  const titleMatches = titleRanks.map((entry) => ({ sessionId: entry.item.sessionId, score: -entry.score, titleRanges: entry.ranges, matchedField: 'title' as const }));
  if (options?.titlesOnly) return titleMatches.slice(0, options.limit);
  const rest = items.filter((item) => !titleIds.has(item.sessionId));
  // A list that already names each row's project gains nothing from matching it: the project's name
  // would list every conversation in it. There only the branch finds a conversation besides its title.
  const metadataMatches = options?.branchOnly
    ? byWholeWordsThenRecency(rankBySubsequence(rest.filter((item) => item.worktreeLabel), query, (item) => item.worktreeLabel ?? ''), normalizedQuery)
      .map((entry) => ({ sessionId: entry.item.sessionId, score: 1_000_000 - entry.score, titleRanges: [], matchedField: 'worktree' as const }))
    : rankBySubsequence(rest, query, metadataText)
      .map((entry) => ({ sessionId: entry.item.sessionId, score: 1_000_000 - entry.score, titleRanges: rangesWithin(entry.ranges, 0, entry.item.title.length), matchedField: metadataField(entry.item, entry.ranges) }));
  return [...titleMatches, ...metadataMatches].slice(0, options?.limit);
}
