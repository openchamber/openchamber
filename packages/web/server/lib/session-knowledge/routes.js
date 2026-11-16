import express from 'express';
import { z } from 'zod';

import { isRecord } from '../shared/guards.js';

const parseJsonBody = express.json({ limit: '1mb' });

const asNonEmptyString = (value) => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : ''
);
const responseStyleInstructionSchema = z.string().nullable().optional();

export const registerSessionKnowledgeRoutes = (app, dependencies) => {
  const { sessionKnowledgeRuntime } = dependencies;

  app.post('/api/session-knowledge/sync', parseJsonBody, async (req, res) => {
    const body = isRecord(req.body) ? req.body : {};
    const sessionId = asNonEmptyString(body.sessionId);
    const directory = asNonEmptyString(body.directory);
    if (!sessionId || !directory) {
      return res.status(400).json({ error: 'sessionId and directory are required' });
    }
    const parsedResponseStyleInstruction = responseStyleInstructionSchema.safeParse(body.responseStyleInstruction);
    const responseStyleInstruction = parsedResponseStyleInstruction.success ? parsedResponseStyleInstruction.data : undefined;
    return res.json({ synced: await sessionKnowledgeRuntime.sync(sessionId, directory, responseStyleInstruction) });
  });

  app.get('/api/session-knowledge/summary', async (req, res) => {
    const directory = asNonEmptyString(req.query.directory);
    if (!directory) {
      return res.json({ notes: [], plans: [], memory: { global: 0, project: 0 } });
    }
    const sessionId = asNonEmptyString(req.query.sessionId);
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
    const sessionId = asNonEmptyString(body.sessionId);
    const directory = asNonEmptyString(body.directory);
    const id = asNonEmptyString(body.id);
    const kind = body.kind === 'note' || body.kind === 'plan' ? body.kind : '';
    if (!sessionId || !directory || !id || !kind || typeof body.pinned !== 'boolean') {
      return res.status(400).json({ error: 'sessionId, directory, kind, id and pinned are required' });
    }
    try {
      return res.json({ pins: await sessionKnowledgeRuntime.setPin(sessionId, directory, kind, id, body.pinned) });
    } catch (error) {
      return res.status(500).json({ error: error?.message ?? 'Unable to update pin' });
    }
  });
};
