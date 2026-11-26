import { isPlainObject } from './validation.js';
import type { JsonValue } from '../shared/json-values.js';
import type { createGitLabClient } from './client.js';

type Client = ReturnType<typeof createGitLabClient>;
type NumberedTarget = { projectId: string; number: number };

const UNKNOWN = { state: 'outcome-unknown' } as const;

export async function reconcileReviewDismiss(client: Client, providerTarget: NumberedTarget): Promise<{ state: string; result?: object }> {
  const { projectId, number } = providerTarget;
  let approvals: JsonValue;
  try {
    // SAFETY: the GitLab requester parses a JSON body for the merge request approvals.
    approvals = await client.MergeRequestApprovals.showConfiguration(projectId, { mergerequestIId: number }) as JsonValue;
  } catch {
    return UNKNOWN;
  }
  return isPlainObject(approvals) && approvals.user_has_approved === false ? { state: 'succeeded', result: {} } : UNKNOWN;
}

export async function dismissReview(client: Client, providerTarget: NumberedTarget) {
  const { projectId, number } = providerTarget;
  await client.MergeRequestApprovals.unapprove(projectId, number);
  const confirmed = await reconcileReviewDismiss(client, providerTarget);
  if (confirmed.state !== 'succeeded') throw new Error('GitLab did not confirm that the approval was withdrawn');
  return {};
}
