import { z } from 'zod';
import { sessionIdSchema } from './runtime.js';
import type { createSessionTodosRuntime } from './runtime.js';
import type { Response } from '../shared/http-contracts.js';

const querySchema = z.object({ directory: z.string().trim().min(1) });

type SessionTodosRuntime = ReturnType<typeof createSessionTodosRuntime>;
type SessionTodosResponse = Awaited<ReturnType<SessionTodosRuntime['read']>> | { error: string };

type RouteResponse = Response<SessionTodosResponse>;

interface SessionTodosApp {
  get: (path: string, handler: (
    req: { params: { sessionId?: unknown }; query: unknown },
    res: RouteResponse,
  ) => Promise<RouteResponse>) => void;
}

const hasErrorMessage = (value: unknown): value is { message: unknown } =>
  value !== null && value !== undefined && 'message' in Object(value);

export const registerSessionTodosRoutes = (app: SessionTodosApp, { sessionTodosRuntime }: { sessionTodosRuntime: SessionTodosRuntime }) => {
  app.get('/api/session-todos/:sessionId', async (req, res) => {
    const sessionId = sessionIdSchema.safeParse(req.params.sessionId);
    const query = querySchema.safeParse(req.query);
    if (!sessionId.success || !query.success) return res.status(400).json({ error: 'a session id and directory are required' });
    try {
      return res.json(await sessionTodosRuntime.read(sessionId.data, query.data.directory));
    } catch (error) {
      console.warn('[session-todos] failed to read:', (hasErrorMessage(error) ? error.message : undefined) ?? error);
      return res.status(502).json({ error: 'OpenCode did not answer' });
    }
  });
};
