export interface WorktreeMetadata {
  provenance?: import('@/lib/api/types').GitContributorWorktreeProvenance;

  source?: 'sdk';

  path: string;

  projectDirectory: string;

  branch: string;

  label: string;

  name?: string;

  title?: string;

  pinnedAt?: number;

  pinList?: string;

  kind?: 'pr' | 'standard';

  createdFromBranch?: string;

  relativePath?: string;

  status?: {
    isDirty: boolean;
    ahead?: number;
    behind?: number;
    upstream?: string | null;
    aheadBase?: string | null;
  };

  worktreeRoot?: string;

  worktreeStatus?: 'pending' | 'ready' | 'missing' | 'invalid' | 'not-a-repo';

  headState?: 'branch' | 'detached' | 'unborn';

  worktreeSource?: 'existing' | 'created-for-session';
}
