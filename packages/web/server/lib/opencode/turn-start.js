/**
 * When a running turn began, read back from the session's history.
 *
 * The server learns a turn's start live from `session.execution.started`. A
 * turn that was already running when this server started listening (the
 * server restarted mid-turn, or its stream dropped across the start) has no
 * such event, so its start is read from the history instead: OpenCode 2 writes
 * an `idle` record when a turn ends, and the running turn began with the first
 * message after the last one.
 */

import { z } from 'zod';
import { unwrapOpenCodeResponse } from './response-envelope.js';

const PAGE_SIZE = 50;
// A turn longer than this many records is told as unknown rather than paged
// through to its first message.
const MAX_PAGES = 10;
// Settings changes are recorded when the user makes them, which may be long
// before the next prompt; they never begin a turn.
const NOT_A_TURN_MESSAGE = new Set(['agent-switched', 'model-switched', 'location-switched']);

const recordSchema = z.object({ type: z.string(), time: z.object({ created: z.number() }) });
const pageSchema = z.object({
  data: z.array(z.unknown()),
  cursor: z.object({ next: z.string().nullish() }).nullish(),
});

export const createTurnStartReader = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, timeoutMs = 10_000, fetchImpl = fetch }) => {
  const readPage = async (sessionId, cursor) => {
    const base = buildOpenCodeUrl(`/api/session/${encodeURIComponent(sessionId)}/message`, '');
    // Later pages carry the order inside the cursor, so only the cursor and the limit travel.
    const query = new URLSearchParams(cursor ? { limit: String(PAGE_SIZE), cursor } : { limit: String(PAGE_SIZE), order: 'desc' });
    const response = await fetchImpl(`${base}?${query}`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const page = pageSchema.safeParse(unwrapOpenCodeResponse(await response.json().catch(() => null)));
    return page.success ? page.data : null;
  };

  /**
   * Epoch ms of the running turn's first message, newest records first, or
   * null when it cannot be told: a failed read, a session whose latest record
   * ends a turn, or a turn longer than the pages walked.
   */
  const readTurnStart = async (sessionId) => {
    let start = null;
    let cursor;
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const page = await readPage(sessionId, cursor).catch(() => null);
      if (!page) return null;
      for (const value of page.data) {
        const record = recordSchema.safeParse(value);
        if (!record.success) continue;
        if (record.data.type === 'idle') return start;
        if (!NOT_A_TURN_MESSAGE.has(record.data.type)) start = record.data.time.created;
      }
      // A short page is the session's first: its first turn is still running.
      if (page.data.length < PAGE_SIZE || !page.cursor?.next) return start;
      cursor = page.cursor.next;
    }
    return null;
  };

  return { readTurnStart };
};
