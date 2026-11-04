import { z } from 'zod';
import { invalidProviderPayload } from './mappers.js';

const pullSchema = z.object({
  id: z.string().min(1),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  headRefOid: z.string(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  isInMergeQueue: z.boolean(),
  autoMergeRequest: z.object({ enabledAt: z.string(), mergeMethod: z.string() }).nullable(),
});

/** Read only after a refused merge, or to cancel/reconcile a waiting merge. */
export async function readWaitingMerge(octokit, project, target) {
  const data = await octokit.graphql(`query($owner: String!, $repo: String!, $number: Int!, $base: String!) {
    repository(owner: $owner, name: $repo) {
      mergeQueue(branch: $base) { id }
      pullRequest(number: $number) {
        id state headRefOid mergeable mergeStateStatus isInMergeQueue
        autoMergeRequest { enabledAt mergeMethod }
      }
    }
  }`, { owner: project.owner, repo: project.name, number: target.number, base: target.base });
  const parsed = z.object({ repository: z.object({ mergeQueue: z.object({ id: z.string() }).nullable(), pullRequest: pullSchema }) }).safeParse(data);
  if (!parsed.success) throw invalidProviderPayload('GitHub returned an invalid waiting merge state');
  return { pull: parsed.data.repository.pullRequest, hasQueue: parsed.data.repository.mergeQueue !== null };
}

/** Preserve bypass semantics: the ordinary merge is always attempted first. */
export async function enableMergeWhenReady(octokit, project, target, method) {
  let waiting;
  try { waiting = await readWaitingMerge(octokit, project, target); }
  catch { return null; }
  const { pull, hasQueue } = waiting;
  if (hasQueue || pull.state !== 'OPEN' || pull.headRefOid !== target.headSha
    || pull.mergeable === 'CONFLICTING' || !['BLOCKED', 'UNSTABLE'].includes(pull.mergeStateStatus)) return null;
  if (!pull.autoMergeRequest) {
    const data = await octokit.graphql(`mutation($id: ID!, $mergeMethod: PullRequestMergeMethod!, $sha: GitObjectID!) {
      enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $mergeMethod, expectedHeadOid: $sha }) {
        pullRequest { autoMergeRequest { enabledAt } }
      }
    }`, { id: pull.id, mergeMethod: method.toUpperCase(), sha: target.headSha });
    if (!data?.enablePullRequestAutoMerge?.pullRequest?.autoMergeRequest?.enabledAt) {
      throw invalidProviderPayload('GitHub did not confirm auto-merge');
    }
  }
  return { merged: false, outcome: 'auto-merge' };
}

export async function cancelWaitingMerge(octokit, project, target) {
  let { pull } = await readWaitingMerge(octokit, project, target);
  if (pull.state === 'MERGED') return { merged: true };
  if (pull.isInMergeQueue) {
    const data = await octokit.graphql(`mutation($id: ID!) {
      dequeuePullRequest(input: { id: $id }) { mergeQueueEntry { id } }
    }`, { id: pull.id });
    if (!Object.hasOwn(data ?? {}, 'dequeuePullRequest')) throw invalidProviderPayload('GitHub did not confirm dequeue');
    // Dequeue can also clear auto-merge. Re-read before issuing a disable
    // against a request that may no longer exist.
    ({ pull } = await readWaitingMerge(octokit, project, target));
    if (pull.state === 'MERGED') return { merged: true };
    if (pull.isInMergeQueue) throw invalidProviderPayload('GitHub did not confirm leaving the merge queue');
  }
  if (pull.autoMergeRequest) {
    const data = await octokit.graphql(`mutation($id: ID!) {
      disablePullRequestAutoMerge(input: { pullRequestId: $id }) { pullRequest { autoMergeRequest { enabledAt } } }
    }`, { id: pull.id });
    if (data?.disablePullRequestAutoMerge?.pullRequest?.autoMergeRequest !== null) {
      throw invalidProviderPayload('GitHub did not confirm disabling auto-merge');
    }
  }
  return { merged: false, outcome: 'cancelled' };
}
