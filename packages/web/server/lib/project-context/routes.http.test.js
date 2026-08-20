import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { registerProjectContextRoutes } from './routes.js';

/**
 * End-to-end route tests over real HTTP.
 *
 * An earlier unit test invoked the handlers directly. That covered status-code
 * mapping but could not see middleware, and the blind spot shipped a real bug:
 * the
 * server has no global JSON parser — `core-routes` parses only an allowlist of
 * path prefixes so the OpenCode proxy keeps an unread stream — so every write
 * here arrived with `req.body` undefined and was rejected as malformed.
 *
 * These tests mount the routes on a bare express app, exactly as production
 * does, so a missing body parser fails the suite instead of the user.
 */

const emptyContext = { version: 2, notes: [], todos: [], plans: [] };

const createApp = (overrides = {}) => {
  const received = {};
  const runtime = {
    readContext: async () => emptyContext,
    saveTodos: async (_projectId, todos) => {
      received.todos = todos;
      return { ...emptyContext, todos };
    },
    createNote: async (_projectId, value) => {
      received.note = value;
      return {
        note: { id: 'n1', body: value.body, createdAt: 1, updatedAt: 1, source: value.source ?? 'manual', pinned: false },
        context: emptyContext,
      };
    },
    updateNote: async (_projectId, _noteId, patch) => {
      received.notePatch = patch;
      return {
        note: { id: 'n1', body: 'x', createdAt: 1, updatedAt: 2, source: 'manual', pinned: patch.pinned === true },
        context: emptyContext,
      };
    },
    deleteNote: async () => ({ deleted: true, context: emptyContext }),
    readPlan: async () => null,
    createPlan: async (_projectId, value) => {
      received.plan = value;
      return { plan: { id: 'p1', file: 'a.md', title: value.title, createdAt: 1, pinned: false }, context: emptyContext };
    },
    updatePlan: async (_projectId, _planId, value) => {
      received.planRaw = value;
      return { plan: { id: 'p1', file: 'a.md', title: 'A', createdAt: 1, pinned: false }, context: emptyContext, title: 'A', body: 'x', raw: value.raw };
    },
    setPlanPinned: async (_projectId, _planId, pinned) => ({
      plan: { id: 'p1', file: 'a.md', title: 'A', createdAt: 1, pinned },
      context: emptyContext,
    }),
    deletePlan: async () => ({ deleted: true, context: emptyContext }),
    ...overrides,
  };

  const app = express();
  // Deliberately NO app.use(express.json()): production does not have one on
  // this path, so adding it here would hide the very defect these tests exist
  // to catch.
  registerProjectContextRoutes(app, { projectContextRuntime: runtime });
  return { app, received };
};

const BASE = '/api/project-context/path_dGVzdA';

describe('project context routes over HTTP', () => {
  it('reads the context', async () => {
    const { app } = createApp();
    const res = await request(app).get(BASE).expect(200);
    expect(res.body).toEqual(emptyContext);
  });

  it('accepts a todos write with a JSON body', async () => {
    const { app, received } = createApp();

    await request(app)
      .put(`${BASE}/todos`)
      .send({ todos: [{ id: 't1', text: 'one' }] })
      .expect(200);

    expect(received.todos).toEqual([{ id: 't1', text: 'one' }]);
  });

  it('accepts a note create with a JSON body', async () => {
    const { app, received } = createApp();

    const res = await request(app)
      .post(`${BASE}/notes`)
      .send({ body: 'hello', source: 'selection', origin: { sessionId: 'ses_1' } })
      .expect(201);

    expect(received.note.body).toBe('hello');
    expect(received.note.source).toBe('selection');
    expect(res.body.note.id).toBe('n1');
  });

  it('accepts a note pin patch with a JSON body', async () => {
    const { app, received } = createApp();

    const res = await request(app)
      .patch(`${BASE}/notes/n1`)
      .send({ pinned: true })
      .expect(200);

    expect(received.notePatch).toEqual({ pinned: true });
    expect(res.body.note.pinned).toBe(true);
  });

  it('accepts a note body patch with a JSON body', async () => {
    const { app, received } = createApp();

    await request(app)
      .patch(`${BASE}/notes/n1`)
      .send({ body: 'edited' })
      .expect(200);

    expect(received.notePatch).toEqual({ body: 'edited' });
  });

  it('accepts a plan pin patch with a JSON body', async () => {
    const { app } = createApp();

    const res = await request(app)
      .patch(`${BASE}/plans/p1`)
      .send({ pinned: true })
      .expect(200);

    expect(res.body.plan.pinned).toBe(true);
  });

  it('accepts a plan create with a JSON body', async () => {
    const { app, received } = createApp();

    await request(app)
      .post(`${BASE}/plans`)
      .send({ title: 'A', body: 'text' })
      .expect(201);

    expect(received.plan).toEqual({ title: 'A', body: 'text' });
  });

  it('accepts a plan save with a JSON body', async () => {
    const { app, received } = createApp();

    await request(app)
      .put(`${BASE}/plans/p1`)
      .send({ raw: '# A\n\nx' })
      .expect(200);

    expect(received.planRaw).toEqual({ raw: '# A\n\nx' });
  });

  it('deletes a note', async () => {
    const { app } = createApp();
    await request(app).delete(`${BASE}/notes/n1`).expect(200);
  });

  it('deletes a plan', async () => {
    const { app } = createApp();
    await request(app).delete(`${BASE}/plans/p1`).expect(200);
  });

  it('still rejects a genuinely malformed body', async () => {
    const { app } = createApp();

    await request(app)
      .post(`${BASE}/notes`)
      .send({ notBody: 'nope' })
      .expect(400);
  });

  it('rejects malformed todo shapes', async () => {
    const { app } = createApp();

    await request(app)
      .put(`${BASE}/todos`)
      .send({ todos: [{ id: 1, text: 'bad id type' }] })
      .expect(400);
  });

  it('rejects an unknown note source', async () => {
    const { app } = createApp();

    await request(app)
      .post(`${BASE}/notes`)
      .send({ body: 'hello', source: 'somewhere-else' })
      .expect(400);
  });

  it('rejects a plan pin patch without a boolean', async () => {
    const { app } = createApp();

    await request(app)
      .patch(`${BASE}/plans/p1`)
      .send({ pinned: 'yes' })
      .expect(400);
  });

  it('rejects a plan save without raw content', async () => {
    const { app } = createApp();

    await request(app)
      .put(`${BASE}/plans/p1`)
      .send({ body: 'wrong field' })
      .expect(400);
  });

  it('returns 404 for an unknown plan', async () => {
    const { app } = createApp();
    await request(app).get(`${BASE}/plans/nope`).expect(404);
  });

  it('returns 404 when patching a note that does not exist', async () => {
    const { app } = createApp({ updateNote: async () => null });

    await request(app).patch(`${BASE}/notes/nope`).send({ body: 'x' }).expect(404);
  });

  it('returns 404 when deleting a note that does not exist', async () => {
    const { app } = createApp({ deleteNote: async () => ({ deleted: false, context: emptyContext }) });

    await request(app).delete(`${BASE}/notes/nope`).expect(404);
  });

  it('returns 404 when deleting a plan that does not exist', async () => {
    const { app } = createApp({ deletePlan: async () => ({ deleted: false, context: emptyContext }) });

    await request(app).delete(`${BASE}/plans/nope`).expect(404);
  });

  it('returns 404 when saving a plan whose markdown is gone', async () => {
    const { app } = createApp({ updatePlan: async () => null });

    await request(app).put(`${BASE}/plans/p1`).send({ raw: '# B' }).expect(404);
  });

  it('surfaces malformed stored context as a server error, not empty data', async () => {
    const { app } = createApp({
      readContext: async () => {
        throw new Error('Stored project context is malformed');
      },
    });

    const res = await request(app).get(BASE).expect(500);
    expect(res.body).toEqual({ error: 'Stored project context is malformed' });
  });

  it('rejects a traversal projectId as a client error', async () => {
    const { app } = createApp({
      readContext: async () => {
        throw new Error('projectId contains unsupported characters');
      },
    });

    await request(app).get('/api/project-context/..%2Fescape').expect(400);
  });
});
