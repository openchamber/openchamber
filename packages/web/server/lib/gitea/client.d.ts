// Hand-written declaration for the plain-JS Gitea/Forgejo REST v1 client
// (client.js). Kept in sync with the client's public surface; the web package
// type-checks the gitea live-test harness which imports this module.

export interface GiteaClientPageInfo {
  page: number | null;
  next: string | null;
  total: number | null;
  hasMore: boolean;
  nextUrl?: string;
}

export interface GiteaClientResponse {
  status: number;
  headers: Record<string, string>;
  data: unknown;
  page: GiteaClientPageInfo | null;
  error?: string;
}

export type GiteaQuery = Record<string, string | number | boolean | null | undefined>;

export interface GiteaRequestOptions {
  method?: string;
  query?: GiteaQuery;
  body?: unknown;
  signal?: AbortSignal;
  raw?: boolean;
}

export interface GiteaClient {
  baseUrl: string;
  request: (path: string, options?: GiteaRequestOptions) => Promise<GiteaClientResponse>;
  user: () => Promise<GiteaClientResponse>;
  repo: (owner: string, repo: string) => Promise<GiteaClientResponse>;
  issues: (owner: string, repo: string, params?: GiteaQuery) => Promise<GiteaClientResponse>;
  issue: (owner: string, repo: string, number: number) => Promise<GiteaClientResponse>;
  issueComments: (owner: string, repo: string, number: number, params?: GiteaQuery) => Promise<GiteaClientResponse>;
  createIssueComment: (owner: string, repo: string, number: number, body: string) => Promise<GiteaClientResponse>;
  createIssue: (owner: string, repo: string, params: Record<string, unknown>) => Promise<GiteaClientResponse>;
  updateIssue: (owner: string, repo: string, number: number, params: Record<string, unknown>) => Promise<GiteaClientResponse>;
  milestones: (owner: string, repo: string, params?: GiteaQuery) => Promise<GiteaClientResponse>;
  repoLabels: (owner: string, repo: string, params?: GiteaQuery) => Promise<GiteaClientResponse>;
  pullRequests: (owner: string, repo: string, params?: GiteaQuery) => Promise<GiteaClientResponse>;
  pullRequest: (owner: string, repo: string, number: number) => Promise<GiteaClientResponse>;
  pullRequestDiff: (owner: string, repo: string, number: number) => Promise<GiteaClientResponse>;
  pullRequestFiles: (owner: string, repo: string, number: number, params?: GiteaQuery) => Promise<GiteaClientResponse>;
  pullRequestCommits: (owner: string, repo: string, number: number, params?: GiteaQuery) => Promise<GiteaClientResponse>;
  pullRequestReviews: (owner: string, repo: string, number: number, params?: GiteaQuery) => Promise<GiteaClientResponse>;
  createPullReview: (owner: string, repo: string, number: number, params: Record<string, unknown>) => Promise<GiteaClientResponse>;
  commitStatuses: (owner: string, repo: string, sha: string, params?: GiteaQuery) => Promise<GiteaClientResponse>;
  createPullRequest: (owner: string, repo: string, body: Record<string, unknown>) => Promise<GiteaClientResponse>;
  updatePullRequest: (owner: string, repo: string, number: number, body: Record<string, unknown>) => Promise<GiteaClientResponse>;
  mergePullRequest: (owner: string, repo: string, number: number, body: Record<string, unknown>) => Promise<GiteaClientResponse>;
  branches: (owner: string, repo: string, params?: GiteaQuery) => Promise<GiteaClientResponse>;
  assignees: (owner: string, repo: string, params?: GiteaQuery) => Promise<GiteaClientResponse>;
  tags: (owner: string, repo: string, params?: GiteaQuery) => Promise<GiteaClientResponse>;
}

export function createGiteaClient(options: { token: string; baseUrl: string }): GiteaClient;
export function getGiteaClientOrNull(directory?: string): GiteaClient | null;
export function isGiteaRateLimited(): boolean;
export function noteGiteaRateLimit(error: unknown): void;
