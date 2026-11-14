/**
 * `GET /api/session-todos/:sessionId?directory=` answers
 * `{ revision, state: 'off' }` while OpenCode's `todowrite` tool is off in that
 * directory, else `{ revision, state: 'ready', todos: [{ content, status }] }`.
 * 502 when it cannot be told (OpenCode did not answer).
 */
import { z } from 'zod';
import { sessionIdSchema } from './runtime.js';

const querySchema = z.object({ directory: z.string().trim().min(1) });

/**
 * @param {import('express').Express} app
 * @param {object} options
 * @param {ReturnType<typeof import('./runtime.js').createSessionTodosRuntime>} options.sessionTodosRuntime
 */
export const registerSessionTodosRoutes = (app, { sessionTodosRuntime }) => {
  app.get('/api/session-todos/:sessionId', async (req, res) => {
    const sessionId = sessionIdSchema.safeParse(req.params.sessionId);
    const query = querySchema.safeParse(req.query);
    if (!sessionId.success || !query.success) return res.status(400).json({ error: 'a session id and directory are required' });
    try {
      return res.json(await sessionTodosRuntime.read(sessionId.data, query.data.directory));
    } catch (error) {
      console.warn('[session-todos] failed to read:', error?.message ?? error);
      return res.status(502).json({ error: 'OpenCode did not answer' });
    }
  });
};
