import { isPlainObject, isString } from './validation.js';
import { dismissReview, reconcileReviewDismiss } from './review-dismiss.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { SourceControlProjectRef, SourceControlReviewSummary } from '@openchamber/sdk';
import type { createGitLabClient } from './client.js';

type Client = ReturnType<typeof createGitLabClient>;

const isJsonObject = (value: JsonValue | undefined): value is JsonObject => isPlainObject(value);
const at = (value: JsonValue | undefined, key: string): JsonValue | undefined => (isJsonObject(value) ? value[key] : undefined);
const atPath = (value: JsonValue | undefined, ...keys: string[]): JsonValue | undefined =>
  keys.reduce<JsonValue | undefined>((current, key) => at(current, key), value);

export const approvalRulesOf = (state: JsonValue | undefined): JsonValue[] => {
  const rules = at(state, 'rules');
  if (Array.isArray(rules)) return rules;
  const approvalRules = at(state, 'approval_rules');
  return Array.isArray(approvalRules) ? approvalRules : [];
};

export const approversOf = (rules: JsonValue[]): JsonValue[] => rules.flatMap((rule) => {
  const approvedBy = at(rule, 'approved_by');
  return Array.isArray(approvedBy) ? approvedBy : [];
});

const APPROVED_BY_QUERY = `query($path: ID!, $iid: String!) {
  project(fullPath: $path) {
    mergeRequest(iid: $iid) {
      approvedBy(first: 100) { nodes { username avatarUrl } }
    }
  }
}`;

const readApprovedBy = async (client: Client, path: string, number: number): Promise<JsonValue[] | null> => {
  try {
    const response = await client.MergeRequests.requester.post('../graphql', {
      body: { query: APPROVED_BY_QUERY, variables: { path, iid: String(number) } },
    });
    // SAFETY: the GitLab requester parses a JSON body, and a GraphQL query answers JSON only.
    const nodes = atPath(response as JsonValue, 'body', 'data', 'project', 'mergeRequest', 'approvedBy', 'nodes');
    return Array.isArray(nodes) ? nodes : null;
  } catch {
    return null;
  }
};

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

export const readReviewSummaries = async (
  client: Client, project: SourceControlProjectRef, number: number,
): Promise<SourceControlReviewSummary[]> => {
  // SAFETY: the GitLab requester parses a JSON body for the approval state.
  const state = await client.MergeRequestApprovals.showApprovalState(project.id, number) as JsonValue;
  const rules = approvalRulesOf(state);
  const fromRules = rules.flatMap((rule) => {
    const approvedBy = at(rule, 'approved_by');
    return (Array.isArray(approvedBy) ? approvedBy : []).map((user) => {
      const own = at(user, 'approved_at');
      return approverOf(user, isString(own) ? own : at(rule, 'approved_at'));
    });
  });
  const approvers = fromRules.length > 0
    ? fromRules
    : (await readApprovedBy(client, `${project.owner}/${project.name}`, number) ?? []).map((user) => approverOf(user, null));
  const seen = new Set<string>();
  return approvers.filter((approver): approver is SourceControlReviewSummary => {
    if (!approver || seen.has(approver.id)) return false;
    seen.add(approver.id);
    return true;
  });
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
