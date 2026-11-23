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
  status: 'all',
  repository: '',
  author: '',
  labels: [],
};

export const pullRequestRepository = (pr: ChangeRequest): string => joinProjectPath(pr.project.owner, pr.project.name);

const matchesStatus = (pr: ChangeRequest, status: PullRequestStatusFilter): boolean => {
  if (status === 'all') return true;
  if (status === 'draft') return pr.draft === true;
  return pr.state === status;
};

const matchesLabels = (pr: ChangeRequest, labels: readonly string[]): boolean => (
  labels.every((name) => (pr.labels ?? []).some((label) => label.name === name))
);

export const matchesPullRequestFilter = (pr: ChangeRequest, filter: PullRequestFilter): boolean => (
  matchesStatus(pr, filter.status)
  && (!filter.repository || pullRequestRepository(pr) === filter.repository)
  && (!filter.author || pr.author?.username === filter.author)
  && matchesLabels(pr, filter.labels)
);

export const filterPullRequests = (prs: readonly ChangeRequest[], filter: PullRequestFilter): ChangeRequest[] => (
  prs.filter((pr) => matchesPullRequestFilter(pr, filter))
);
