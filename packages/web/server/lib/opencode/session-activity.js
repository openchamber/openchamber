
import { z } from 'zod';

import { sessionParentId } from '../session-lineage.js';
import { unwrapOpenCodeResponse } from './response-envelope.js';

const IMAGE_JOB_LIFETIME_MS = 31 * 60 * 1000;
const MAX_SUBAGENT_DEPTH = 8;
const MAX_LINEAGE_WALKS = 4;
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

export const createSessionActivityProbe = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, timeoutMs = 10_000, fetchImpl = fetch, signal: parentSignal, readSessionParent = null }) => {
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

  const readLineageOnce = (parents, sessionId, signal) => {
    if (!parents.has(sessionId)) {
      const pending = readSessionParent
        ? readSessionParent(sessionId, signal).then((parentID) => (
          parentID === undefined ? undefined : { id: parentID, viaWorkflowLink: false }
        ))
        : openCodeGet(`/api/session/${encodeURIComponent(sessionId)}`, undefined, signal).then((body) => {
          const parsed = sessionLineageSchema.safeParse(body);
          if (!parsed.success || parsed.data.id !== sessionId) return undefined;
          const parentID = sessionParentId(parsed.data);
          return { id: parentID, viaWorkflowLink: !parsed.data.parentID && parentID !== null };
        });
      parents.set(sessionId, Promise.resolve(pending).catch(() => undefined));
    }
    return parents.get(sessionId);
  };

  const walkAncestors = async ({ sessionId, maxDepth, signal, parents, visit }) => {
    let current = sessionId;
    const visited = new Set();
    for (let depth = 0; current && depth < maxDepth; depth += 1) {
      if (signal.aborted) return 'unknown';
      if (visited.has(current)) return 'cycle';
      visited.add(current);
      const parent = await readLineageOnce(parents, current, signal);
      if (parent === undefined) return 'unknown';
      const outcome = visit(parent, depth);
      if (outcome) return outcome;
      current = parent.id;
    }
    return 'end';
  };

  const hasWorkingWithinDepth = async (sessionId, statuses, maxDepth, directOnly = false) => {
    const parents = new Map();
    const signal = requestSignal();
    let unknown = false;
    for (const activeId of Object.keys(statuses)) {
      if (activeId === sessionId) continue;
      const outcome = await walkAncestors({
        sessionId: activeId,
        maxDepth,
        signal,
        parents,
        visit: (parent, depth) => {
          if (parent.id !== sessionId) return null;
          if (!directOnly || depth === 0 || parent.viaWorkflowLink) return 'found';
          return 'end';
        },
      });
      if (signal.aborted) return null;
      if (outcome === 'found') return true;
      if (outcome === 'unknown' || outcome === 'cycle') unknown = true;
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

  const collectDescendantSessions = async (ancestorId, candidateIds, maxDepth = MAX_SUBAGENT_DEPTH) => {
    if (!ancestorId || candidateIds.length === 0) return [];
    const signal = requestSignal();
    const parents = new Map();
    const descendants = new Set();
    let unknown = false;

    const isDescendant = async (candidateId) => {
      const outcome = await walkAncestors({
        sessionId: candidateId,
        maxDepth,
        signal,
        parents,
        visit: (parent) => (parent.id === ancestorId ? 'found' : null),
      });
      if (outcome === 'found') descendants.add(candidateId);
      else if (outcome === 'unknown') unknown = true;
    };

    let next = 0;
    const walk = async () => {
      while (!signal.aborted && next < candidateIds.length) {
        const candidateId = candidateIds[next];
        next += 1;
        await isDescendant(candidateId);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_LINEAGE_WALKS, candidateIds.length) }, walk));

    if (unknown || signal.aborted) return null;
    return candidateIds.filter((candidateId) => descendants.has(candidateId));
  };

  return {
    fetchActiveSessionStatuses,
    collectDescendantSessions,
    hasWorkingChildren: (sessionId, statuses) => hasWorkingWithinDepth(sessionId, statuses, MAX_SUBAGENT_DEPTH, true),
    hasWorkingDescendants: (sessionId, statuses) => hasWorkingWithinDepth(sessionId, statuses, MAX_SUBAGENT_DEPTH),
    fetchRunningShells,
    fetchRunningBackgroundJobs,
  };
};
