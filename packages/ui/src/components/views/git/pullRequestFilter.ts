import type { RepositoryReferencePeople, RepositoryReferenceState } from '@/lib/api/types';
import type { ChangeRequest } from '@/lib/source-control/types';
import { joinProjectPath } from '@/lib/source-control/projectPath';
import { REPOSITORY_PEOPLE, REPOSITORY_STATES } from '@/components/references/referencePickerItems';

export type PullRequestFilter = {
  state: RepositoryReferenceState;
  people: RepositoryReferencePeople;
  repository: string;
  labels: readonly string[];
};

export const PULL_REQUEST_STATES = REPOSITORY_STATES.pull;
export const PULL_REQUEST_PEOPLE = REPOSITORY_PEOPLE.pull;

export const DEFAULT_PULL_REQUEST_FILTER: PullRequestFilter = {
  state: 'open',
  people: 'any',
  repository: '',
  labels: [],
};

const pullRequestRepository = (pr: ChangeRequest): string => joinProjectPath(pr.project.owner, pr.project.name);

export const pullRequestsInRepository = (prs: readonly ChangeRequest[], repository: string): readonly ChangeRequest[] => (
  repository ? prs.filter((pr) => pullRequestRepository(pr) === repository) : prs
);

export const pullRequestFilterChoices = (prs: readonly ChangeRequest[], filter: PullRequestFilter) => ({
  repositories: [...new Set([...(filter.repository ? [filter.repository] : []), ...prs.map(pullRequestRepository)])],
  labels: [...new Map(prs.flatMap((pr) => pr.labels ?? []).map((entry) => [entry.name, entry])).values()]
    .sort((left, right) => left.name.localeCompare(right.name)),
});
