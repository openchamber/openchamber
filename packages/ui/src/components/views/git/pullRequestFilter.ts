import type { ChangeRequest } from '@/lib/source-control/types';
import { joinProjectPath } from '@/lib/source-control/projectPath';

export type PullRequestStatusFilter = 'all' | 'open' | 'draft' | 'closed' | 'merged';

export type PullRequestFilter = {
  status: PullRequestStatusFilter;
  repository: string;
  author: string;
  labels: readonly string[];
};

export const PULL_REQUEST_STATUS_FILTERS = ['all', 'open', 'draft', 'closed', 'merged'] as const satisfies readonly PullRequestStatusFilter[];

export const DEFAULT_PULL_REQUEST_FILTER: PullRequestFilter = {
  status: 'open',
  repository: '',
  author: '',
  labels: [],
};

const pullRequestRepository = (pr: ChangeRequest): string => joinProjectPath(pr.project.owner, pr.project.name);

const matchesStatus = (pr: ChangeRequest, status: PullRequestStatusFilter): boolean => {
  if (status === 'all') return true;
  if (status === 'draft') return pr.state === 'open' && pr.draft === true;
  return pr.state === status;
};

const matchesLabels = (pr: ChangeRequest, labels: readonly string[]): boolean => (
  labels.every((name) => (pr.labels ?? []).some((label) => label.name === name))
);

const matchesPullRequestFilter = (pr: ChangeRequest, filter: PullRequestFilter): boolean => (
  matchesStatus(pr, filter.status)
  && (!filter.repository || pullRequestRepository(pr) === filter.repository)
  && (!filter.author || pr.author?.username === filter.author)
  && matchesLabels(pr, filter.labels)
);

export const filterPullRequests = (prs: readonly ChangeRequest[], filter: PullRequestFilter): ChangeRequest[] => (
  prs.filter((pr) => matchesPullRequestFilter(pr, filter))
);

export const pullRequestListState = (status: PullRequestStatusFilter): 'open' | 'all' => (
  status === 'open' || status === 'draft' ? 'open' : 'all'
);

export const pullRequestFilterChoices = (prs: readonly ChangeRequest[], filter: PullRequestFilter) => ({
  repositories: [...new Set([...(filter.repository ? [filter.repository] : []), ...prs.map(pullRequestRepository)])],
  authors: [...new Set([...(filter.author ? [filter.author] : []), ...prs.flatMap((pr) => (pr.author ? [pr.author.username] : []))])],
  labels: [...new Map(prs.flatMap((pr) => pr.labels ?? []).map((entry) => [entry.name, entry])).values()]
    .sort((left, right) => left.name.localeCompare(right.name)),
});
