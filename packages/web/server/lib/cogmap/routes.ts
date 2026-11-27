import express from 'express';
import { asControlError } from '../openchamber-control/error.js';
import type { Application } from '../shared/http-contracts.js';
import type { createCogMapRuntime } from './index.js';
import type { CogMapMutationInput, CogMapPacing } from './types.js';

export interface CogMapRoutesOptions {
  cogMapRuntime: ReturnType<typeof createCogMapRuntime>;
  onModeChanged?: ((input: {
    sessionId: string;
    directory: string | null;
    active: boolean;
    pacing: CogMapPacing;
  }) => Promise<void> | void) | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export const registerCogMapRoutes = (
  app: Application,
  { cogMapRuntime, onModeChanged }: CogMapRoutesOptions,
) => {
  app.get('/api/openchamber/cogmap/:sessionId', async (req, res) => {
    try {
      const sessionId = asString((req.params as Record<string, unknown>)?.sessionId);
      const state = await cogMapRuntime.getSessionState(sessionId);
      return res.json(state);
    } catch (error) {
      const controlError = asControlError(error, 'Could not load cognitive maps');
      return res.status(controlError.statusCode).json({ error: controlError.message });
    }
  });

  app.post('/api/openchamber/cogmap/:sessionId/mutate', express.json({ limit: '512kb' }), async (req, res) => {
    try {
      const sessionId = asString((req.params as Record<string, unknown>)?.sessionId);
      const body = isRecord(req.body) ? req.body : {};
      const directory = asString(body.directory) || null;
      const result = await cogMapRuntime.mutateByUser(sessionId, body as CogMapMutationInput, directory);
      return res.json(result);
    } catch (error) {
      const controlError = asControlError(error, 'Could not update cognitive map');
      return res.status(controlError.statusCode).json({ error: controlError.message });
    }
  });

  app.post('/api/openchamber/cogmap/:sessionId/mode', express.json({ limit: '32kb' }), async (req, res) => {
    try {
      const sessionId = asString((req.params as Record<string, unknown>)?.sessionId);
      const body = isRecord(req.body) ? req.body : {};
      const active = typeof body.active === 'boolean' ? body.active : undefined;
      const pacing: CogMapPacing | undefined = body.pacing === 'auto' || body.pacing === 'collab' ? body.pacing : undefined;
      const activeMapId = body.activeMapId === null ? null : (asString(body.activeMapId) || undefined);
      const directory = asString(body.directory) || null;

      const state = await cogMapRuntime.setMode(sessionId, {
        ...(active !== undefined ? { active } : {}),
        ...(pacing !== undefined ? { pacing } : {}),
        ...(activeMapId !== undefined ? { activeMapId } : {}),
      });

      await onModeChanged?.({
        sessionId,
        directory,
        active: state.modeActive,
        pacing: state.pacing,
      });

      return res.json(state);
    } catch (error) {
      const controlError = asControlError(error, 'Could not update cognitive map mode');
      return res.status(controlError.statusCode).json({ error: controlError.message });
    }
  });

  app.delete('/api/openchamber/cogmap/:sessionId/:mapId', async (req, res) => {
    try {
      const params = req.params as Record<string, unknown>;
      const sessionId = asString(params?.sessionId);
      const mapId = asString(params?.mapId);
      const state = await cogMapRuntime.deleteMap(sessionId, mapId);
      return res.json(state);
    } catch (error) {
      const controlError = asControlError(error, 'Could not delete cognitive map');
      return res.status(controlError.statusCode).json({ error: controlError.message });
    }
  });
};
