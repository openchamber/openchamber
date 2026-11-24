import { deleteObjective, readObjective, writeObjective } from './objectives.js';
import type { ObjectiveContent } from './objectives.js';
import type { Request, Router } from '../shared/http-contracts.js';

type GoalRequest = Request<ObjectiveContent | undefined, { sessionId: string }>;
type GoalApp = Pick<Router, 'put' | 'get' | 'delete'>;

const isObjectiveBody = (value: ObjectiveContent): value is { [key: string]: ObjectiveContent } =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isRouteError = (value: unknown): value is { statusCode?: unknown; message?: unknown } =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

export function registerSessionGoalRoutes(app: GoalApp) {
  app.put('/api/goals/objective/:sessionId', async (req: GoalRequest, res) => {
    try {
      const body = req.body || {};
      const content = isObjectiveBody(body) ? body.content : undefined;
      await writeObjective(req.params.sessionId, content);
      res.json({ ok: true });
    } catch (error) {
      const statusCode = Number(isRouteError(error) ? error.statusCode : undefined) || 500;
      if (statusCode >= 500) {
        console.error('Failed to write goal objective:', error);
      }
      res.status(statusCode).json({ error: (isRouteError(error) ? error.message : undefined) || 'Failed to write goal objective' });
    }
  });

  app.get('/api/goals/objective/:sessionId', async (req: GoalRequest, res) => {
    const content = await readObjective(req.params.sessionId);
    if (content === null) {
      res.status(404).json({ error: 'objective not found' });
      return;
    }
    res.json({ content });
  });

  app.delete('/api/goals/objective/:sessionId', async (req: GoalRequest, res) => {
    await deleteObjective(req.params.sessionId);
    res.json({ ok: true });
  });
}
