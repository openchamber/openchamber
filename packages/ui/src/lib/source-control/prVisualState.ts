import type { CSSProperties } from 'react';

export type PrVisualState = 'draft' | 'open' | 'blocked' | 'merged' | 'closed';

type PrVisualInput = {
  state: string;
  draft: boolean;
  checksState: string | null | undefined;
  mergeable: boolean | null | undefined;
  mergeableState: string | null | undefined;
};

export const prVisualStateOf = (pr: PrVisualInput): PrVisualState => {
  if (pr.state === 'merged') return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.draft) return 'draft';
  const conflicting = pr.mergeable === false || pr.mergeableState === 'dirty';
  return pr.checksState === 'failure' || conflicting ? 'blocked' : 'open';
};

export const refTintStyle = (color: string): CSSProperties & { '--oc-ref-tint': string } => ({ '--oc-ref-tint': color });
