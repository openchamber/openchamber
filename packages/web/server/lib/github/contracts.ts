import type { Octokit } from '@octokit/rest';

export interface PullRequestQuery {
  octokit: Octokit;
  owner: string;
  repo: string;
  number: number;
}

export interface GitHubEnvelope {
  status?: unknown;
  code?: unknown;
  error_description?: unknown;
  error?: unknown;
  device_code?: unknown;
  user_code?: unknown;
  verification_uri?: unknown;
  verification_uri_complete?: unknown;
  expires_in?: unknown;
  interval?: unknown;
  enablePullRequestAutoMerge?: unknown;
  disablePullRequestAutoMerge?: unknown;
  pullRequest?: unknown;
  autoMergeRequest?: unknown;
  enabledAt?: unknown;
  repository?: unknown;
  reviews?: unknown;
  nodes?: unknown;
  viewerDidAuthor?: unknown;
  commit?: unknown;
  oid?: unknown;
  id?: unknown;
}

export const hasProperty = <Key extends keyof GitHubEnvelope>(value: unknown, key: Key): value is Required<Pick<GitHubEnvelope, Key>> =>
  value != null && key in Object(value);
