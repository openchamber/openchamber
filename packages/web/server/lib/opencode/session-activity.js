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
import { readBoundedResponseJson } from '../shared/response-body.js';
import { z } from 'zod';

const CHILDREN_PAGE_SIZE = 50;
const CHILDREN_MAX_PAGES = 8;
// 16 MiB matches the session-list proxy cap and leaves room for a 50-record page.
const SESSION_ACTIVITY_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const sessionLineageSchema = z.object({ id: z.string().min(1), parentID: z.string().min(1).nullish() });
const activeSessionsSchema = z.record(z.string().min(1), z.object({ type: z.literal('running') }));

export const createSessionActivityProbe = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, timeoutMs = 10_000, fetchImpl = fetch }) => {
  const openCodeGet = async (fetchPath, query, signal = AbortSignal.timeout(timeoutMs)) => {
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
    return unwrapOpenCodeResponse(await readBoundedResponseJson(response, SESSION_ACTIVITY_RESPONSE_MAX_BYTES));
  };

  /**
   * `/api/session/active` is global and lists only the sessions running right
   * now (`{ data: { [id]: status } }`), so an absent id is idle.
   */
  const fetchActiveSessionStatuses = async () => {
    const statuses = await openCodeGet('/api/session/active').catch(() => null);
    const parsed = activeSessionsSchema.safeParse(statuses);
    return parsed.success ? parsed.data : null;
  };

  /**
   * v2 has no `/session/{id}/children`; `GET /api/session?parentID=` lists a
   * parent's subagent sessions, newest first, in cursor pages. Later pages
   * carry the filter inside the cursor, so only the cursor and the limit
   * travel. A parent with more subagents than this walks is unknown (`null`).
   */
  const fetchChildSessions = async (sessionId) => {
    const children = [];
    const seenCursors = new Set();
    let cursor;
    for (let pageNumber = 0; pageNumber < CHILDREN_MAX_PAGES; pageNumber += 1) {
      const page = await openCodeGet('/api/session', {
        limit: String(CHILDREN_PAGE_SIZE),
        ...(cursor ? { cursor } : { parentID: sessionId }),
      }).catch(() => null);
      if (!Array.isArray(page?.data)) return null;
      for (const child of page.data) {
        if (typeof child?.id === 'string' && child.id) children.push(child);
      }
      const next = page.cursor?.next;
      if (!next || page.data.length === 0 || seenCursors.has(next)) return children;
      seenCursors.add(next);
      cursor = next;
    }
    return null;
  };

  const fetchChildSessionIds = async (sessionId) => {
    const children = await fetchChildSessions(sessionId);
    return children ? children.map((child) => child.id) : null;
  };

  /** True when a subagent of the session is still running; null when unknown. */
  const hasWorkingChildren = async (sessionId, statuses) => {
    const children = await fetchChildSessionIds(sessionId);
    if (!children) return null;
    return children.some((id) => Boolean(Object.hasOwn(statuses, id) && statuses[id]));
  };

  /**
   * Queue delivery waits for running descendants, including nested subagents.
   * Chains count at any depth, as in the UI's ancestor walk. OpenCode's
   * `experimental.subagent_depth` has no upper bound, and the visited set
   * ends a walk whose parent links form a cycle.
   */
  // Parent links fetched for one active-status snapshot, shared by every
  // descendant check made against that snapshot: a sweep asking about
  // hundreds of candidates against the same active set would otherwise
  // re-fetch the same lineage records for every candidate. The cache is
  // keyed by the statuses object itself, so a fresh snapshot starts fresh
  // and the old one is collected with it.
  const lineageCaches = new WeakMap();

  const hasWorkingDescendants = async (sessionId, statuses) => {
    let parents = lineageCaches.get(statuses);
    if (!parents) {
      parents = new Map();
      lineageCaches.set(statuses, parents);
    }
    const signal = AbortSignal.timeout(timeoutMs);
    let unknown = false;
    for (const activeId of Object.keys(statuses)) {
      if (activeId === sessionId) continue;
      let current = activeId;
      const visited = new Set();
      while (current) {
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

  return { fetchActiveSessionStatuses, fetchChildSessions, fetchChildSessionIds, hasWorkingChildren, hasWorkingDescendants };
};
