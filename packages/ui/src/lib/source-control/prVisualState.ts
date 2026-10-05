/** How a PR is coloured: the theme's `--pr-<state>` token. */
export type PrVisualState = 'draft' | 'open' | 'blocked' | 'merged' | 'closed';

type PrVisualInput = {
  state: string;
  draft: boolean;
  checksState: string | null | undefined;
  mergeable: boolean | null | undefined;
  mergeableState: string | null | undefined;
};

/**
 * The one PR colour rule, shared by the sidebar, the Git view and the
 * reference picker. Orange (`blocked`) means something to fix: failed checks
 * or a conflict. GitHub's `blocked` merge state alone usually means a missing
 * required review, so it keeps the open colour.
 */
export const prVisualStateOf = (pr: PrVisualInput): PrVisualState => {
  if (pr.state === 'merged') return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.draft) return 'draft';
  const conflicting = pr.mergeable === false || pr.mergeableState === 'dirty';
  return pr.checksState === 'failure' || conflicting ? 'blocked' : 'open';
};
