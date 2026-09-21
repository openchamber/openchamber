import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { registerAgentMemoryRoutes } from './routes.js';

/**
 * End-to-end route tests over real HTTP.
 *
 * Mounted on a bare express app, exactly as production runs: `core-routes`
 * parses only an allowlist of path prefixes so the OpenCode proxy keeps an
 * unread stream. The PATCH route is the one that carries a body, so it is the
 * one that has to attach its own `express.json()` — and these tests are what
 * would fail if it stopped.
 */

const entry = (overrides = {}) => ({
  id: 'mem-1',
  title: 'Uses bun',
  body: 'Tests run with bun test.',
  type: 'fact',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const createApp = (overrides = {}) => {
  const received = {};
  const runtime = {
    read: async (target) => {
      received.readTarget = target;
      return { version: 1, entries: [entry()] };
    },
    readAll: async (projectId) => {
      received.readAllProjectId = projectId;
      return { global: [entry()], project: [], globalFailed: false, projectFailed: false };
    },
    update: async (target, memoryId, patch) => {
      received.updateTarget = target;
      received.patch = patch;
      received.updatedId = memoryId;
      return { entry: entry(patch), entries: [entry(patch)] };
    },
    remove: async (target, memoryId) => {
      received.removeTarget = target;
      received.removedId = memoryId;
      return { deleted: true, entries: [] };
    },
    ...overrides.runtime,
  };

  const app = express();
  registerAgentMemoryRoutes(app, {
    agentMemoryRuntime: runtime,
    isAgentMemoryEnabled: overrides.isAgentMemoryEnabled,
  });
  return { app, received };
};

describe('scope resolution', () => {
  it('reads global scope', async () => {
    const { app, received } = createApp();

    const response = await request(app).get('/api/agent-memory?scope=global');

    expect(response.status).toBe(200);
    expect(received.readTarget).toEqual({ scope: 'global' });
  });

  it('reads project scope with its id', async () => {
    const { app, received } = createApp();

    await request(app).get('/api/agent-memory?scope=project&projectId=path_abc');

    expect(received.readTarget).toEqual({ scope: 'project', projectId: 'path_abc' });
  });

  it('refuses a project scope with no id rather than falling back to global', async () => {
    const { app, received } = createApp();

    const response = await request(app).get('/api/agent-memory?scope=project');

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('projectId is required');
    expect(received.readTarget).toBeUndefined();
  });

  it('refuses a missing scope', async () => {
    const { app } = createApp();

    const response = await request(app).get('/api/agent-memory');

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('scope must be');
  });

  it('refuses a delete with no scope before touching the store', async () => {
    const { app, received } = createApp();

    const response = await request(app).delete('/api/agent-memory/mem-1');

    expect(response.status).toBe(400);
    expect(received.removedId).toBeUndefined();
  });
});

describe('both scopes at once', () => {
  it('returns global and project together', async () => {
    const { app, received } = createApp();

    const response = await request(app).get('/api/agent-memory/all?projectId=path_abc');

    expect(response.status).toBe(200);
    expect(received.readAllProjectId).toBe('path_abc');
    expect(response.body.global).toHaveLength(1);
  });

  it('reads global alone when no project is open', async () => {
    const { app, received } = createApp();

    await request(app).get('/api/agent-memory/all');

    expect(received.readAllProjectId).toBeNull();
  });
});

describe('failures', () => {
  it('reports malformed storage as a server error', async () => {
    const { app } = createApp({
      runtime: {
        read: async () => { throw new Error('Stored agent memory is malformed'); },
      },
    });

    const response = await request(app).get('/api/agent-memory?scope=global');

    expect(response.status).toBe(500);
  });

  it('reports a bad project id as a client error', async () => {
    const { app } = createApp({
      runtime: {
        read: async () => { throw new Error('projectId contains unsupported characters'); },
      },
    });

    const response = await request(app).get('/api/agent-memory?scope=project&projectId=..');

    expect(response.status).toBe(400);
  });
});

describe('corrections', () => {
  it('patches a memory from a JSON body', async () => {
    // This route is the only one here that carries a body, so it is the only
    // one that needs its own parser — and the only place that can prove it.
    const { app, received } = createApp();

    const response = await request(app)
      .patch('/api/agent-memory/mem-1?scope=global')
      .send({ title: 'Clearer', body: 'Reworded.' });

    expect(response.status).toBe(200);
    expect(received.patch).toEqual({ title: 'Clearer', body: 'Reworded.' });
    expect(received.updatedId).toBe('mem-1');
  });

  it('rejects a non-string title', async () => {
    const { app } = createApp();

    const response = await request(app)
      .patch('/api/agent-memory/mem-1?scope=global')
      .send({ title: 42 });

    expect(response.status).toBe(400);
  });

  it('reports a missing memory as 404', async () => {
    const { app } = createApp({ runtime: { update: async () => null } });

    const response = await request(app)
      .patch('/api/agent-memory/nope?scope=global')
      .send({ body: 'x' });

    expect(response.status).toBe(404);
  });
});

describe('delete', () => {
  it('deletes the named memory in the named scope', async () => {
    const { app, received } = createApp();

    const response = await request(app).delete('/api/agent-memory/mem-1?scope=global');

    expect(response.status).toBe(200);
    expect(received.removedId).toBe('mem-1');
    expect(received.removeTarget).toEqual({ scope: 'global' });
  });

  it('reports a missing memory as 404', async () => {
    const { app } = createApp({ runtime: { remove: async () => ({ deleted: false, entries: [] }) } });

    const response = await request(app).delete('/api/agent-memory/nope?scope=global');

    expect(response.status).toBe(404);
  });
});

describe('the settings toggle disables the surface, not just its UI', () => {
  it('flags the disabled answer so a deleted entry cannot be mistaken for it', async () => {
    // Both answer 404. Without the flag a client would report one memory the
    // user just deleted as the whole feature being switched off.
    const off = createApp({ isAgentMemoryEnabled: () => false });
    const missing = createApp({ runtime: { remove: async () => ({ deleted: false, entries: [] }) } });

    const disabled = await request(off.app).get('/api/agent-memory?scope=global');
    const notFound = await request(missing.app).delete('/api/agent-memory/nope?scope=global');

    expect(disabled.status).toBe(404);
    expect(disabled.body.disabled).toBe(true);
    expect(notFound.status).toBe(404);
    expect(notFound.body.disabled).toBeUndefined();
  });

  it('refuses reads while memory is off', async () => {
    const { app, received } = createApp({ isAgentMemoryEnabled: () => false });

    const response = await request(app).get('/api/agent-memory?scope=global');

    expect(response.status).toBe(404);
    expect(received.readTarget).toBeUndefined();
  });

  it('refuses deletes from a stale client while memory is off', async () => {
    const { app, received } = createApp({ isAgentMemoryEnabled: () => false });

    const response = await request(app).delete('/api/agent-memory/mem-1?scope=global');

    expect(response.status).toBe(404);
    expect(received.removedId).toBeUndefined();
  });

  it('serves normally while memory is on', async () => {
    const { app } = createApp({ isAgentMemoryEnabled: () => true });

    expect((await request(app).get('/api/agent-memory?scope=global')).status).toBe(200);
  });

  it('honours a gate that resolves asynchronously', async () => {
    // The real gate reads the settings file. A synchronous truthiness test on
    // its promise would leave the surface open with memory turned off.
    const { app, received } = createApp({ isAgentMemoryEnabled: async () => false });

    const response = await request(app).get('/api/agent-memory?scope=global');

    expect(response.status).toBe(404);
    expect(received.readTarget).toBeUndefined();
  });

  it('closes the surface when the setting cannot be read', async () => {
    const { app, received } = createApp({
      isAgentMemoryEnabled: async () => { throw new Error('settings unreadable'); },
    });

    const response = await request(app).get('/api/agent-memory?scope=global');

    expect(response.status).toBe(503);
    expect(received.readTarget).toBeUndefined();
  });
});
