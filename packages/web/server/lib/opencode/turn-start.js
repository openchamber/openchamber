
import { z } from 'zod';
import { unwrapOpenCodeResponse } from './response-envelope.js';

const PAGE_SIZE = 50;
const MAX_PAGES = 10;
const NOT_A_TURN_MESSAGE = new Set(['agent-switched', 'model-switched', 'location-switched']);

const recordSchema = z.object({ type: z.string(), time: z.object({ created: z.number() }) });
const pageSchema = z.object({
  data: z.array(z.unknown()),
  cursor: z.object({ next: z.string().nullish() }).nullish(),
});

export const createTurnStartReader = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, timeoutMs = 10_000, fetchImpl = fetch }) => {
  const readPage = async (sessionId, cursor) => {
    const base = buildOpenCodeUrl(`/api/session/${encodeURIComponent(sessionId)}/message`, '');
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
      if (page.data.length < PAGE_SIZE || !page.cursor?.next) return start;
      cursor = page.cursor.next;
    }
    return null;
  };

  return { readTurnStart };
};
