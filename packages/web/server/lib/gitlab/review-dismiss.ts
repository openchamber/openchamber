import { approvalRulesOf, approversOf } from './review-summaries.js';
import { isPlainObject } from './validation.js';
import type { JsonValue } from '../shared/json-values.js';
import type { createGitLabClient } from './client.js';

type Client = ReturnType<typeof createGitLabClient>;
type NumberedTarget = { projectId: string; number: number };

const isJsonObject = (value: JsonValue | undefined): value is Record<string, JsonValue | undefined> => isPlainObject(value);
const at = (value: JsonValue | undefined, key: string): JsonValue | undefined => (isJsonObject(value) ? value[key] : undefined);

export async function dismissReview(client: Client, providerTarget: NumberedTarget) {
  const { projectId, number } = providerTarget;
  await client.MergeRequestApprovals.unapprove(projectId, number);
  return {};
}

export async function reconcileReviewDismiss(client: Client, providerTarget: NumberedTarget): Promise<{ state: string; result?: object }> {
  const { projectId, number } = providerTarget;
  const [state, viewer] = await Promise.all([
    client.MergeRequestApprovals.showApprovalState(projectId, number),
    client.Users.showCurrentUser(),
  ]);
  // SAFETY: the GitLab requester parses a JSON body for the approval state.
  const approvalState = state as JsonValue;
  // SAFETY: the GitLab requester parses a JSON body for the current user.
  const currentUser = viewer as JsonValue;
  const rules = approvalRulesOf(approvalState);
  if (!rules.length && !at(approvalState, 'rules') && !at(approvalState, 'approval_rules')) return { state: 'outcome-unknown' };
  const viewerId = at(currentUser, 'id');
  if (!Number.isInteger(viewerId)) return { state: 'outcome-unknown' };
  const approved = approversOf(rules);
  return approved.some((approver) => at(approver, 'id') === viewerId)
    ? { state: 'outcome-unknown' } : { state: 'succeeded', result: {} };
}
