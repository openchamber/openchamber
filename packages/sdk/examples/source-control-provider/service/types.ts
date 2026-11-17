import type { SourceControlProviderSession } from '@openchamber/sdk';

export type GiteaUser = { id: number; login: string; full_name?: string; email?: string; avatar_url?: string };
export type GiteaRepo = {
  id: number; name: string; owner: { login: string }; html_url: string; clone_url?: string; default_branch?: string;
  fork?: boolean; parent?: GiteaRepo | null;
};
export type GiteaBranchRef = { ref: string; sha: string; repo_id?: number; repo?: GiteaRepo };
export type GiteaIssue = {
  number: number; title: string; body?: string; state: 'open' | 'closed'; html_url: string; user?: GiteaUser;
  assignees?: GiteaUser[]; locked?: boolean;
  created_at?: string; updated_at?: string; pull_request?: object | null;
};
export type GiteaSubscriptionCheck = { subscribed?: boolean };
export type GiteaPull = GiteaIssue & {
  draft?: boolean; merged?: boolean; mergeable?: boolean; head: GiteaBranchRef; base: GiteaBranchRef;
  merge_base?: string;
};
export type GiteaChangedFile = { filename: string; status?: string; additions?: number; deletions?: number; changes?: number };
export type GiteaComment = {
  id: number; body: string; html_url?: string; user?: GiteaUser; created_at?: string; updated_at?: string;
  issue_url?: string; pull_request_url?: string;
};
export type GiteaBranch = { name: string };
export type GiteaVersion = { version: string };

export type Call = { session: SourceControlProviderSession; identity: { provider: string; instance: string } };

export type ProviderTarget = { repoId: number; owner: string; name: string; number?: number; sourceRepoId?: number; sourceOwner?: string };
