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

const CHILDREN_PAGE_SIZE = 50;
const CHILDREN_MAX_PAGES = 8;

export const createSessionActivityProbe = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, timeoutMs = 10_000, fetchImpl = fetch }) => {
  const openCodeGet = async (fetchPath, query) => {
    const base = buildOpenCodeUrl(fetchPath, '');
    const search = new URLSearchParams(query || {}).toString();
    const response = await fetchImpl(search ? `${base}?${search}` : base, {
      method: 'GET',
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      signal: AbortSignal.timeout(timeoutMs),
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

  return { fetchActiveSessionStatuses, fetchChildSessionIds, hasWorkingChildren };
};
