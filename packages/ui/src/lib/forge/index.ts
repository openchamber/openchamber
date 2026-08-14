/**
 * Provider-agnostic git-forge facade.
 *
 * Barrel for the forge contract: normalized entity types (`./types`), the
 * `ForgeProvider` interface + capability model (`./provider`), the pure
 * normalization mappers (`./normalize`), and the per-provider adapters +
 * factory (`./adapters`).
 */

export type {
  ForgeProviderKind,
  ForgeChecksCapability,
  ForgeReviewsCapability,
  ForgeProviderCapabilities,
  ForgeUser,
  ForgeLabel,
  ForgeMilestone,
  ForgeRepoRef,
  ForgeEntityState,
  ForgeIssue,
  ForgeBranchRef,
  ForgePullRequest,
  ForgeComment,
  ForgeTimelineEventType,
  ForgeTimelineEvent,
  ForgeCommit,
  ForgeFileChange,
  ForgeCheckState,
  ForgeCheckKind,
  ForgeCheckAnnotation,
  ForgeCheck,
  ForgeChecksSummary,
  ForgeReview,
} from './types';

export type {
  ForgePullRequestsResult,
  ForgePullRequestContext,
  ForgeIssuesResult,
  ForgeIssueDetail,
  ForgeProvider,
} from './provider';

export {
  stateOf,
  mapCheckRunState,
  mapGithubUser,
  mapGithubPr,
  mapGithubIssue,
  mapGithubIssueComment,
  mapGithubReviewComment,
  mapGithubCheckSummary,
  mapGithubContext,
  mapGithubRepoRef,
  mapGitlabUser,
  mapGitlabMr,
  mapGitlabIssue,
  mapGitlabNoteComment,
  mapGitlabContext,
  mapGitlabRepoRef,
  mapGiteaUser,
  mapGiteaPr,
  mapGiteaIssue,
  mapGiteaComment,
  mapGiteaContext,
  mapGiteaRepoRef,
} from './normalize';

export {
  buildForgeProvider,
  createGithubForgeProvider,
  createGitlabForgeProvider,
  createGiteaForgeProvider,
} from './adapters';
