import { z } from 'zod';
import { isSpaceDirectory } from '../spaces/dispatcher.js';
import { sessionIdSchema, warmingMinutesSchema } from './runtime.js';

const modeSchema = z.object({ mode: z.enum(['off', 'all', 'session']) });
const durationSchema = z.object({ scope: z.enum(['all', 'session']), minutes: warmingMinutesSchema });
const sessionBodySchema = z.object({ directory: z.string().trim().min(1), warm: z.boolean() });

/**
 * @param {import('express').Express} app
 * @param {object} options
 * @param {ReturnType<typeof import('./runtime.js').createSessionWarmingRuntime>} options.sessionWarmingRuntime
 * @param {(enabled: boolean) => unknown} options.setGlobalWarming Writes OpenCode's `warming` key.
 * @param {(minutes: number) => unknown} options.setGlobalWarmingDuration Writes OpenCode's `warming.duration`.
 */
export const registerSessionWarmingRoutes = (app, { sessionWarmingRuntime, setGlobalWarming, setGlobalWarmingDuration }) => {
  app.get('/api/session-warming', (_req, res) => res.json(sessionWarmingRuntime.snapshot()));

  app.put('/api/session-warming/mode', (req, res) => {
    const parsed = modeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "mode must be 'off', 'all' or 'session'" });
    const { mode } = parsed.data;
    try {
      setGlobalWarming(mode === 'all');
    } catch (error) {
      console.error('Failed to save session warming:', error);
      return res.status(500).json({ error: error?.message || 'Failed to save session warming' });
    }
    return res.json(sessionWarmingRuntime.setEnabled(mode === 'session'));
  });

  app.put('/api/session-warming/duration', (req, res) => {
    const parsed = durationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "scope must be 'all' or 'session' and minutes one of 30, 60, 120, 180" });
    const { scope, minutes } = parsed.data;
    if (scope === 'session') return res.json(sessionWarmingRuntime.setMinutes(minutes));
    try {
      setGlobalWarmingDuration(minutes);
    } catch (error) {
      console.error('Failed to save the warm duration:', error);
      return res.status(500).json({ error: error?.message || 'Failed to save the warm duration' });
    }
    return res.json(sessionWarmingRuntime.snapshot());
  });

  app.put('/api/session-warming/sessions/:sessionId', (req, res) => {
    const sessionId = sessionIdSchema.safeParse(req.params.sessionId);
    const body = sessionBodySchema.safeParse(req.body);
    if (!sessionId.success || !body.success) return res.status(400).json({ error: 'a session id, directory and warm are required' });
    if (isSpaceDirectory(body.data.directory)) return res.status(400).json({ error: 'sessions in an isolated space cannot be kept warm' });
    const result = sessionWarmingRuntime.setSessionWarm(sessionId.data, body.data.directory, body.data.warm);
    if ('error' in result) return res.status(409).json({ error: 'per-session warming is off' });
    return res.json(result);
  });
};
