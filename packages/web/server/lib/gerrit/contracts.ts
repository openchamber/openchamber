import type {
  ChangeRequestSubmitRequirement,
  ChangeRequestVoteLabel,
} from '../source-control/provider-contract.js';
import type { z } from 'zod';

export type GerritJson = z.infer<z.ZodJSONSchema>;
export type GerritQuery = { [key: string]: string | number | boolean | null | undefined | string[] };

export type GerritIdentity = { provider: string; instance: string; accountId?: string };
export type GerritUser = GerritIdentity & {
  id: string;
  username: string;
  avatarUrl?: string;
  name?: string;
  email?: string;
};
export type GerritProject = GerritIdentity & {
  id: string;
  owner: string;
  name: string;
  url: string;
  cloneUrl: string;
  defaultBranch?: string;
  remoteName?: string;
};
export type GerritChangeState = 'open' | 'closed' | 'merged';
export type GerritChange = GerritIdentity & {
  id: string;
  number: number;
  project: GerritProject;
  title: string;
  url: string;
  state: GerritChangeState;
  draft: boolean;
  base: string;
  head: string;
  labels: Array<{ name: string }>;
  body?: string;
  headSha?: string;
  revisionNumber?: number;
  headLabel?: string;
  author?: GerritUser;
  createdAt?: string;
  updatedAt?: string;
  private?: boolean;
  topic?: string;
  mergeable?: boolean;
  mergeableState?: 'clean' | 'blocked';
};
export type GerritVoteLabel = Omit<ChangeRequestVoteLabel, 'votes'> & {
  votes: Array<{ user: GerritUser; value: number }>;
};
export type GerritSubmitRequirement = ChangeRequestSubmitRequirement;
export type GerritRevision = {
  number: number;
  sha: string;
  createdAt: string | null;
  ref: string;
  uploader?: GerritUser;
  kind?: 'rework' | 'trivial-rebase' | 'merge-first-parent-update' | 'no-code-change' | 'no-change';
};
export type GerritComment = GerritIdentity & {
  id: string;
  url: string;
  body: string;
  canUpdate: boolean;
  canDelete: boolean;
  author?: GerritUser;
  createdAt?: string;
  revision?: number;
  path?: string;
  line?: number;
};
export type GerritFile = {
  path: string;
  status: 'added' | 'removed' | 'renamed' | 'modified';
  previousPath?: string;
  additions: number;
  deletions: number;
  changes: number;
};
export type GerritLiveSummary = {
  owner: string;
  repo: string;
  number: number;
  state: GerritChangeState;
  draft: boolean;
  title: string;
  mergeable: boolean | null;
  mergeableState: 'clean' | 'blocked' | null;
  checks: null;
  headSha?: string;
  base?: string;
};
