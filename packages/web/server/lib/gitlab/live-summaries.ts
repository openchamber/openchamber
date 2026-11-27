import { isPlainObject, isString } from './validation.js';
import type { createGitLabClient } from './client.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';

type Client = ReturnType<typeof createGitLabClient>;
type Reply = Awaited<ReturnType<Client['MergeRequests']['show']>>;
type Field = JsonValue | undefined;
type Ref = { owner: string; repo: string; number: number };

const PIPELINE_PENDING = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'manual', 'scheduled']);

const isObject = (value: unknown): value is JsonObject => isPlainObject(value);
const integer = (value: Field): value is number => Number.isInteger(value);
const hasIid = (value: Reply): value is JsonObject & { iid: number } => isObject(value) && integer(value.iid);
const obj = (value: Field): JsonObject | undefined => (isObject(value) ? value : undefined);
const text = (value: Field) => (isString(value) && value ? value : '');

export function liveMergeRequestSummary(ref: Ref, raw: Reply) {
  if (!hasIid(raw)) return null;
  const state = raw.state === 'opened' ? 'open' : raw.state === 'merged' ? 'merged' : 'closed';
  const conflicts = raw.has_conflicts === true;
  const ready = raw.detailed_merge_status === 'mergeable';
  const pipeline = text(obj(raw.head_pipeline)?.status);
  let checks = null;
  if (state === 'open' && pipeline) {
    const outcome = pipeline === 'success' || pipeline === 'skipped' ? 'success'
      : pipeline === 'failed' || pipeline === 'canceled' ? 'failure'
        : PIPELINE_PENDING.has(pipeline) ? 'pending' : 'unknown';
    checks = {
      state: outcome,
      total: 1,
      success: outcome === 'success' ? 1 : 0,
      failure: outcome === 'failure' ? 1 : 0,
      pending: outcome === 'pending' ? 1 : 0,
    };
  }
  const summary = {
    owner: ref.owner,
    repo: ref.repo,
    number: raw.iid,
    state,
    draft: raw.draft === true || raw.work_in_progress === true,
    title: isString(raw.title) ? raw.title : '',
    mergeable: conflicts ? false : ready ? true : null,
    mergeableState: conflicts ? 'dirty' : ready ? 'clean' : null,
    checks,
  };
  if (text(raw.sha)) Object.assign(summary, { headSha: raw.sha });
  if (text(raw.source_branch)) Object.assign(summary, { head: raw.source_branch });
  if (text(raw.target_branch)) Object.assign(summary, { base: raw.target_branch });
  if (integer(raw.user_notes_count)) Object.assign(summary, { activity: raw.user_notes_count });
  return summary;
}

export function liveIssueSummary(ref: Ref, raw: Reply) {
  if (!hasIid(raw)) return null;
  return { owner: ref.owner, repo: ref.repo, number: raw.iid, title: isString(raw.title) ? raw.title : '', state: raw.state === 'opened' ? 'open' : 'completed' };
}
