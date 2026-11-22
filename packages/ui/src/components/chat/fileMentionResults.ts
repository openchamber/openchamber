import { rankBySubsequence } from '@/lib/search/subsequenceSearch';
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

export const mentionServerQuery = (query: string): string => {
  const tokens = tokenizeMentionQuery(query);
  if (tokens.length === 0) {
    return '';
  }
  return tokens.reduce((longest, token) => (token.length > longest.length ? token : longest));
};

export const mentionSearchKey = (
  directory: string,
  query: string,
  options: { includeHidden: boolean; respectGitignore: boolean },
): string | null => {
  const serverQuery = mentionServerQuery(query);
  if (!directory || !serverQuery || query.includes(' ')) {
    return null;
  }
  return JSON.stringify([directory, serverQuery, options.includeHidden, options.respectGitignore]);
};

type MentionListState = 'rows' | 'loading' | 'empty';

export const mentionListState = (rowCount: number, pending: boolean): MentionListState => {
  if (rowCount > 0) return 'rows';
  return pending ? 'loading' : 'empty';
};

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

  return rankBySubsequence(merged, tokens.join(' '), (hit) => hit.relativePath || hit.name, { limit, paths: true }).map(
    (ranked) => ranked.item,
  );
}

export function filterStaleRecentFiles<T extends { path: string }>(
  files: readonly T[],
  stalePaths: ReadonlySet<string>,
): T[] {
  if (stalePaths.size === 0) {
    return [...files];
  }
  return files.filter((file) => !stalePaths.has(file.path));
}

