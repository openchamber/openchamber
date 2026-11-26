import { isPlainObject, isString } from './validation.js';
import { dismissReview, reconcileReviewDismiss } from './review-dismiss.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { SourceControlProjectRef, SourceControlReviewSummary } from '@openchamber/sdk';
import type { createGitLabClient } from './client.js';

type Client = ReturnType<typeof createGitLabClient>;

const isJsonObject = (value: JsonValue | undefined): value is JsonObject => isPlainObject(value);
const at = (value: JsonValue | undefined, key: string): JsonValue | undefined => (isJsonObject(value) ? value[key] : undefined);

interface ReviewAuthor { login: string; avatarUrl?: string }

const approverOf = (user: JsonValue | undefined, approvedAt: JsonValue | undefined): SourceControlReviewSummary | null => {
  const username = at(user, 'username');
  if (!isString(username) || !username) return null;
  const snakeCaseAvatar = at(user, 'avatar_url');
  const camelCaseAvatar = at(user, 'avatarUrl');
  const avatarUrl = isString(snakeCaseAvatar) ? snakeCaseAvatar : isString(camelCaseAvatar) ? camelCaseAvatar : undefined;
  const author: ReviewAuthor = { login: username };
  if (avatarUrl !== undefined) author.avatarUrl = avatarUrl;
  return {
    id: `approval:${username}`,
    state: 'approved',
    author,
    submittedAt: isString(approvedAt) ? approvedAt : null,
  };
};

// external: https://docs.gitlab.com/api/merge_request_approvals/#retrieve-approval-state-for-a-merge-request `/approvals` lists every approver on all tiers; `/approval_state` is Premium-only and omits approvals outside the rules.
export const readReviewSummaries = async (
  client: Client, project: SourceControlProjectRef, number: number,
): Promise<SourceControlReviewSummary[] | undefined> => {
  let approvals: JsonValue;
  try {
    // SAFETY: the GitLab requester parses a JSON body for the merge request approvals.
    approvals = await client.MergeRequestApprovals.showConfiguration(project.id, { mergerequestIId: number }) as JsonValue;
  } catch {
    return undefined;
  }
  const approvedBy = at(approvals, 'approved_by');
  if (!Array.isArray(approvedBy)) return undefined;
  const approvers = approvedBy.map((entry) => approverOf(at(entry, 'user'), at(entry, 'approved_at')));
  const seen = new Set<string>();
  const summaries = approvers.filter((approver): approver is SourceControlReviewSummary => {
    if (!approver || seen.has(approver.id)) return false;
    seen.add(approver.id);
    return true;
  });
  return summaries.length === 0 && approvers.length > 0 ? undefined : summaries;
};

export const toReviewPerson = (value: Awaited<ReturnType<Client['Users']['showCurrentUser']>> | undefined) => {
  const user = isPlainObject(value) ? value : undefined;
  const username = user?.username;
  const avatarUrl = user?.avatar_url;
  return isString(username) ? { login: username, avatarUrl: isString(avatarUrl) ? avatarUrl : undefined } : null;
};

export const gitlabReviewMethods = <Target extends { projectId: string; number: number }>(client: Client) => ({
  dismissReview: (payload: { providerTarget: Target }) => dismissReview(client, payload.providerTarget),
  reconcileReviewDismiss: (providerTarget: Target) => reconcileReviewDismiss(client, providerTarget),
});

export const reviewField = (reviews: SourceControlReviewSummary[] | undefined) => (reviews === undefined ? {} : { reviews });
