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
