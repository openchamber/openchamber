/**
 * `GET /api/openchamber/message-search`
 *
 *   q          words to find (each must occur; 3+ characters each)
 *   session    only this session (in-conversation search)
 *   directory  only sessions in these directories (repeatable)
 *   role       'user' | 'assistant' | 'reasoning'
 *   reasoning  '0' leaves reasoning hits out (the reader hides reasoning)
 *   order      'desc' (newest first, default) | 'asc'
 *   before     page cursor from a previous answer's `next` (`<createdAt>:<id>`)
 *   limit      page size, 1..200
 *
 * Answers `{ status: 'ok', hits, next, index }` or
 * `{ status: 'query-too-short', hits: [] }`; 503 when no index is running
 * (search is off, or this server has no SQLite).
 * Snippets mark matches with U+E000 / U+E001 and are plain text.
 *
 * `GET /api/openchamber/message-search/status` answers
 * `{ state: 'unsupported' | 'off' | 'on' | 'failed', sizeBytes, index }`.
 *
 * `DELETE /api/openchamber/message-search/index` deletes the index file; while
 * search is on a new one starts at once. Answers the status afterwards.
 */

import { z } from 'zod';

// Express hands repeated query keys over as arrays; each field is read as the
// shape it may take, once.
const text = z.string().trim().catch('');
const querySchema = z.object({
  q: text,
  session: text,
  role: z.enum(['user', 'assistant', 'reasoning']).nullable().catch(null),
  reasoning: z.enum(['0', '1']).catch('1'),
  order: z.enum(['asc', 'desc']).catch('desc'),
  before: text,
  limit: z.coerce.number().int().catch(20),
  directory: z.union([z.string(), z.array(z.string())]).catch([]),
});

const parseBefore = (raw) => {
  const separator = raw.indexOf(':');
  if (separator <= 0) return null;
  const createdAt = Number(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  return Number.isFinite(createdAt) && id ? { createdAt, id } : null;
};

export const registerMessageSearchRoutes = (app, { messageSearchRuntime }) => {
  app.get('/api/openchamber/message-search/status', async (_req, res) => {
    try {
      return res.json(await messageSearchRuntime.status());
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Could not read the search index status' });
    }
  });

  app.delete('/api/openchamber/message-search/index', async (_req, res) => {
    try {
      await messageSearchRuntime.deleteIndex();
      return res.json(await messageSearchRuntime.status());
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Could not delete the search index' });
    }
  });

  app.get('/api/openchamber/message-search', (req, res) => {
    const query = querySchema.parse({ role: null, ...req.query });
    const directories = (Array.isArray(query.directory) ? query.directory : [query.directory])
      .map((directory) => directory.trim())
      .filter(Boolean);
    try {
      const result = messageSearchRuntime.search({
        query: query.q,
        sessionId: query.session || null,
        directories,
        role: query.role,
        includeReasoning: query.reasoning === '1',
        before: parseBefore(query.before),
        limit: query.limit,
        order: query.order,
      });
      if (!result) return res.status(503).json({ error: 'Message search is off on this server' });
      return res.json({
        ...result,
        next: result.next ? `${result.next.createdAt}:${result.next.id}` : null,
      });
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Search failed' });
    }
  });
};
