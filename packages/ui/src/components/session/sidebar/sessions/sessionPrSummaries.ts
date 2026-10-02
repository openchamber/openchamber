import type { GitHubIssueLiveSummary } from '@/lib/api/types';
import type { LinkedSidebarIssue } from '@/lib/linkedIssues';
import type { PrVisualSummary } from '@/stores/useGitHubPrStatusStore';

// Which PR a row leads with when a session has several: the one that needs
// attention first. Unknown states sort last.
const VISUAL_STATE_PRIORITY = new Map([
  ['blocked', 0],
  ['open', 1],
  ['draft', 2],
  ['merged', 3],
  ['closed', 4],
]);

const priorityOf = (summary: PrVisualSummary): number => VISUAL_STATE_PRIORITY.get(summary.visualState) ?? VISUAL_STATE_PRIORITY.size;

const identityOf = (summary: PrVisualSummary): string =>
  `${summary.repo?.owner.toLowerCase() ?? ''}/${summary.repo?.repo.toLowerCase() ?? ''}#${summary.number}`;

/**
 * Every PR a session row shows: its worktree branch's PR and the PRs linked to
 * the session, each once, most urgent first. The branch entry wins a
 * duplicate because a full status read carries more than a live summary.
 */
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
  // Array sort is stable: equal priorities keep branch-then-link order.
  return combined.sort((left, right) => priorityOf(left) - priorityOf(right));
};

type PrStatusLabelKey =
  | 'sessions.sidebar.group.pr.status.merged'
  | 'sessions.sidebar.group.pr.status.readyToMerge'
  | 'sessions.sidebar.group.pr.status.open'
  | 'sessions.sidebar.group.pr.status.mergeConflicts'
  | 'sessions.sidebar.group.pr.status.checksFailing'
  | 'sessions.sidebar.group.pr.status.mergeBlocked'
  | 'sessions.sidebar.group.pr.status.draft'
  | 'sessions.sidebar.group.pr.status.closed';

/** The status line a PR shows in the sidebar. */
export const getPrStatusLabelKey = (summary: PrVisualSummary): PrStatusLabelKey | null => {
  switch (summary.visualState) {
    case 'merged':
      return 'sessions.sidebar.group.pr.status.merged';
    case 'open':
      // A PR still waiting for a required review is not ready to merge.
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

/** A linked issue the way a session row shows it. */
export type SessionIssueItem = {
  key: string;
  /** `#12` for GitHub, the tracker's identifier otherwise. */
  label: string;
  icon: 'record-circle' | 'linear';
  /** Theme PR colour for a known state; null when the state is unknown. */
  color: string | null;
  statusKey: IssueStatusLabelKey | null;
  url: string;
  title: string;
};

// Issues borrow the PR colours: open like an open PR, done like a merged
// one, dropped like a closed one. An issue has nothing to fix, so it never
// turns orange.
const ISSUE_STATE_LOOK = {
  open: { color: 'var(--pr-open)', statusKey: 'sessions.sidebar.group.issue.status.open', priority: 0 },
  completed: { color: 'var(--pr-merged)', statusKey: 'sessions.sidebar.group.issue.status.completed', priority: 2 },
  not_planned: { color: 'var(--pr-closed)', statusKey: 'sessions.sidebar.group.issue.status.notPlanned', priority: 3 },
} satisfies Record<GitHubIssueLiveSummary['state'], { color: string; statusKey: IssueStatusLabelKey; priority: number }>;
/** How an issue in a known state looks: its PR-token colour and status line. */
export const getIssueStateLook = (state: GitHubIssueLiveSummary['state']): { color: string; statusKey: IssueStatusLabelKey } => {
  const { color, statusKey } = ISSUE_STATE_LOOK[state];
  return { color, statusKey };
};

// Unknown state (Linear, extensions, a GitHub issue not asked yet) sits
// between open and closed ones.
const UNKNOWN_ISSUE_PRIORITY = 1;

/**
 * The issues a session row shows, most relevant first: open issues, then
 * ones whose state is unknown, then closed ones. `states` lines up with the
 * GitHub issues among `issues`, in order.
 */
export const buildSessionIssueItems = (
  issues: readonly LinkedSidebarIssue[],
  states: ReadonlyArray<GitHubIssueLiveSummary | null>,
): SessionIssueItem[] => {
  let githubIndex = 0;
  const ranked = issues.map((issue) => {
    if (issue.source !== 'github') {
      const item: SessionIssueItem = {
        key: issue.key,
        label: issue.identifier,
        icon: issue.source === 'linear' ? 'linear' : 'record-circle',
        color: null,
        statusKey: null,
        url: issue.url,
        title: issue.title,
      };
      return { item, priority: UNKNOWN_ISSUE_PRIORITY };
    }
    const state = states[githubIndex] ?? null;
    githubIndex += 1;
    const look = state ? ISSUE_STATE_LOOK[state.state] : null;
    const item: SessionIssueItem = {
      key: issue.key,
      label: `#${issue.number}`,
      icon: 'record-circle',
      color: look?.color ?? null,
      statusKey: look?.statusKey ?? null,
      url: issue.url,
      title: state?.title || issue.title,
    };
    return { item, priority: look?.priority ?? UNKNOWN_ISSUE_PRIORITY };
  });
  // Array sort is stable: equal priorities keep link order.
  return ranked.sort((left, right) => left.priority - right.priority).map((entry) => entry.item);
};
