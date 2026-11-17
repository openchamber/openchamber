import { approvalRulesOf, approversOf } from './review-summaries.js';

export async function dismissReview(client, providerTarget) {
  const { projectId, number } = providerTarget;
  await client.MergeRequestApprovals.unapprove(projectId, number);
  return {};
}

export async function reconcileReviewDismiss(client, providerTarget) {
  const { projectId, number } = providerTarget;
  const [state, viewer] = await Promise.all([
    client.MergeRequestApprovals.showApprovalState(projectId, number),
    client.Users.showCurrentUser(),
  ]);
  const rules = approvalRulesOf(state);
  if (!rules.length && !state?.rules && !state?.approval_rules) return { state: 'outcome-unknown' };
  if (!Number.isInteger(viewer?.id)) return { state: 'outcome-unknown' };
  const approved = approversOf(rules);
  return approved.some((approver) => approver?.id === viewer.id)
    ? { state: 'outcome-unknown' } : { state: 'succeeded', result: {} };
}
