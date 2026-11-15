/**
 * Whether a session's turn has really ended.
 *
 * A parent session goes idle while a background subagent keeps working in a
 * child session. When the child finishes, OpenCode delivers its result to the
 * parent, which runs again and goes idle a second time. So the parent's first
 * idle is a pause, not the end of the turn: anything that treats idle as
 * "done" (goal audits, ready notifications) has to check the children too.
 *
 * Every read answers `null` when OpenCode could not be asked: "could not look"
 * must never pass for "nothing is running".
 */

import { unwrapOpenCodeResponse } from './response-envelope.js';
import { z } from 'zod';

/** OpenCode's 30-minute image timeout, plus a minute. */
const IMAGE_JOB_LIFETIME_MS = 31 * 60 * 1000;
const MAX_SUBAGENT_DEPTH = 8;
const sessionLineageSchema = z.object({ id: z.string().min(1), parentID: z.string().min(1).nullish() });
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

  /**
   * `/api/session/active` is global and lists only the sessions running right
   * now (`{ data: { [id]: status } }`), so an absent id is idle.
   */
  const fetchActiveSessionStatuses = async () => {
    const statuses = await openCodeGet('/api/session/active').catch(() => null);
    return statuses && typeof statuses === 'object' && !Array.isArray(statuses) ? statuses : null;
  };

  /**
   * Read only active sessions' ancestry. Direct-child checks take one link;
   * queue delivery follows up to MAX_SUBAGENT_DEPTH, as in the UI. A chain
   * deeper than the requested depth is outside that check's scope.
   */
  const hasWorkingWithinDepth = async (sessionId, statuses, maxDepth) => {
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
          parents.set(current, parsed.success && parsed.data.id === current ? parsed.data.parentID ?? null : undefined);
        }
        const parentId = parents.get(current);
        if (parentId === undefined) {
          unknown = true;
          break;
        }
        if (parentId === sessionId) return true;
        current = parentId;
      }
    }
    return unknown ? null : false;
  };

  /**
   * Commands still running in a directory, each with the session that started
   * it (`metadata.sessionID`, set by OpenCode's shell tool). `shell.list` is
   * location-scoped, so the directory travels in the header; name only one
   * that is already running. Null when OpenCode could not be asked.
   */
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

  /**
   * Background work still running for a session and every subagent under it:
   * subagents, shell commands and image generations, each with the session
   * that owns it. OpenCode's `job.list` (2.2.6+) is global, so it starts no
   * folder. `undefined` when this OpenCode has no such route (an unknown route
   * answers a bare 404), so the caller keeps its older reads; `null` when
   * OpenCode could not be asked or no longer has the session.
   */
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
      // OpenCode gives up on an image after 30 minutes; one listed as running
      // past that was left by an OpenCode that stopped mid-generation (2.2.6
      // keeps it in the list after a restart), and would hold a goal forever.
      .filter((job) => job.kind !== 'image' || now - job.time.started <= IMAGE_JOB_LIFETIME_MS)
      .map((job) => ({ kind: job.kind, sessionID: job.sessionID, command: job.command, startedAt: job.time.started }));
  };

  return {
    fetchActiveSessionStatuses,
    hasWorkingChildren: (sessionId, statuses) => hasWorkingWithinDepth(sessionId, statuses, 1),
    hasWorkingDescendants: (sessionId, statuses) => hasWorkingWithinDepth(sessionId, statuses, MAX_SUBAGENT_DEPTH),
    fetchRunningShells,
    fetchRunningBackgroundJobs,
  };
};
