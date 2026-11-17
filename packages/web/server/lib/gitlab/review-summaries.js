import { isString } from './validation.js';

export const approvalRulesOf = (state) => {
  if (Array.isArray(state?.rules)) return state.rules;
  return Array.isArray(state?.approval_rules) ? state.approval_rules : [];
};

export const approversOf = (rules) => rules.flatMap((rule) => (Array.isArray(rule?.approved_by) ? rule.approved_by : []));

const APPROVED_BY_QUERY = `query($path: ID!, $iid: String!) {
  project(fullPath: $path) {
    mergeRequest(iid: $iid) {
      approvedBy(first: 100) { nodes { username avatarUrl } }
    }
  }
}`;

/**
 * GitLab reports approvals two ways: per approval rule, and, on instances where a merge request
 * has no rules at all (nothing requires an approval), only through `approvedBy`. Reading just the
 * rules reports "nobody approved" for a merge request that is in fact approved.
 */
const readApprovedBy = async (client, path, number) => {
  try {
    const response = await client.MergeRequests.requester.post('../graphql', {
      body: { query: APPROVED_BY_QUERY, variables: { path, iid: String(number) } },
    });
    const nodes = response?.body?.data?.project?.mergeRequest?.approvedBy?.nodes;
    return Array.isArray(nodes) ? nodes : null;
  } catch {
    return null;
  }
};

const approverOf = (user, approvedAt) => {
  if (!isString(user?.username) || !user.username) return null;
  const avatarUrl = isString(user.avatar_url) ? user.avatar_url : isString(user.avatarUrl) ? user.avatarUrl : undefined;
  return {
    id: `approval:${user.username}`,
    state: 'approved',
    author: { login: user.username, avatarUrl },
    submittedAt: isString(approvedAt) ? approvedAt : null,
  };
};

export const readReviewSummaries = async (client, project, number) => {
  const rules = approvalRulesOf(await client.MergeRequestApprovals.showApprovalState(project.id, number));
  const fromRules = rules.flatMap((rule) => (Array.isArray(rule?.approved_by) ? rule.approved_by : [])
    .map((user) => approverOf(user, isString(user?.approved_at) ? user.approved_at : rule?.approved_at)));
  const approvers = fromRules.length > 0
    ? fromRules
    : (await readApprovedBy(client, `${project.owner}/${project.name}`, number) ?? []).map((user) => approverOf(user, null));
  const seen = new Set();
  return approvers.filter((approver) => {
    if (!approver || seen.has(approver.id)) return false;
    seen.add(approver.id);
    return true;
  });
};
