import type { GitHubPullReference, GitHubReference, GitHubRepoSelector } from '@/lib/api/types';
import { supportsGitHubAutomation } from './githubAutomation';
import { gitRemoteHost } from './identity';

export type PullStackPosition = { readonly index: number; readonly total: number };

export const pullStackReferenceKey = (pull: Pick<GitHubPullReference, 'sourceRepo' | 'number'>): string =>
  `${pull.sourceRepo.owner}/${pull.sourceRepo.repo}#${pull.number}`.toLowerCase();

const repositoryKey = (repo: { owner: string; repo: string }): string => `${repo.owner}/${repo.repo}`.toLowerCase();

/** A base branch lives in its own repository; a similarly named fork head is unrelated. */
export const findPullForStackBase = (items: readonly GitHubReference[], base: string, project: GitHubRepoSelector): GitHubPullReference | null =>
  items.find((item): item is GitHubPullReference => item.kind === 'pull' && supportsGitHubAutomation({ provider: item.provider, instance: gitRemoteHost(item.url) ?? '' })
    && item.state === 'open' && item.head === base && repositoryKey(item.sourceRepo) === repositoryKey(project)
    && item.headRepo !== null && repositoryKey(item.headRepo) === repositoryKey(project)) ?? null;

/** Page-local hints only. Fork heads, ambiguous parents, trees and cycles grant no chain position. */
export function inferPullStackPositions(items: readonly GitHubReference[]): ReadonlyMap<string, PullStackPosition> {
  const pulls = items.filter((item): item is GitHubPullReference => item.kind === 'pull'
    && item.state === 'open' && supportsGitHubAutomation({ provider: item.provider, instance: gitRemoteHost(item.url) ?? '' })
    && item.headRepo !== null && repositoryKey(item.headRepo) === repositoryKey(item.sourceRepo));
  const byHead = new Map<string, GitHubPullReference[]>();
  for (const pull of pulls) {
    const key = `${repositoryKey(pull.sourceRepo)}:${pull.head}`;
    const bucket = byHead.get(key) ?? [];
    bucket.push(pull);
    byHead.set(key, bucket);
  }
  const parent = new Map<GitHubPullReference, GitHubPullReference>();
  const ambiguous = new Set<GitHubPullReference>();
  const children = new Map<GitHubPullReference, GitHubPullReference[]>();
  for (const pull of pulls) {
    const candidates = byHead.get(`${repositoryKey(pull.sourceRepo)}:${pull.base}`);
    if (candidates && candidates.length > 1) { ambiguous.add(pull); candidates.forEach((candidate) => ambiguous.add(candidate)); }
    const base = candidates?.length === 1 ? candidates[0] : null;
    if (!base || base === pull) continue;
    parent.set(pull, base);
    const bucket = children.get(base) ?? [];
    bucket.push(pull);
    children.set(base, bucket);
  }
  const positions = new Map<string, PullStackPosition>();
  for (const bottom of pulls) {
    if (parent.has(bottom)) continue;
    const chain: GitHubPullReference[] = [];
    let next: GitHubPullReference | undefined = bottom;
    while (next) {
      chain.push(next);
      if (ambiguous.has(next)) { chain.length = 0; break; }
      const above: GitHubPullReference[] = children.get(next) ?? [];
      if (above.length > 1) { chain.length = 0; break; }
      next = above[0];
    }
    if (chain.length < 2) continue;
    chain.forEach((pull, index) => positions.set(pullStackReferenceKey(pull), { index: index + 1, total: chain.length }));
  }
  return positions;
}
