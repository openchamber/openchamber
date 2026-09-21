import { scoreByFuzzyQuery } from '@/lib/search/fuzzySearch';
import type { ProjectFileSearchHit } from '@/lib/opencode/client';

export type FileMentionHit = ProjectFileSearchHit & { kind: 'file' | 'directory' };

export const tokenizeMentionQuery = (query: string): string[] =>
  (query ?? '')
    .trim()
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

/**
 * The opencode file search takes a single term, so multi-word queries send the
 * most selective (longest) token and the remaining tokens filter client-side.
 */
export const mentionServerQuery = (query: string): string => {
  const tokens = tokenizeMentionQuery(query);
  if (tokens.length === 0) {
    return '';
  }
  return tokens.reduce((longest, token) => (token.length > longest.length ? token : longest));
};

/**
 * Merge directory and file hits into one list ranked by match quality against
 * the full relative path. Multi-token queries require every token to appear
 * somewhere in the path, in any order.
 */
export function rankFileMentionResults(
  files: ProjectFileSearchHit[],
  directories: ProjectFileSearchHit[],
  query: string,
  limit = 20,
): FileMentionHit[] {
  const merged: FileMentionHit[] = [
    ...directories.map((hit) => ({ ...hit, kind: 'directory' as const })),
    ...files.map((hit) => ({ ...hit, kind: 'file' as const })),
  ];

  const tokens = tokenizeMentionQuery(query);
  if (tokens.length === 0) {
    return merged.slice(0, limit);
  }

  const pathOf = (hit: FileMentionHit) => hit.relativePath || hit.name;
  const candidates = tokens.length === 1
    ? merged
    : merged.filter((hit) => {
        const haystack = pathOf(hit).toLowerCase();
        return tokens.every((token) => haystack.includes(token));
      });

  const primary = tokens.reduce((longest, token) => (token.length > longest.length ? token : longest));
  return scoreByFuzzyQuery(candidates, primary, pathOf, { limit, threshold: 0.4 }).map(
    (scored) => scored.item,
  );
}
