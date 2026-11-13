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

const CHILDREN_PAGE_SIZE = 50;
const CHILDREN_MAX_PAGES = 8;
const MAX_SUBAGENT_DEPTH = 8;
const sessionLineageSchema = z.object({ id: z.string().min(1), parentID: z.string().min(1).nullish() });
const runningShellsSchema = z.array(z.object({
  status: z.string(),
  command: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
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
   * v2 has no `/session/{id}/children`; `GET /api/session?parentID=` lists a
   * parent's subagent sessions, newest first, in cursor pages. Later pages
   * carry the filter inside the cursor, so only the cursor and the limit
   * travel. A parent with more subagents than this walks is unknown (`null`).
   */
  const fetchChildSessionIds = async (sessionId) => {
    const ids = [];
    const seenCursors = new Set();
    let cursor;
    for (let pageNumber = 0; pageNumber < CHILDREN_MAX_PAGES; pageNumber += 1) {
      const page = await openCodeGet('/api/session', {
        limit: String(CHILDREN_PAGE_SIZE),
        ...(cursor ? { cursor } : { parentID: sessionId }),
      }).catch(() => null);
      if (!Array.isArray(page?.data)) return null;
      for (const child of page.data) {
        if (typeof child?.id === 'string' && child.id) ids.push(child.id);
      }
      const next = page.cursor?.next;
      if (!next || page.data.length === 0 || seenCursors.has(next)) return ids;
      seenCursors.add(next);
      cursor = next;
    }
    return null;
  };

  /** True when a subagent of the session is still running; null when unknown. */
  const hasWorkingChildren = async (sessionId, statuses) => {
    const children = await fetchChildSessionIds(sessionId);
    if (!children) return null;
    return children.some((id) => Boolean(statuses[id]));
  };

  /**
   * Queue delivery waits for running descendants, including nested subagents.
   * A chain deeper than `MAX_SUBAGENT_DEPTH` counts as unrelated, as in the
   * UI's ancestor walk, so a deep tree elsewhere cannot hold every queue.
   */
  const hasWorkingDescendants = async (sessionId, statuses) => {
    const parents = new Map();
    const signal = requestSignal();
    let unknown = false;
    for (const activeId of Object.keys(statuses)) {
      if (activeId === sessionId) continue;
      let current = activeId;
      const visited = new Set();
      for (let depth = 0; current && depth < MAX_SUBAGENT_DEPTH; depth += 1) {
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

  return { fetchActiveSessionStatuses, fetchChildSessionIds, hasWorkingChildren, hasWorkingDescendants, fetchRunningShells };
};
