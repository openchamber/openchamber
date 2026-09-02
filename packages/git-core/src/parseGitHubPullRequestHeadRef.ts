import type { PullRequestHeadRef } from './types.js';

/**
 * Parse a GitHub PR identifier into a `refs/pull/<n>/head` reference.
 *
 * Accepts either a numeric value or a numeric string. Returns `null`
 * for missing, blank, or non-positive values so callers can decide
 * whether "no PR attached" is a no-op or an error.
 */
export const parseGitHubPullRequestHeadRef = (
  value: number | string | null | undefined,
): PullRequestHeadRef | null => {
  const number = Number(String(value ?? '').trim());
  if (!Number.isSafeInteger(number) || number <= 0) {
    return null;
  }

  return {
    number,
    sourceRef: `refs/pull/${number}/head`,
  };
};
