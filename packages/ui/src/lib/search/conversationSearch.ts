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

const byWholeWordsThenRecency = <T extends { item: ConversationMetadata }>(ranks: T[], normalizedQuery: string): T[] => {
  const words = normalizedQuery.split(/\s+/).filter(Boolean);
  const whole: T[] = [];
  const scattered: T[] = [];
  for (const rank of ranks) {
    const title = rank.item.title.toLocaleLowerCase();
    (words.every((word) => title.includes(word)) ? whole : scattered).push(rank);
  }
  whole.sort((left, right) => (right.item.updatedAt ?? 0) - (left.item.updatedAt ?? 0));
  return whole.length > 0 ? whole : scattered;
};

export function rankConversationMetadata(items: ReadonlyArray<ConversationMetadata>, text: string, options?: { limit?: number; titlesOnly?: boolean; branchOnly?: boolean }): MetadataMatch[] {
  const query = text.trim();
  if (!query) return [];
  const normalizedQuery = query.toLocaleLowerCase();
  if (normalizedQuery.startsWith('ses_')) return items.filter((item) => item.sessionId.toLocaleLowerCase() === normalizedQuery).slice(0, options?.limit).map((item) => ({ sessionId: item.sessionId, score: 0, titleRanges: [], matchedField: 'id' }));
  const allTitleRanks = rankBySubsequence(items, query, (item) => item.title);
  const titleRanks = byWholeWordsThenRecency(allTitleRanks, normalizedQuery);
  const titleIds = new Set(allTitleRanks.map((entry) => entry.item.sessionId));
  const titleMatches = titleRanks.map((entry) => ({ sessionId: entry.item.sessionId, score: -entry.score, titleRanges: entry.ranges, matchedField: 'title' as const }));
  if (options?.titlesOnly) return titleMatches.slice(0, options.limit);
  const rest = items.filter((item) => !titleIds.has(item.sessionId));
  const metadataMatches = options?.branchOnly
    ? byWholeWordsThenRecency(rankBySubsequence(rest.filter((item) => item.worktreeLabel), query, (item) => item.worktreeLabel ?? ''), normalizedQuery)
      .map((entry) => ({ sessionId: entry.item.sessionId, score: 1_000_000 - entry.score, titleRanges: [], matchedField: 'worktree' as const }))
    : rankBySubsequence(rest, query, metadataText)
      .map((entry) => ({ sessionId: entry.item.sessionId, score: 1_000_000 - entry.score, titleRanges: rangesWithin(entry.ranges, 0, entry.item.title.length), matchedField: metadataField(entry.item, entry.ranges) }));
  return [...titleMatches, ...metadataMatches].slice(0, options?.limit);
}
