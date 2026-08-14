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
  ForgeCommitsResult,
  ForgeTimelineResult,
  ForgeChecksResult,
  ForgeUsersResult,
  ForgeLabelsResult,
  ForgeMilestonesResult,
  ForgeBranchesResult,
  ForgeTagsResult,
  ForgeProvider,
} from './provider';

export {
  stateOf,
  mapCheckRunState,
  firstLine,
  normalizeEventType,
  mapGithubUser,
  mapGithubAssignee,
  mapGithubPr,
  mapGithubIssue,
  mapGithubIssueComment,
  mapGithubReviewComment,
  mapGithubCheckSummary,
  mapGithubContext,
  mapGithubRepoRef,
  mapGithubCommits,
  mapGithubTimelineEvents,
  mapGitlabUser,
  mapGitlabMember,
  mapGitlabMr,
  mapGitlabIssue,
  mapGitlabNoteComment,
  mapGitlabContext,
  mapGitlabRepoRef,
  mapGitlabCommits,
  mapGitlabTimelineEvents,
  mapGiteaUser,
  mapGiteaAssignee,
  mapGiteaPr,
  mapGiteaIssue,
  mapGiteaComment,
  mapGiteaContext,
  mapGiteaRepoRef,
  mapGiteaCommits,
  mapGiteaStatuses,
  mapGiteaReviewsToEvents,
  mapStatusState,
  aggregateStatusState,
} from './normalize';

export {
  buildForgeProvider,
  createGithubForgeProvider,
  createGitlabForgeProvider,
  createGiteaForgeProvider,
} from './adapters';
