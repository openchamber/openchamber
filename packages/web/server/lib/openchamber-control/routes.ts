import express from 'express';
import { OPENCHAMBER_PROJECT_ACTIONS_ACTIONS, OPENCHAMBER_TERMINAL_ACTIONS } from './actions.js';
import { asControlError } from './error.js';
import type { Application } from '../shared/http-contracts.js';
import type { ControlInput } from './contracts.js';
import type { createLaterPages } from './later-pages.js';
import type { createOpenChamberControlService } from './service.js';
import type { ControlErrorDetails } from './error.js';

export interface ControlRoutesOptions {
  controlService: Pick<ReturnType<typeof createOpenChamberControlService>, 'execute' | 'answerPage' | 'secretFields' | 'answerSecret' | 'forgetSavedSecret'>;
  laterPages?: Pick<ReturnType<typeof createLaterPages>, 'load' | 'snapshot'> | null;
}

interface ControlRequestFields {
  action?: unknown;
  input?: unknown;
  contextDirectory?: unknown;
}

const isAction = (value: unknown): value is string => typeof value === 'string';
const isControlInput = (value: unknown): value is ControlInput => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const AGENT_TOOL_ONLY_ACTIONS = new Map<string, string>([
  ...OPENCHAMBER_TERMINAL_ACTIONS.map((action): [string, string] => [action, 'openchamber_terminal']),
  ...OPENCHAMBER_PROJECT_ACTIONS_ACTIONS.map((action): [string, string] => [action, 'openchamber_actions']),
]);

export const registerOpenChamberControlRoutes = (app: Application, { controlService, laterPages = null }: ControlRoutesOptions) => {
  app.post('/api/openchamber/control', express.json({ limit: '1mb' }), async (req, res) => {
    const controller = new AbortController();
    const abortOnDisconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once('aborted', abortOnDisconnect);
    res.once('close', abortOnDisconnect);
    try {
      const body: ControlRequestFields | undefined = req.body == null ? undefined : Object(req.body);
      const action = isAction(body?.action) ? body.action : '';
      const agentTool = AGENT_TOOL_ONLY_ACTIONS.get(action);
      if (agentTool) {
        return res.status(403).json({ error: `${action} is available only to agents through the ${agentTool} tool` });
      }
      const requestInput = body?.input;
      const input = isControlInput(requestInput)
        ? requestInput
        : {};
      const data = await controlService.execute(action, input, body?.contextDirectory, { signal: controller.signal });
      return res.json(data);
    } catch (error) {
      const controlError = asControlError(error, 'OpenChamber control action failed');
      const failure: ControlErrorDetails & { error: string } = { error: controlError.message };
      if (controlError.partial === true) {
        failure.partial = true;
        failure.partialAction = controlError.partialAction;
        failure.sessionId = controlError.sessionId;
        failure.directory = controlError.directory;
      }
      return res.status(controlError.statusCode).json(failure);
    } finally {
      req.off('aborted', abortOnDisconnect);
      res.off('close', abortOnDisconnect);
    }
  });

  app.post('/api/openchamber/render/answer', express.json({ limit: '64kb' }), async (req, res) => {
    try {
      return res.json(await controlService.answerPage(req.body ?? {}));
    } catch (error) {
      const controlError = asControlError(error, 'Could not deliver the answer');
      return res.status(controlError.statusCode).json({ error: controlError.message });
    }
  });

  app.get('/api/openchamber/render/later', async (_req, res) => {
    if (!laterPages) return res.status(503).json({ error: 'This server cannot keep pages open for a later answer' });
    try {
      await laterPages.load();
      return res.json(laterPages.snapshot());
    } catch (error) {
      const controlError = asControlError(error, 'Could not read the pages');
      return res.status(controlError.statusCode).json({ error: controlError.message });
    }
  });

  app.get('/api/openchamber/secret/fields', (req, res) => {
    try {
      return res.json(controlService.secretFields(req.query ?? {}));
    } catch (error) {
      const controlError = asControlError(error, 'Could not read the card');
      return res.status(controlError.statusCode).json({ error: controlError.message });
    }
  });

  app.post('/api/openchamber/secret/forget-saved', express.json({ limit: '4kb' }), async (req, res) => {
    try {
      return res.json(await controlService.forgetSavedSecret(req.body ?? {}));
    } catch (error) {
      const controlError = asControlError(error, 'Could not forget the secret');
      return res.status(controlError.statusCode).json({ error: controlError.message });
    }
  });

  app.post('/api/openchamber/secret/answer', express.json({ limit: '512kb' }), async (req, res) => {
    try {
      return res.json(await controlService.answerSecret(req.body ?? {}));
    } catch (error) {
      const controlError = asControlError(error, 'Could not save the secret');
      return res.status(controlError.statusCode).json({ error: controlError.message });
    }
  });
};
