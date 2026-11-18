import { isRecord as isObjectRecord } from '../shared/guards.js';
import express from 'express';
import { z } from 'zod';
import type { Application, Response } from '../shared/http-contracts.js';
import type { createProjectContextRuntime } from './runtime.js';
import type { NoteInput, TodoInput } from './contracts.js';
import { isBoolean, isNoteSource, isText } from './contracts.js';

export interface ProjectContextRouteDependencies {
  projectContextRuntime: ReturnType<typeof createProjectContextRuntime>;
}

const parseJsonBody = express.json({ limit: '1mb' });
const NOTES_TODOS_STORE_TOKEN = /^(local|repository):/;
const todoTextInput = z.string();
const sessionIdInput = z.string().nullable();
const optionalTextInput = z.string().optional();
const optionalCompletedInput = z.boolean().optional();

const hasHttpStatus = (error: unknown): error is { status: 400 | 404 | 409 } => (
  error !== null
  && (typeof error === 'object' || typeof error === 'function')
  && 'status' in error
  && (error.status === 400 || error.status === 404 || error.status === 409)
);

const routeErrorInput = z.unknown().transform((error) => ({
  cause: error instanceof Error ? error : undefined,
  status: hasHttpStatus(error) ? error.status : undefined,
}));

type RouteError = z.infer<typeof routeErrorInput>;

const isValidationError = (error: RouteError) => {
  const message = error.cause ? error.cause.message : '';
  return message.includes('is required') || message.includes('unsupported characters');
};

const respondWithError = (res: Response, error: RouteError, fallbackMessage: string) => {
  const message = error.cause ? error.cause.message : fallbackMessage;
  if (error.status !== undefined) {
    return res.status(error.status).json({ error: message });
  }
  if (isValidationError(error)) {
    return res.status(400).json({ error: message });
  }
  return res.status(500).json({ error: message || fallbackMessage });
};

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isTodoList = (value: unknown): value is TodoInput[] => (
  Array.isArray(value)
  && value.every((todo) => (
    isObjectRecord(todo)
    && isText(todo.id)
    && isText(todo.text)
    && (todo.completed === undefined || isBoolean(todo.completed))
    && (todo.createdAt === undefined || isFiniteNumber(todo.createdAt))
  ))
);

export const registerProjectContextRoutes = (app: Application, dependencies: ProjectContextRouteDependencies) => {
  const { projectContextRuntime } = dependencies;

  app.get<unknown, { projectId: string }>('/api/project-context/:projectId', async (req, res) => {
    try {
      return res.json(await projectContextRuntime.readContext(req.params.projectId));
    } catch (error) {
      return respondWithError(res, routeErrorInput.parse(error), 'Failed to read project context');
    }
  });

  app.put<unknown, { projectId: string }>('/api/project-context/:projectId/todos', parseJsonBody, async (req, res) => {
    const body = req.body;
    if (!isObjectRecord(body)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    if (!isTodoList(body.todos)) {
      return res.status(400).json({ error: 'todos must be an array of todo items' });
    }
    if (body.store !== undefined && !NOTES_TODOS_STORE_TOKEN.test(`${body.store}`)) {
      return res.status(400).json({ error: 'store must be the notesTodosStore token of a read' });
    }

    try {
      return res.json(await projectContextRuntime.saveTodos(req.params.projectId, body.todos, { store: body.store }));
    } catch (error) {
      return respondWithError(res, routeErrorInput.parse(error), 'Failed to save project todos');
    }
  });

  app.post<unknown, { projectId: string }>('/api/project-context/:projectId/todos', parseJsonBody, async (req, res) => {
    const body = req.body;
    const text = todoTextInput.safeParse(isObjectRecord(body) ? body.text : undefined);
    if (!text.success) {
      return res.status(400).json({ error: 'text must be a string' });
    }
    const id = optionalTextInput.safeParse(isObjectRecord(body) ? body.id : undefined);
    if (!id.success) {
      return res.status(400).json({ error: 'id must be a string' });
    }
    try {
      const { context } = await projectContextRuntime.createTodo(req.params.projectId, {
        text: text.data,
        id: id.data,
        planId: isObjectRecord(body) ? body.planId : undefined,
        dependsOn: isObjectRecord(body) ? body.dependsOn : undefined,
      });
      return res.status(201).json(context);
    } catch (error) {
      return respondWithError(res, routeErrorInput.parse(error), 'Failed to create todo');
    }
  });

  app.patch<unknown, { projectId: string; todoId: string }>('/api/project-context/:projectId/todos/:todoId', parseJsonBody, async (req, res) => {
    const body = req.body;
    if (!isObjectRecord(body)) return res.status(400).json({ error: 'Body must be an object' });
    const text = optionalTextInput.safeParse(body.text);
    if (!text.success) {
      return res.status(400).json({ error: 'text must be a string' });
    }
    const completed = optionalCompletedInput.safeParse(body.completed);
    if (!completed.success) {
      return res.status(400).json({ error: 'completed must be a boolean' });
    }
    try {
      return res.json(await projectContextRuntime.updateTodo(req.params.projectId, req.params.todoId, {
        text: text.data,
        completed: completed.data,
        planId: body.planId,
        dependsOn: body.dependsOn,
      }));
    } catch (error) {
      return respondWithError(res, routeErrorInput.parse(error), 'Failed to update todo');
    }
  });

  app.delete<unknown, { projectId: string; todoId: string }>('/api/project-context/:projectId/todos/:todoId', async (req, res) => {
    try {
      return res.json(await projectContextRuntime.deleteTodo(req.params.projectId, req.params.todoId));
    } catch (error) {
      return respondWithError(res, routeErrorInput.parse(error), 'Failed to delete todo');
    }
  });

  app.post<unknown, { projectId: string }>('/api/project-context/:projectId/notes', parseJsonBody, async (req, res) => {
    const body = req.body;
    if (!isObjectRecord(body)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    if (!isText(body.body)) {
      return res.status(400).json({ error: 'body must be a string' });
    }
    if (body.source !== undefined && !isNoteSource(body.source)) {
      return res.status(400).json({ error: 'source must be manual, selection, or agent' });
    }
    if (body.origin !== undefined && !isObjectRecord(body.origin)) {
      return res.status(400).json({ error: 'origin must be an object' });
    }

    try {
      const { note, context } = await projectContextRuntime.createNote(req.params.projectId, {
        body: body.body,
        source: body.source,
        origin: body.origin,
        planId: body.planId,
      });
      return res.status(201).json({ note, context });
    } catch (error) {
      return respondWithError(res, routeErrorInput.parse(error), 'Failed to create note');
    }
  });

  app.patch<unknown, { projectId: string; noteId: string }>('/api/project-context/:projectId/notes/:noteId', parseJsonBody, async (req, res) => {
    const body = req.body;
    if (!isObjectRecord(body)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    if (body.body !== undefined && !isText(body.body)) {
      return res.status(400).json({ error: 'body must be a string' });
    }
    if (body.pinned !== undefined && !isBoolean(body.pinned)) {
      return res.status(400).json({ error: 'pinned must be a boolean' });
    }

    try {
      const patch: NoteInput = { planId: body.planId };
      if (body.body !== undefined) patch.body = body.body;
      if (body.pinned !== undefined) patch.pinned = body.pinned;
      const result = await projectContextRuntime.updateNote(req.params.projectId, req.params.noteId, patch);
      if (!result) {
        return res.status(404).json({ error: 'Note not found' });
      }
      return res.json(result);
    } catch (error) {
      return respondWithError(res, routeErrorInput.parse(error), 'Failed to save note');
    }
  });

  app.delete<unknown, { projectId: string; noteId: string }>('/api/project-context/:projectId/notes/:noteId', async (req, res) => {
    try {
      const { deleted, context } = await projectContextRuntime.deleteNote(
        req.params.projectId,
        req.params.noteId,
      );
      if (!deleted) {
        return res.status(404).json({ error: 'Note not found' });
      }
      return res.json(context);
    } catch (error) {
      return respondWithError(res, routeErrorInput.parse(error), 'Failed to delete note');
    }
  });

  app.patch<unknown, { projectId: string; planId: string }>('/api/project-context/:projectId/plans/:planId', parseJsonBody, async (req, res) => {
    const body = req.body;
    if (!isObjectRecord(body) || !isBoolean(body.pinned)) {
      return res.status(400).json({ error: 'pinned must be a boolean' });
    }

    try {
      const result = await projectContextRuntime.setPlanPinned(
        req.params.projectId,
        req.params.planId,
        body.pinned,
      );
      if (!result) {
        return res.status(404).json({ error: 'Plan not found' });
      }
      return res.json(result);
    } catch (error) {
      return respondWithError(res, routeErrorInput.parse(error), 'Failed to update plan');
    }
  });

  app.get<unknown, { projectId: string; planId: string }>('/api/project-context/:projectId/plans/:planId', async (req, res) => {
    try {
      const plan = await projectContextRuntime.readPlan(req.params.projectId, req.params.planId);
      if (!plan) {
        return res.status(404).json({ error: 'Plan not found' });
      }
      return res.json(plan);
    } catch (error) {
      return respondWithError(res, routeErrorInput.parse(error), 'Failed to read plan');
    }
  });

  app.put<unknown, { projectId: string; planId: string }>('/api/project-context/:projectId/plans/:planId', parseJsonBody, async (req, res) => {
    const body = req.body;
    if (!isObjectRecord(body)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    if (!isText(body.raw)) {
      return res.status(400).json({ error: 'raw must be a string' });
    }

    try {
      const result = await projectContextRuntime.updatePlan(
        req.params.projectId,
        req.params.planId,
        { raw: body.raw },
      );
      if (!result) {
        return res.status(404).json({ error: 'Plan not found' });
      }
      return res.json(result);
    } catch (error) {
      return respondWithError(res, routeErrorInput.parse(error), 'Failed to save plan');
    }
  });

  app.post<unknown, { projectId: string }>('/api/project-context/:projectId/plans', parseJsonBody, async (req, res) => {
    const body = req.body;
    if (!isObjectRecord(body)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    if (!isText(body.body)) {
      return res.status(400).json({ error: 'body must be a string' });
    }
    if (body.title !== undefined && !isText(body.title)) {
      return res.status(400).json({ error: 'title must be a string' });
    }

    try {
      const { plan, context } = await projectContextRuntime.createPlan(req.params.projectId, {
        title: body.title ?? '',
        body: body.body,
      });
      return res.status(201).json({ plan, context });
    } catch (error) {
      return respondWithError(res, routeErrorInput.parse(error), 'Failed to create plan');
    }
  });

  app.put<unknown, { projectId: string; planId: string }>('/api/project-context/:projectId/plans/:planId/session', parseJsonBody, async (req, res) => {
    const sessionId = sessionIdInput.safeParse(isObjectRecord(req.body) ? req.body.sessionId : undefined);
    if (!sessionId.success) {
      return res.status(400).json({ error: 'sessionId must be a string or null' });
    }
    try {
      const result = await projectContextRuntime.setPlanSession(req.params.projectId, req.params.planId, {
        sessionId: sessionId.data,
      });
      if (!result?.plan) {
        return res.status(404).json({ error: 'Plan not found' });
      }
      return res.json(result);
    } catch (error) {
      return respondWithError(res, routeErrorInput.parse(error), 'Failed to link plan to session');
    }
  });

  const planActions: ['share' | 'unshare', 'sharePlan' | 'unsharePlan'][] = [['share', 'sharePlan'], ['unshare', 'unsharePlan']];
  for (const [suffix, method] of planActions) {
    app.post<unknown, { projectId: string; planId: string }>(`/api/project-context/:projectId/plans/:planId/${suffix}`, async (req, res) => {
      try {
        const result = await projectContextRuntime[method](req.params.projectId, req.params.planId);
        if (!result) {
          return res.status(404).json({ error: 'Plan not found' });
        }
        return res.json(result);
      } catch (error) {
        return respondWithError(res, routeErrorInput.parse(error), `Failed to ${suffix} plan`);
      }
    });
  }

  app.delete<unknown, { projectId: string; planId: string }>('/api/project-context/:projectId/plans/:planId', async (req, res) => {
    try {
      const { deleted, context } = await projectContextRuntime.deletePlan(
        req.params.projectId,
        req.params.planId,
      );
      if (!deleted) {
        return res.status(404).json({ error: 'Plan not found' });
      }
      return res.json(context);
    } catch (error) {
      return respondWithError(res, routeErrorInput.parse(error), 'Failed to delete plan');
    }
  });
};
