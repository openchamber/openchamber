import type { Issue, RepositoryIssueReference } from '@/lib/api/types';

/**
 * The issue detail DTO as the attach path expects it: the list row's shape, so
 * `resolveComposerReferences` reads it the same way as a row the list showed.
 * The detail names the repository `{ owner, name }`; the row's `sourceRepo`
 * names it `{ owner, repo }`, and the attach only reads the row's fields.
 */
export const issueToRepositoryReference = (issue: Issue, source: string): RepositoryIssueReference => ({
  kind: 'issue',
  number: issue.number,
  title: issue.title,
  url: issue.url,
  body: issue.body ?? '',
  bodyTruncated: false,
  createdAt: issue.createdAt ?? null,
  updatedAt: issue.updatedAt ?? null,
  author: issue.author ? { login: issue.author.username, avatarUrl: issue.author.avatarUrl } : null,
  labels: issue.labels ?? [],
  commentCount: 0,
  sourceRepo: { owner: issue.project.owner, repo: issue.project.name, source },
  provider: issue.provider,
  // The detail's open/closed cannot say whether a closed issue was done or
  // dropped; nothing on the attach path reads the state.
  state: issue.state === 'open' ? 'open' : 'completed',
});
