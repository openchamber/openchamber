import { isRecord as isObjectRecord } from '../shared/guards.js';
import express from 'express';
import { isMemoryText, isMemoryType } from './contracts.js';
import type { Application, Query, RequestHandler, Response } from '../shared/http-contracts.js';
import type { MemoryTarget, MemoryWriteInput } from './contracts.js';
import type { AgentMemoryRuntime, DreamState } from './runtime.js';

interface AgentMemoryRouteDependencies {
  agentMemoryRuntime: AgentMemoryRuntime;
  isAgentMemoryEnabled?: () => boolean | Promise<boolean>;
}

type ScopeResolution = { target: MemoryTarget; error?: never }
  | { target?: never; error: 'projectId is required for project scope' | 'scope must be global or project' };

const parseJsonBody = express.json({ limit: '1mb' });

const isValidationError = (error: Error | null) => {
  const message = error ? error.message : '';
  return message.includes('is required')
    || message.includes('unsupported characters')
    || message.includes('holds at most');
};

const respondWithError = (res: Response, error: Error | null, fallbackMessage: string) => {
  const message = error ? error.message : fallbackMessage;
  if (isValidationError(error)) {
    return res.status(400).json({ error: message });
  }
  return res.status(500).json({ error: message || fallbackMessage });
};

const resolveScope = (query: Query): ScopeResolution => {
  if (query.scope === 'global') {
    return { target: { scope: 'global' } };
  }
  if (query.scope === 'project') {
    if (!isMemoryText(query.projectId) || query.projectId.trim().length === 0) {
      return { error: 'projectId is required for project scope' };
    }
    return { target: { scope: 'project', projectId: query.projectId } };
  }
  return { error: 'scope must be global or project' };
};

export const registerAgentMemoryRoutes = (app: Application, dependencies: AgentMemoryRouteDependencies) => {
  const { agentMemoryRuntime, isAgentMemoryEnabled } = dependencies;

  const requireEnabled: RequestHandler = async (_req, res, next) => {
    if (!isAgentMemoryEnabled) {
      return next();
    }
    try {
      if (!(await isAgentMemoryEnabled())) {
        return res.status(404).json({ error: 'Agent memory is disabled', disabled: true });
      }
    } catch {
      return res.status(503).json({ error: 'Agent memory availability is unknown' });
    }
    return next();
  };

  app.get('/api/agent-memory', requireEnabled, async (req, res) => {
    const { target, error } = resolveScope(req.query);
    if (error) {
      return res.status(400).json({ error });
    }
    try {
      return res.json(await agentMemoryRuntime.read(target));
    } catch (caught) {
      return respondWithError(res, caught instanceof Error ? caught : null, 'Failed to read agent memory');
    }
  });

  app.get('/api/agent-memory/all', requireEnabled, async (req, res) => {
    const projectId = isMemoryText(req.query.projectId) && req.query.projectId.trim().length > 0
      ? req.query.projectId
      : null;
    try {
      const [memory, globalDream, projectDream] = await Promise.all([
        agentMemoryRuntime.readAll(projectId),
        agentMemoryRuntime.readDreamState({ scope: 'global' }),
        projectId ? agentMemoryRuntime.readDreamState({ scope: 'project', projectId }) : null,
      ]);
      const dreamOf = (state: DreamState | null) => (state?.record ? { ...state.record, canUndo: !state.record.undone && Boolean(state.snapshot) } : null);
      return res.json({ ...memory, dream: { global: dreamOf(globalDream), project: dreamOf(projectDream) } });
    } catch (caught) {
      return respondWithError(res, caught instanceof Error ? caught : null, 'Failed to read agent memory');
    }
  });

  app.post('/api/agent-memory/dream/undo', requireEnabled, async (req, res) => {
    const { target, error } = resolveScope(req.query);
    if (error) {
      return res.status(400).json({ error });
    }
    try {
      const result = await agentMemoryRuntime.undoDream(target);
      if (!result) {
        return res.status(409).json({ error: 'There is no dreaming pass to undo' });
      }
      return res.json(result);
    } catch (caught) {
      return respondWithError(res, caught instanceof Error ? caught : null, 'Failed to undo the dreaming pass');
    }
  });

  app.patch('/api/agent-memory/:memoryId', requireEnabled, parseJsonBody, async (req, res) => {
    const { target, error } = resolveScope(req.query);
    if (error) {
      return res.status(400).json({ error });
    }

    const body = req.body;
    if (!isObjectRecord(body)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    if (body.title !== undefined && !isMemoryText(body.title)) {
      return res.status(400).json({ error: 'title must be a string' });
    }
    if (body.body !== undefined && !isMemoryText(body.body)) {
      return res.status(400).json({ error: 'body must be a string' });
    }
    if (body.type !== undefined && !isMemoryType(body.type)) {
      return res.status(400).json({ error: 'type must be fact, preference, or reference' });
    }

    try {
      const patch: MemoryWriteInput = {};
      if (body.title !== undefined) patch.title = body.title;
      if (body.body !== undefined) patch.body = body.body;
      if (body.type !== undefined) patch.type = body.type;
      const result = await agentMemoryRuntime.update(target, req.params.memoryId, patch);
      if (!result) {
        return res.status(404).json({ error: 'Memory not found' });
      }
      return res.json(result);
    } catch (caught) {
      return respondWithError(res, caught instanceof Error ? caught : null, 'Failed to save memory');
    }
  });

  app.delete('/api/agent-memory/:memoryId', requireEnabled, async (req, res) => {
    const { target, error } = resolveScope(req.query);
    if (error) {
      return res.status(400).json({ error });
    }

    try {
      const result = await agentMemoryRuntime.remove(target, req.params.memoryId);
      if (!result.deleted) {
        return res.status(404).json({ error: 'Memory not found' });
      }
      return res.json(result);
    } catch (caught) {
      return respondWithError(res, caught instanceof Error ? caught : null, 'Failed to delete memory');
    }
  });
};
