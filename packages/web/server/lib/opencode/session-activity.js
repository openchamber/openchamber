
import { z } from 'zod';

import { sessionParentId } from '../session-lineage.js';
import { unwrapOpenCodeResponse } from './response-envelope.js';

const IMAGE_JOB_LIFETIME_MS = 31 * 60 * 1000;
const MAX_SUBAGENT_DEPTH = 8;
const sessionLineageSchema = z.object({
  id: z.string().min(1),
  parentID: z.string().min(1).nullish(),
  metadata: z.unknown().optional(),
});
const runningShellsSchema = z.array(z.object({
  status: z.string(),
  command: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  time: z.object({ started: z.number() }),
}));
const backgroundJobsSchema = z.array(z.object({
  kind: z.string(),
  sessionID: z.string(),
  status: z.string(),
  command: z.string().optional(),
  time: z.object({ started: z.number() }),
}));

export const createSessionActivityProbe = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, timeoutMs = 10_000, fetchImpl = fetch, signal: parentSignal }) => {
  const requestSignal = () => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
  };
  const openCodeGet = async (fetchPath, query, signal = requestSignal()) => {
    const base = buildOpenCodeUrl(fetchPath, '');
    const search = new URLSearchParams(query || {}).toString();
    const response = await fetchImpl(search ? `${base}?${search}` : base, {
      method: 'GET',
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      signal,
    });
    if (!response.ok) {
      throw new Error(`OpenCode GET ${fetchPath} failed with ${response.status}`);
    }
    return unwrapOpenCodeResponse(await response.json().catch(() => null));
  };

  const fetchActiveSessionStatuses = async () => {
    const statuses = await openCodeGet('/api/session/active').catch(() => null);
    return statuses && typeof statuses === 'object' && !Array.isArray(statuses) ? statuses : null;
  };

  const hasWorkingWithinDepth = async (sessionId, statuses, maxDepth, directOnly = false) => {
    const parents = new Map();
    const signal = requestSignal();
    let unknown = false;
    for (const activeId of Object.keys(statuses)) {
      if (activeId === sessionId) continue;
      let current = activeId;
      const visited = new Set();
      for (let depth = 0; current && depth < maxDepth; depth += 1) {
        if (signal.aborted) return null;
        if (visited.has(current)) {
          unknown = true;
          break;
        }
        visited.add(current);
        if (!parents.has(current)) {
          const body = await openCodeGet(`/api/session/${encodeURIComponent(current)}`, undefined, signal).catch(() => null);
          const parsed = sessionLineageSchema.safeParse(body);
          parents.set(current, parsed.success && parsed.data.id === current
            ? { id: sessionParentId(parsed.data), viaWorkflowLink: !parsed.data.parentID && sessionParentId(parsed.data) !== null }
            : undefined);
        }
        const parent = parents.get(current);
        if (parent === undefined) {
          unknown = true;
          break;
        }
        if (parent.id === sessionId) {
          if (!directOnly || depth === 0 || parent.viaWorkflowLink) return true;
          break;
        }
        current = parent.id;
      }
    }
    return unknown ? null : false;
  };

  const fetchRunningShells = async (directory) => {
    const base = buildOpenCodeUrl('/api/shell', '');
    const response = await fetchImpl(base, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'x-opencode-directory': encodeURIComponent(directory),
        ...getOpenCodeAuthHeaders(),
      },
      signal: requestSignal(),
    }).catch(() => null);
    if (!response?.ok) return null;
    const parsed = runningShellsSchema.safeParse(unwrapOpenCodeResponse(await response.json().catch(() => null)));
    if (!parsed.success) return null;
    return parsed.data.flatMap((shell) => {
      const owner = shell.metadata?.sessionID;
      if (shell.status !== 'running' || typeof owner !== 'string' || !owner) return [];
      return [{ sessionID: owner, command: shell.command, startedAt: shell.time.started }];
    });
  };

  const fetchRunningBackgroundJobs = async (sessionId) => {
    const base = buildOpenCodeUrl('/api/experimental/job', '');
    const search = new URLSearchParams({ sessionID: sessionId, descendants: 'true', status: 'running' });
    const response = await fetchImpl(`${base}?${search}`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      signal: requestSignal(),
    }).catch(() => null);
    if (!response) return null;
    const body = await response.json().catch(() => null);
    if (response.status === 404 && !body?._tag) return undefined;
    if (!response.ok) return null;
    const parsed = backgroundJobsSchema.safeParse(unwrapOpenCodeResponse(body));
    if (!parsed.success) return null;
    const now = Date.now();
    return parsed.data
      .filter((job) => job.status === 'running')
      .filter((job) => job.kind !== 'image' || now - job.time.started <= IMAGE_JOB_LIFETIME_MS)
      .map((job) => ({ kind: job.kind, sessionID: job.sessionID, command: job.command, startedAt: job.time.started }));
  };

  return {
    fetchActiveSessionStatuses,
    hasWorkingChildren: (sessionId, statuses) => hasWorkingWithinDepth(sessionId, statuses, MAX_SUBAGENT_DEPTH, true),
    hasWorkingDescendants: (sessionId, statuses) => hasWorkingWithinDepth(sessionId, statuses, MAX_SUBAGENT_DEPTH),
    fetchRunningShells,
    fetchRunningBackgroundJobs,
  };
};
