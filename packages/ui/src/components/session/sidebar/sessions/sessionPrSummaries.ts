import type { IconName } from '@/components/icon/icons';
import type { IssueLiveSummary, TrackerLiveSummary, TrackerStateCategory } from '@/lib/api/types';
import { trackerPresentation } from '@/lib/trackers/presentation';
import { trackerIssueLook } from '@/lib/trackers/stateLook';
import type { LinkedSidebarChange, LinkedSidebarIssue } from '@/lib/linkedIssues';
import type { PrVisualSummary } from '@/stores/useGitHubPrStatusStore';

const VISUAL_STATE_PRIORITY = new Map([
  ['blocked', 0],
  ['open', 1],
  ['draft', 2],
  ['merged', 3],
  ['closed', 4],
]);

const priorityOf = (summary: PrVisualSummary): number => VISUAL_STATE_PRIORITY.get(summary.visualState) ?? VISUAL_STATE_PRIORITY.size;

const changeIdentity = (provider: string, owner: string, repo: string, number: number): string =>
  `${provider}:${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
const identityOf = (summary: PrVisualSummary): string =>
  changeIdentity(summary.provider ?? '', summary.repo?.owner ?? '', summary.repo?.repo ?? '', summary.number);

export const combineSessionPrSummaries = (
  branch: PrVisualSummary | null,
  linked: readonly PrVisualSummary[],
): PrVisualSummary[] => {
  const seen = new Set<string>();
  const combined: PrVisualSummary[] = [];
  for (const summary of branch ? [branch, ...linked] : linked) {
    const identity = identityOf(summary);
    if (seen.has(identity)) continue;
    seen.add(identity);
    combined.push(summary);
  }
  return combined.sort((left, right) => priorityOf(left) - priorityOf(right));
};

export const findLinkedPrsWithoutState = (
  changes: readonly LinkedSidebarChange[],
  summaries: readonly PrVisualSummary[],
): LinkedSidebarChange[] => {
  const known = new Set(summaries.map(identityOf));
  return changes.filter(({ repository }) => (
    repository && !known.has(changeIdentity(repository.provider, repository.owner, repository.repo, repository.number))
  ));
};

type PrStatusLabelKey =
  | 'sessions.sidebar.group.pr.status.merged'
  | 'sessions.sidebar.group.pr.status.readyToMerge'
  | 'sessions.sidebar.group.pr.status.open'
  | 'sessions.sidebar.group.pr.status.mergeConflicts'
  | 'sessions.sidebar.group.pr.status.checksFailing'
  | 'sessions.sidebar.group.pr.status.checksRunning'
  | 'sessions.sidebar.group.pr.status.mergeBlocked'
  | 'sessions.sidebar.group.pr.status.draft'
  | 'sessions.sidebar.group.pr.status.closed';

export const getPrStatusLabelKey = (summary: PrVisualSummary): PrStatusLabelKey | null => {
  switch (summary.visualState) {
    case 'merged':
      return 'sessions.sidebar.group.pr.status.merged';
    case 'open':
      if (summary.checks?.state === 'pending') return 'sessions.sidebar.group.pr.status.checksRunning';
      return summary.mergeableState !== 'blocked'
        && (summary.canMerge === true || summary.mergeableState === 'clean' || summary.checks?.state === 'success')
        ? 'sessions.sidebar.group.pr.status.readyToMerge'
        : 'sessions.sidebar.group.pr.status.open';
    case 'blocked':
      if (summary.mergeableState === 'dirty') return 'sessions.sidebar.group.pr.status.mergeConflicts';
      if (summary.checks?.state === 'failure') return 'sessions.sidebar.group.pr.status.checksFailing';
      return 'sessions.sidebar.group.pr.status.mergeBlocked';
    case 'draft':
      return 'sessions.sidebar.group.pr.status.draft';
    case 'closed':
      return 'sessions.sidebar.group.pr.status.closed';
    default:
      return null;
  }
};

type IssueStatusLabelKey =
  | 'sessions.sidebar.group.issue.status.open'
  | 'sessions.sidebar.group.issue.status.completed'
  | 'sessions.sidebar.group.issue.status.notPlanned';

type SessionIssueItem = {
  key: string;
  label: string;
  icon: IconName;
  color: string | null;
  statusKey: IssueStatusLabelKey | null;
  statusText: string | null;
  url: string;
  title: string;
};

const ISSUE_STATE_LOOK = {
  open: { color: 'var(--pr-open)', statusKey: 'sessions.sidebar.group.issue.status.open', priority: 0 },
  completed: { color: 'var(--pr-merged)', statusKey: 'sessions.sidebar.group.issue.status.completed', priority: 2 },
  not_planned: { color: 'var(--pr-closed)', statusKey: 'sessions.sidebar.group.issue.status.notPlanned', priority: 3 },
} satisfies Record<IssueLiveSummary['state'], { color: string; statusKey: IssueStatusLabelKey; priority: number }>;
export const getIssueStateLook = (state: IssueLiveSummary['state']): { color: string; statusKey: IssueStatusLabelKey } => {
  const { color, statusKey } = ISSUE_STATE_LOOK[state];
  return { color, statusKey };
};

export const getTrackerItemStateLook = (category: TrackerStateCategory): { color: string; priority: number } => {
  const { color, priority } = ISSUE_STATE_LOOK[trackerIssueLook(category)];
  return { color, priority };
};

const UNKNOWN_ISSUE_PRIORITY = 1;

export const buildSessionIssueItems = (
  issues: readonly LinkedSidebarIssue[],
  repositoryStates: ReadonlyArray<IssueLiveSummary | null>,
  trackerStates: ReadonlyArray<TrackerLiveSummary | null> = [],
): SessionIssueItem[] => {
  let repositoryIndex = 0;
  let trackerIndex = 0;
  const ranked = issues.map((issue) => {
    if (issue.source === 'repository') {
      const state = repositoryStates[repositoryIndex] ?? null;
      repositoryIndex += 1;
      const look = state ? ISSUE_STATE_LOOK[state.state] : null;
      const item: SessionIssueItem = {
        key: issue.key,
        label: issue.identifier,
        icon: 'record-circle',
        color: look?.color ?? null,
        statusKey: look?.statusKey ?? null,
        statusText: null,
        url: issue.url,
        title: state?.title || issue.title,
      };
      return { item, priority: look?.priority ?? UNKNOWN_ISSUE_PRIORITY };
    }
    if (issue.source === 'tracker') {
      const state = trackerStates[trackerIndex] ?? null;
      trackerIndex += 1;
      const look = state ? getTrackerItemStateLook(state.state.category) : null;
      const item: SessionIssueItem = {
        key: issue.key,
        label: issue.identifier,
        icon: trackerPresentation(issue.provider).icon,
        color: look?.color ?? null,
        statusKey: null,
        statusText: state?.state.name ?? null,
        url: issue.url,
        title: state?.title || issue.title,
      };
      return { item, priority: look?.priority ?? UNKNOWN_ISSUE_PRIORITY };
    }
    const item: SessionIssueItem = {
      key: issue.key,
      label: issue.identifier,
      icon: 'record-circle',
      color: null,
      statusKey: null,
      statusText: null,
      url: issue.url,
      title: issue.title,
    };
    return { item, priority: UNKNOWN_ISSUE_PRIORITY };
  });
  return ranked.sort((left, right) => left.priority - right.priority).map((entry) => entry.item);
};
