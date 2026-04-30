import type {
  GitHubAPI,
  GitHubAuthStatus,
  GitHubIssueCommentsResult,
  GitHubIssueGetResult,
  GitHubIssuesListResult,
  GitHubPullRequestContextResult,
  GitHubPullRequestsListResult,
  GitHubPullRequest,
  GitHubPullRequestCreateInput,
  GitHubPullRequestMergeInput,
  GitHubPullRequestMergeResult,
  GitHubPullRequestReadyInput,
  GitHubPullRequestReadyResult,
  GitHubPullRequestUpdateInput,
  GitHubPullRequestStatus,
  GitHubDeviceFlowComplete,
  GitHubDeviceFlowStart,
  GitHubRepoUpstreamResult,
  GitHubUserSummary,
} from '@openchamber/ui/lib/api/types';

import { sendBridgeMessage } from './bridge';

export const createVSCodeGitHubAPI = (): GitHubAPI => ({
  authStatus: async () => sendBridgeMessage<GitHubAuthStatus>('api:github/auth:status'),
  authStart: async () => sendBridgeMessage<GitHubDeviceFlowStart>('api:github/auth:start'),
  authComplete: async (deviceCode: string) =>
    sendBridgeMessage<GitHubDeviceFlowComplete>('api:github/auth:complete', { deviceCode }),
  authDisconnect: async () => sendBridgeMessage<{ removed: boolean }>('api:github/auth:disconnect'),
  authActivate: async (accountId: string) =>
    sendBridgeMessage<GitHubAuthStatus>('api:github/auth:activate', { accountId }),
  me: async () => sendBridgeMessage<GitHubUserSummary>('api:github/me'),

  prStatus: async (directory: string, branch: string) =>
    sendBridgeMessage<GitHubPullRequestStatus>('api:github/pr:status', { directory, branch }),
  prCreate: async (payload: GitHubPullRequestCreateInput) =>
    sendBridgeMessage<GitHubPullRequest>('api:github/pr:create', payload),
  prUpdate: async (payload: GitHubPullRequestUpdateInput) =>
    sendBridgeMessage<GitHubPullRequest>('api:github/pr:update', payload),
  prMerge: async (payload: GitHubPullRequestMergeInput) =>
    sendBridgeMessage<GitHubPullRequestMergeResult>('api:github/pr:merge', payload),
  prReady: async (payload: GitHubPullRequestReadyInput) =>
    sendBridgeMessage<GitHubPullRequestReadyResult>('api:github/pr:ready', payload),

  issuesList: async (directory: string, options?: { page?: number }) =>
    sendBridgeMessage<GitHubIssuesListResult>('api:github/issues:list', { directory, page: options?.page ?? 1 }),
  issueGet: async (directory: string, number: number, options?: { sourceRepo?: { owner: string; repo: string } | null }) =>
    sendBridgeMessage<GitHubIssueGetResult>('api:github/issues:get', { directory, number, sourceRepo: options?.sourceRepo ?? null }),
  issueComments: async (directory: string, number: number, options?: { sourceRepo?: { owner: string; repo: string } | null }) =>
    sendBridgeMessage<GitHubIssueCommentsResult>('api:github/issues:comments', { directory, number, sourceRepo: options?.sourceRepo ?? null }),

  prsList: async (directory: string, options?: { page?: number }) =>
    sendBridgeMessage<GitHubPullRequestsListResult>('api:github/pulls:list', { directory, page: options?.page ?? 1 }),
  prContext: async (directory: string, number: number, options?: { includeDiff?: boolean; includeCheckDetails?: boolean; sourceRepo?: { owner: string; repo: string } | null }) =>
    sendBridgeMessage<GitHubPullRequestContextResult>('api:github/pulls:context', {
      directory,
      number,
      includeDiff: Boolean(options?.includeDiff),
      includeCheckDetails: Boolean(options?.includeCheckDetails),
      sourceRepo: options?.sourceRepo ?? null,
    }),

  repoUpstream: async (directory: string) =>
    sendBridgeMessage<GitHubRepoUpstreamResult>('api:github/repo:upstream', { directory }),
  repoBranches: async (owner: string, repo: string) =>
    sendBridgeMessage<string[]>('api:github/repo:branches', { owner, repo }),
});
