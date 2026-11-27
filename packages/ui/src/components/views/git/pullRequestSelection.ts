import type { usePullRequestComparison } from '@/hooks/usePullRequestComparison';

export type PullRequestComparison = ReturnType<typeof usePullRequestComparison>;
export type ChangeRequestEntry = PullRequestComparison['prs'][number];

export const isSelectedPullRequest = (comparison: PullRequestComparison, pr: ChangeRequestEntry): boolean => {
  const selected = comparison.selectedSource;
  return Boolean(selected && selected.number === pr.number
    && selected.sourceRepo?.owner === pr.project.owner && selected.sourceRepo?.repo === pr.project.name);
};
