import { mapGitLabUser, type GitLabIdentity, type GitLabMappedUser, type GitLabPayload } from './mappers.js';
import { isPlainObject, isString } from './validation.js';
import type { createGitLabClient } from './client.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { SourceControlProjectRef } from '@openchamber/sdk';

type Client = ReturnType<typeof createGitLabClient>;

export type GitLabReviewerState = {
  user: GitLabMappedUser;
  state: 'pending' | 'approved' | 'changes_requested' | 'commented' | 'dismissed';
};

const REVIEWER_STATES = new Map<string, GitLabReviewerState['state']>([
  ['unreviewed', 'pending'], ['reviewed', 'commented'], ['approved', 'approved'], ['requested_changes', 'changes_requested'],
  ['review_started', 'pending'], ['unapproved', 'pending'],
]);

const asPayload = (value: JsonValue | undefined): GitLabPayload | null => (isPlainObject(value) ? value : null);
const hasFields = (value: unknown): value is Record<string, unknown> => isPlainObject(value);
const integer = (value: unknown): value is number => Number.isInteger(value);

const DIFF_STATS_QUERY = `query($path: ID!, $iid: String!) {
  project(fullPath: $path) {
    mergeRequest(iid: $iid) { diffStats { path additions deletions } }
  }
}`;

export const readDiffStats = async (client: Client, project: SourceControlProjectRef, number: number) => {
  try {
    const response = await client.MergeRequests.requester.post('../graphql', {
      body: { query: DIFF_STATS_QUERY, variables: { path: `${project.owner}/${project.name}`, iid: String(number) } },
    });
    const body = hasFields(response?.body) ? response.body : undefined;
    const data = hasFields(body?.data) ? body.data : undefined;
    const projectNode = hasFields(data?.project) ? data.project : undefined;
    const mergeRequest = hasFields(projectNode?.mergeRequest) ? projectNode.mergeRequest : undefined;
    const stats = mergeRequest?.diffStats;
    if (!Array.isArray(stats)) return null;
    const byPath = new Map<string, { additions: number; deletions: number }>();
    for (const entry of stats) {
      if (!isPlainObject(entry) || !isString(entry.path) || !integer(entry.additions) || !integer(entry.deletions)) return null;
      byPath.set(entry.path, { additions: entry.additions, deletions: entry.deletions });
    }
    return byPath;
  } catch {
    return null;
  }
};

export const readReviewerStates = async (
  client: Client,
  projectId: string,
  number: number,
  raw: JsonObject | undefined,
  identity: GitLabIdentity,
): Promise<GitLabReviewerState[] | undefined> => {
  let reviewers: unknown;
  try {
    reviewers = await client.MergeRequests.showReviewers(projectId, number);
  } catch {
    return undefined;
  }
  if (!Array.isArray(reviewers)) return undefined;
  const states = new Map<string, GitLabReviewerState>();
  for (const entry of reviewers) {
    if (!isPlainObject(entry)) continue;
    const user = mapGitLabUser(asPayload(entry.user), identity);
    const state = isString(entry.state) ? REVIEWER_STATES.get(entry.state) : undefined;
    if (user && state && !states.has(user.id)) states.set(user.id, { user, state });
  }
  if (states.size === 0) {
    const approvals = raw?.approvals;
    const approved = isPlainObject(approvals) && Array.isArray(approvals.approved_by) ? approvals.approved_by : [];
    for (const user of approved) {
      const mapped = mapGitLabUser(asPayload(user), identity);
      if (mapped) states.set(mapped.id, { user: mapped, state: 'approved' });
    }
  }
  return [...states.values()];
};
