import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { registerProjectContextRoutes } from './routes.js';
import { createProjectContextRuntime } from './runtime.js';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

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
    sharePlan: async (_projectId, planId) => (planId === 'p1' ? { plan: { id: 'shared:a.md', file: 'a.md', title: 'A', createdAt: 1, pinned: false, source: 'shared' }, context: emptyContext } : null),
    unsharePlan: async (_projectId, planId) => (planId === 'shared:a.md' ? { plan: { id: 'p2', file: 'a.md', title: 'A', createdAt: 1, pinned: false, source: 'personal' }, context: emptyContext } : null),
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

const withRuntime = async (run) => {
  const projectsDirPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-context-todos-http-'));
  try {
    let counter = 0;
    const runtime = createProjectContextRuntime({ fsPromises, path, projectsDirPath, createId: () => `item-${++counter}` });
    await run({ runtime, app: createApp(runtime).app });
  } finally {
    await fsPromises.rm(projectsDirPath, { recursive: true, force: true });
  }
};

describe('todo item routes', () => {
  it('keeps a todo an agent added after the panel read when the panel changes another one', () => withRuntime(async ({ runtime, app }) => {
    const created = await request(app).post(`${BASE}/todos`).send({ text: 'A' }).expect(201);
    const a = created.body.todos[0].id;
    await runtime.createTodo('path_dGVzdA', { text: 'agent' });

    const completed = await request(app).patch(`${BASE}/todos/${a}`).send({ completed: true }).expect(200);
    expect(completed.body.todos.map((todo) => [todo.text, todo.completed])).toEqual([['agent', false], ['A', true]]);
    const reopened = await request(app).patch(`${BASE}/todos/${a}`).send({ completed: false }).expect(200);
    expect(reopened.body.todos.map((todo) => todo.text)).toEqual(['agent', 'A']);
    const deleted = await request(app).delete(`${BASE}/todos/${a}`).expect(200);
    expect(deleted.body.todos.map((todo) => todo.text)).toEqual(['agent']);
    expect((await request(app).get(BASE).expect(200)).body.todos).toEqual(deleted.body.todos);
  }));

  it('keeps the id the panel already shows for a new todo, unless it is taken', () => withRuntime(async ({ app }) => {
    const first = await request(app).post(`${BASE}/todos`).send({ id: 'client-1', text: 'A' }).expect(201);
    expect(first.body.todos.map((todo) => todo.id)).toEqual(['client-1']);
    const taken = await request(app).post(`${BASE}/todos`).send({ id: 'client-1', text: 'B' }).expect(201);
    expect(taken.body.todos.map((todo) => todo.id)).toEqual(['client-1', 'item-1']);
    await request(app).post(`${BASE}/todos`).send({ id: 3, text: 'C' }).expect(400);
  }));

  it('answers a missing todo with 404 and malformed input with 400, writing nothing', () => withRuntime(async ({ app }) => {
    await request(app).delete(`${BASE}/todos/gone`).expect(404);
    await request(app).patch(`${BASE}/todos/gone`).send({ completed: true }).expect(404);
    for (const body of [{}, { text: '' }, { text: 1 }, { text: 'x'.repeat(1001) }]) {
      await request(app).post(`${BASE}/todos`).send(body).expect(400);
    }
    await request(app).patch(`${BASE}/todos/x`).send({ completed: 'yes' }).expect(400);
    await request(app).patch(`${BASE}/todos/x`).send({}).expect(400);
    expect((await request(app).get(BASE).expect(200)).body.todos).toEqual([]);
  }));
});

describe('plan links over HTTP', () => {
  const PROJECT_ID = 'path_dGVzdA';
  const todoOf = (response, id) => response.body.todos.find((todo) => todo.id === id);

  it('forwards todo plan links and dependencies; omission keeps them, null and [] clear them', () => withRuntime(async ({ runtime, app }) => {
    const { plan } = await runtime.createPlan(PROJECT_ID, { title: 'Plan', body: '' });
    await request(app).post(`${BASE}/todos`).send({ id: 'a', text: 'A', planId: plan.id }).expect(201);
    const created = await request(app).post(`${BASE}/todos`).send({ id: 'b', text: 'B', planId: plan.id, dependsOn: ['a'] }).expect(201);
    expect(todoOf(created, 'b')).toMatchObject({ planId: plan.id, dependsOn: ['a'] });

    // A text patch and a whole-list write from a client that never saw the fields keep them.
    await request(app).patch(`${BASE}/todos/b`).send({ text: 'B2' }).expect(200);
    const legacy = (await request(app).get(BASE)).body.todos.map(({ id, text, completed, createdAt }) => ({ id, text, completed, createdAt }));
    const reordered = await request(app).put(`${BASE}/todos`).send({ todos: legacy.reverse() }).expect(200);
    expect(todoOf(reordered, 'b')).toMatchObject({ text: 'B2', planId: plan.id, dependsOn: ['a'] });

    await request(app).patch(`${BASE}/todos/a`).send({ planId: 3 }).expect(400);
    await request(app).patch(`${BASE}/todos/b`).send({ dependsOn: [] }).expect(200);
    const unlinked = await request(app).patch(`${BASE}/todos/b`).send({ planId: null }).expect(200);
    expect(todoOf(unlinked, 'b')).toEqual({ id: 'b', text: 'B2', completed: false, createdAt: expect.any(Number) });
  }));

  it('deletes a referenced todo or a linked plan by unlinking what pointed at it', () => withRuntime(async ({ runtime, app }) => {
    const { plan } = await runtime.createPlan(PROJECT_ID, { title: 'Plan', body: '' });
    await request(app).post(`${BASE}/todos`).send({ id: 'a', text: 'A', planId: plan.id }).expect(201);
    await request(app).post(`${BASE}/todos`).send({ id: 'b', text: 'B', planId: plan.id, dependsOn: ['a'] }).expect(201);
    await request(app).post(`${BASE}/todos`).send({ id: 'c', text: 'C', planId: plan.id, dependsOn: ['b'] }).expect(201);

    const deleted = await request(app).delete(`${BASE}/todos/a`).expect(200);
    expect(deleted.body.todos.find((todo) => todo.id === 'b').dependsOn).toBeUndefined();
    const saved = await request(app).put(`${BASE}/todos`).send({ todos: [{ id: 'c', text: 'C' }] }).expect(200);
    expect(saved.body.todos).toEqual([{ id: 'c', text: 'C', completed: false, createdAt: expect.any(Number), planId: plan.id }]);
    await request(app).delete(`${BASE}/plans/${plan.id}`).expect(200);
    expect((await runtime.readContext(PROJECT_ID)).todos).toEqual([{ id: 'c', text: 'C', completed: false, createdAt: expect.any(Number) }]);
  }));

  it('links a note to a plan, keeps the link through a pin and unlinks it with null', () => withRuntime(async ({ runtime, app }) => {
    const { plan } = await runtime.createPlan(PROJECT_ID, { title: 'Plan', body: '' });
    const created = await request(app).post(`${BASE}/notes`).send({ body: 'N', planId: plan.id }).expect(201);
    expect(created.body.note.planId).toBe(plan.id);
    const pinned = await request(app).patch(`${BASE}/notes/${created.body.note.id}`).send({ pinned: true }).expect(200);
    expect(pinned.body.note).toMatchObject({ pinned: true, planId: plan.id });
    const unlinked = await request(app).patch(`${BASE}/notes/${created.body.note.id}`).send({ planId: null }).expect(200);
    expect(unlinked.body.note).not.toHaveProperty('planId');
  }));

  it('sets and clears the plan session, refusing a body without a string or null', () => withRuntime(async ({ runtime, app }) => {
    const { plan } = await runtime.createPlan(PROJECT_ID, { title: 'Plan', body: '' });
    const linked = await request(app).put(`${BASE}/plans/${plan.id}/session`).send({ sessionId: 'ses_1' }).expect(200);
    expect(linked.body.plan.session).toMatchObject({ sessionId: 'ses_1' });
    const cleared = await request(app).put(`${BASE}/plans/${plan.id}/session`).send({ sessionId: null }).expect(200);
    expect(cleared.body.plan).not.toHaveProperty('session');
    await request(app).put(`${BASE}/plans/${plan.id}/session`).send({ sessionId: 3 }).expect(400);
  }));
});

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

  it('shares and unshares a plan, and answers 404 for an unknown one', async () => {
    const { app } = createApp();
    const shared = await request(app).post('/api/project-context/proj/plans/p1/share');
    expect(shared.status).toBe(200);
    expect(shared.body.plan.id).toBe('shared:a.md');
    const back = await request(app).post('/api/project-context/proj/plans/shared%3Aa.md/unshare');
    expect(back.status).toBe(200);
    expect(back.body.plan.source).toBe('personal');
    expect((await request(app).post('/api/project-context/proj/plans/nope/share')).status).toBe(404);
  });

  it('answers 400 when sharing without a shared plans folder', async () => {
    const { app } = createApp({ sharePlan: async () => { throw new Error('shared plans folder is required'); } });
    expect((await request(app).post('/api/project-context/proj/plans/p1/share')).status).toBe(400);
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

describe('plan session route', () => {
  it('reads the session id from a JSON body and answers with the plan', async () => {
    const seen = [];
    const { app } = createApp({
      setPlanSession: async (_projectId, planId, value) => {
        seen.push({ planId, ...value });
        return { plan: { id: planId, file: 'a.md', title: 'A', createdAt: 1, pinned: false, session: { sessionId: value.sessionId, linkedAt: 1 } }, context: emptyContext };
      },
    });

    const res = await request(app).put(`${BASE}/plans/p1/session`).send({ sessionId: 'ses_1' }).expect(200);
    expect(seen).toEqual([{ planId: 'p1', sessionId: 'ses_1' }]);
    expect(res.body.plan.session.sessionId).toBe('ses_1');
  });

  it('rejects a body without a session id and reports an unknown plan as 404', async () => {
    const { app } = createApp({ setPlanSession: async () => null });
    await request(app).put(`${BASE}/plans/p1/session`).send({}).expect(400);
    await request(app).put(`${BASE}/plans/nope/session`).send({ sessionId: 'ses_1' }).expect(404);
  });
});
