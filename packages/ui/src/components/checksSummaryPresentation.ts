import type { GitHubChecksSummary } from '@/lib/api/types';

export const getWorkStatusChecksPresentation = (checks: Pick<GitHubChecksSummary, 'failure' | 'pending' | 'success'> & { state: string }) => {
  const presentation = {
    failure: checks.failure > 0 ? checks.failure : null,
    pending: checks.pending > 0 ? checks.pending : null,
    passed: checks.state === 'success' && checks.failure === 0 && checks.pending === 0
      ? checks.success
      : null,
  };
  return presentation.failure === null && presentation.pending === null && presentation.passed === null
    ? null
    : presentation;
};

export const getPullRequestChecksText = (checks: GitHubChecksSummary, label: string): string => (
  checks.state === 'unknown' || checks.total <= 0
    ? `${checks.state} ${label}`
    : `${checks.success}/${checks.total} ${label}`
);
