import express from 'express';
import { z } from 'zod';

import { isBoolean, isRecord } from '../shared/guards.js';
import type { Application } from '../shared/http-contracts.js';
import type { createSessionKnowledgeRuntime } from './runtime.js';
import { hasMessage, isNonEmptyString } from './guards.js';

const parseJsonBody = express.json({ limit: '1mb' });

const responseStyleInstructionSchema = z.string().nullable().optional();

export interface SessionKnowledgeRouteDependencies {
  sessionKnowledgeRuntime: Pick<ReturnType<typeof createSessionKnowledgeRuntime>, 'sync' | 'collectSummaryForSession' | 'collectSummary' | 'setPin'>;
}

export const registerSessionKnowledgeRoutes = (app: Application, dependencies: SessionKnowledgeRouteDependencies) => {
  const { sessionKnowledgeRuntime } = dependencies;

  app.post('/api/session-knowledge/sync', parseJsonBody, async (req, res) => {
    const body = isRecord(req.body) ? req.body : {};
    const sessionId = isNonEmptyString(body.sessionId) ? body.sessionId.trim() : '';
    const directory = isNonEmptyString(body.directory) ? body.directory.trim() : '';
    if (!sessionId || !directory) {
      return res.status(400).json({ error: 'sessionId and directory are required' });
    }
    const parsedResponseStyleInstruction = responseStyleInstructionSchema.safeParse(body.responseStyleInstruction);
    const responseStyleInstruction = parsedResponseStyleInstruction.success ? parsedResponseStyleInstruction.data : undefined;
    return res.json({ synced: await sessionKnowledgeRuntime.sync(sessionId, directory, responseStyleInstruction) });
  });

  app.get('/api/session-knowledge/summary', async (req, res) => {
    const directory = isNonEmptyString(req.query.directory) ? req.query.directory.trim() : '';
    if (!directory) {
      return res.json({ notes: [], plans: [], memory: { global: 0, project: 0 } });
    }
    const sessionId = isNonEmptyString(req.query.sessionId) ? req.query.sessionId.trim() : '';
    try {
      return res.json(sessionId
        ? await sessionKnowledgeRuntime.collectSummaryForSession(sessionId, directory)
        : await sessionKnowledgeRuntime.collectSummary(directory));
    } catch {
      return res.json({ notes: [], plans: [], memory: { global: 0, project: 0 } });
    }
  });

  app.post('/api/session-knowledge/pin', parseJsonBody, async (req, res) => {
    const body = req.body;
    if (!isRecord(body)) return res.status(400).json({ error: 'Body must be an object' });
    const sessionId = isNonEmptyString(body.sessionId) ? body.sessionId.trim() : '';
    const directory = isNonEmptyString(body.directory) ? body.directory.trim() : '';
    const id = isNonEmptyString(body.id) ? body.id.trim() : '';
    const kind = body.kind === 'note' || body.kind === 'plan' ? body.kind : '';
    if (!sessionId || !directory || !id || !kind || !isBoolean(body.pinned)) {
      return res.status(400).json({ error: 'sessionId, directory, kind, id and pinned are required' });
    }
    try {
      return res.json({ pins: await sessionKnowledgeRuntime.setPin(sessionId, directory, kind, id, body.pinned) });
    } catch (error) {
      return res.status(500).json({ error: (hasMessage(error) ? error.message : undefined) ?? 'Unable to update pin' });
    }
  });
};
