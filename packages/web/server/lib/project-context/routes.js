/**
 * OpenChamber project context routes: notes, todos, and plan files.
 *
 * These replace the shared UI's direct `/api/fs/*` access to
 * `~/.config/openchamber/projects/*`. The client no longer resolves the home
 * directory or composes storage paths, and plan markdown is addressed by id
 * rather than by an absolute path supplied by the caller.
 *
 * Body parsing is attached per route. There is no global JSON parser: the
 * generic OpenCode proxy needs an unread request stream, so `core-routes`
 * parses only an explicit allowlist of path prefixes and leaves every other
 * `/api` request untouched. A route that forgets this sees `req.body` as
 * undefined and rejects every write as a malformed body.
 */

import express from 'express';

const parseJsonBody = express.json({ limit: '1mb' });

const isObjectRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isValidationError = (error) => {
  const message = error instanceof Error ? error.message : '';
  return message.includes('is required') || message.includes('unsupported characters');
};

const respondWithError = (res, error, fallbackMessage) => {
  const message = error instanceof Error ? error.message : fallbackMessage;
  if (isValidationError(error)) {
    return res.status(400).json({ error: message });
  }
  return res.status(500).json({ error: message || fallbackMessage });
};

const isValidNoteSource = (value) => value === 'manual' || value === 'selection' || value === 'agent';

const hasValidTodosShape = (value) => (
  Array.isArray(value)
  && value.every((todo) => (
    isObjectRecord(todo)
    && typeof todo.id === 'string'
    && typeof todo.text === 'string'
    && (todo.completed === undefined || typeof todo.completed === 'boolean')
    && (todo.createdAt === undefined || (typeof todo.createdAt === 'number' && Number.isFinite(todo.createdAt)))
  ))
);

export const registerProjectContextRoutes = (app, dependencies) => {
  const { projectContextRuntime } = dependencies;

  app.get('/api/project-context/:projectId', async (req, res) => {
    try {
      return res.json(await projectContextRuntime.readContext(req.params.projectId));
    } catch (error) {
      return respondWithError(res, error, 'Failed to read project context');
    }
  });

  app.put('/api/project-context/:projectId/todos', parseJsonBody, async (req, res) => {
    const body = req.body;
    if (!isObjectRecord(body)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    if (!hasValidTodosShape(body.todos)) {
      return res.status(400).json({ error: 'todos must be an array of todo items' });
    }

    try {
      return res.json(await projectContextRuntime.saveTodos(req.params.projectId, body.todos));
    } catch (error) {
      return respondWithError(res, error, 'Failed to save project todos');
    }
  });

  app.post('/api/project-context/:projectId/notes', parseJsonBody, async (req, res) => {
    const body = req.body;
    if (!isObjectRecord(body)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    if (typeof body.body !== 'string') {
      return res.status(400).json({ error: 'body must be a string' });
    }
    if (body.source !== undefined && !isValidNoteSource(body.source)) {
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
      });
      return res.status(201).json({ note, context });
    } catch (error) {
      return respondWithError(res, error, 'Failed to create note');
    }
  });

  app.patch('/api/project-context/:projectId/notes/:noteId', parseJsonBody, async (req, res) => {
    const body = req.body;
    if (!isObjectRecord(body)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    if (body.body !== undefined && typeof body.body !== 'string') {
      return res.status(400).json({ error: 'body must be a string' });
    }
    if (body.pinned !== undefined && typeof body.pinned !== 'boolean') {
      return res.status(400).json({ error: 'pinned must be a boolean' });
    }

    try {
      const result = await projectContextRuntime.updateNote(req.params.projectId, req.params.noteId, {
        ...(body.body !== undefined ? { body: body.body } : {}),
        ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
      });
      if (!result) {
        return res.status(404).json({ error: 'Note not found' });
      }
      return res.json(result);
    } catch (error) {
      return respondWithError(res, error, 'Failed to save note');
    }
  });

  app.delete('/api/project-context/:projectId/notes/:noteId', async (req, res) => {
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
      return respondWithError(res, error, 'Failed to delete note');
    }
  });

  app.patch('/api/project-context/:projectId/plans/:planId', parseJsonBody, async (req, res) => {
    const body = req.body;
    if (!isObjectRecord(body) || typeof body.pinned !== 'boolean') {
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
      return respondWithError(res, error, 'Failed to update plan');
    }
  });

  app.get('/api/project-context/:projectId/plans/:planId', async (req, res) => {
    try {
      const plan = await projectContextRuntime.readPlan(req.params.projectId, req.params.planId);
      if (!plan) {
        return res.status(404).json({ error: 'Plan not found' });
      }
      return res.json(plan);
    } catch (error) {
      return respondWithError(res, error, 'Failed to read plan');
    }
  });

  app.put('/api/project-context/:projectId/plans/:planId', parseJsonBody, async (req, res) => {
    const body = req.body;
    if (!isObjectRecord(body)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    if (typeof body.raw !== 'string') {
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
      return respondWithError(res, error, 'Failed to save plan');
    }
  });

  app.post('/api/project-context/:projectId/plans', parseJsonBody, async (req, res) => {
    const body = req.body;
    if (!isObjectRecord(body)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    if (typeof body.body !== 'string') {
      return res.status(400).json({ error: 'body must be a string' });
    }
    if (body.title !== undefined && typeof body.title !== 'string') {
      return res.status(400).json({ error: 'title must be a string' });
    }

    try {
      const { plan, context } = await projectContextRuntime.createPlan(req.params.projectId, {
        title: body.title ?? '',
        body: body.body,
      });
      return res.status(201).json({ plan, context });
    } catch (error) {
      return respondWithError(res, error, 'Failed to create plan');
    }
  });

  app.delete('/api/project-context/:projectId/plans/:planId', async (req, res) => {
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
      return respondWithError(res, error, 'Failed to delete plan');
    }
  });
};
