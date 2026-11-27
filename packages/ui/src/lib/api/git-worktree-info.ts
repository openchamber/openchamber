import type { GitContributorWorktreeProvenance } from './types';

export interface GitWorktreeInfo {
  head: string;
  name: string;
  branch: string;
  path: string;
  title?: string;
  pinnedAt?: number;
  pinList?: string;
  integrateCheckout?: true;
  provenance?: GitContributorWorktreeProvenance;
}
