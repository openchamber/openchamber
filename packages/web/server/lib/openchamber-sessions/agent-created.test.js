import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpenChamberSessionService } from './routes.js';
import { createOpenChamberControlService } from '../openchamber-control/service.js';

const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function harness(listChildren) {
  const app = express();
  app.use(express.json());
  const calls = [];
  const history = [
    { id: 'msg_user', type: 'user', time: { created: 1 }, text: 'Original' },
    { id: 'msg_answer', type: 'assistant', agent: 'build', model: { id: 'test', providerID: 'test' }, time: { created: 2, completed: 3 }, content: [{ type: 'tool', id: 'call_read', name: 'read', time: { created: 2, completed: 3 }, state: { status: 'completed', input: { path: 'a.ts' }, content: [{ type: 'text', text: 'contents' }] } }] },
    { id: 'msg_boundary', type: 'user', time: { created: 4 }, text: 'Excluded' },
  ];
  app.get('/api/experimental/session/:id/export', (req, res) => res.json({ data: { info: parent, messages: history } }));
  app.get('/api/agent', (req, res) => res.json({ data: [] }));
  app.get('/api/model', (req, res) => res.json({ data: [] }));
  app.get('/api/config', (req, res) => res.json({ data: [] }));
  app.get('/api/session', async (req, res) => {
    if (listChildren) return res.json(await listChildren(req.query));
    if (req.query.parentID === 'ses_broken') return res.status(500).json({ error: 'unavailable' });
    if (req.query.parentID === 'ses_paged') return res.json({ data: [{ id: 'ses_page_one' }], cursor: { next: 'second-page' } });
    if (req.query.cursor === 'second-page') return res.json({ data: [{ id: 'ses_page_two' }], cursor: {} });
    const children = { ses_parent: [{ id: 'ses_cold', parentID: 'ses_parent' }], ses_cold: [{ id: 'ses_leaf', parentID: 'ses_cold' }] };
    res.json({ data: children[req.query.parentID] ?? [], cursor: {} });
  });
  const parent = {
    id: 'ses_parent', projectID: 'proj_parent', location: { directory: '/parent' },
    permissions: [{ action: 'read', resource: '*', effect: 'allow' }],
  };
  app.get('/api/session/:id', (req, res) => {
    if (req.params.id !== parent.id) return res.status(404).json({ error: 'missing parent' });
    res.json({ data: parent });
  });
  app.post('/api/experimental/session/import', (req, res) => {
    calls.push({ route: 'import', body: req.body });
    res.json({ data: req.body.info });
  });
  app.post('/api/session', (req, res) => {
    calls.push({ route: 'create', body: req.body });
    res.json({ data: { id: 'ses_root', ...req.body } });
  });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const dependencies = {
    readSettingsFromDiskMigrated: async () => ({ projects: [] }),
    sanitizeProjects: (projects) => projects,
    validateDirectoryPath: async (directory) => ({ ok: true, directory }),
    buildOpenCodeUrl: (route) => `${baseUrl}${route}`,
    getOpenCodeAuthHeaders: () => ({}),
    archiveStore: {
      isArchived: async (id) => id === 'ses_cold',
      archive: async (ids, archivedAt) => ({ archived: ids.map((id) => ({ id, archivedAt })), failedIds: [] }),
    },
    sessionMetadataStore: {},
  };
  const sessionService = createOpenChamberSessionService(dependencies);
  const service = createOpenChamberControlService({ ...dependencies, sessionService });
  return { service, sessionService, calls, history, parent };
}

describe('agent-created session relationship over the official client', () => {
  it('bounds parallel root and descendant reads while visiting every child', async () => {
    let active = 0;
    let peak = 0;
    const { sessionService } = await harness(async ({ parentID }) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return { data: parentID.startsWith('root')
        ? Array.from({ length: 9 }, (_, index) => ({ id: `${parentID}_child_${index}` })).filter(() => !parentID.includes('_'))
        : [], cursor: {} };
    });
    const result = await sessionService.archive({ ids: ['root1', 'root2', 'root3', 'root4', 'root5'] });
    expect(result.failedIds).toEqual([]);
    expect(result.archived).toHaveLength(50);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(16);
    expect(active).toBe(0);
  });
  it.each(['pending', 'running', 'incomplete'])('excludes trailing %s assistant history and resets usage', async (status) => {
    const { sessionService, calls, history, parent } = await harness();
    parent.cost = 123;
    parent.tokens = { input: 10, output: 20, reasoning: 30, cache: { read: 40, write: 50 } };
    history.pop();
    if (status === 'incomplete') delete history[1].time.completed;
    else history[1].content[0].state.status = status;
    await sessionService.fork('ses_source', { directory: '/destination', prompt: 'Continue' }, { parentID: 'ses_parent' }).catch(() => undefined);
    const imported = calls.find((call) => call.route === 'import')?.body;
    expect(imported.messages.map((message) => message.type)).toEqual(['user']);
    expect(imported.info.cost).toBe(0);
    expect(imported.info.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
  });
  it('allows an empty source prefix', async () => {
    const { sessionService, calls, history } = await harness();
    history.length = 0;
    await sessionService.fork('ses_source', { directory: '/destination', prompt: 'Continue' }, { parentID: 'ses_parent' }).catch(() => undefined);
    expect(calls.find((call) => call.route === 'import')?.body.messages).toEqual([]);
  });
  it('imports only pre-boundary history with new message IDs and preserved tool references at the destination', async () => {
    const { sessionService, calls } = await harness();
    await sessionService.fork('ses_source', { directory: '/destination', messageId: 'msg_boundary', prompt: 'Continue' }, { parentID: 'ses_parent' }).catch(() => undefined);
    const imported = calls.find((call) => call.route === 'import')?.body;
    expect(imported.location).toEqual({ directory: '/destination' });
    expect(imported.info.parentID).toBe('ses_parent');
    expect(imported.messages.map((message) => message.type)).toEqual(['user', 'assistant']);
    expect(imported.messages[0].text).toBe('Original');
    expect(imported.messages[0].id).not.toBe('msg_user');
    expect(imported.messages[1].id).not.toBe('msg_answer');
    expect(imported.messages[1].content[0]).toEqual({ type: 'tool', id: 'call_read', name: 'read', time: { created: 2, completed: 3 }, state: { status: 'completed', input: { path: 'a.ts' }, content: [{ type: 'text', text: 'contents' }] } });
  });
  it('finishes complete roots and every child page when another root cannot be discovered', async () => {
    const { sessionService } = await harness();
    expect(await sessionService.archive({ ids: ['ses_broken', 'ses_paged'], archivedAt: 123 })).toEqual({
      archived: [{ id: 'ses_paged', archivedAt: 123 }, { id: 'ses_page_one', archivedAt: 123 }, { id: 'ses_page_two', archivedAt: 123 }],
      failedIds: ['ses_broken'],
    });
  });
  it('archives unloaded descendants through an archived intermediate', async () => {
    const { sessionService } = await harness();
    expect(await sessionService.archive({ ids: ['ses_parent'], archivedAt: 123 })).toEqual({
      archived: [{ id: 'ses_parent', archivedAt: 123 }, { id: 'ses_leaf', archivedAt: 123 }], failedIds: [],
    });
  });
  it('imports an empty child with its caller as parent across directories', async () => {
    const { service, calls } = await harness();
    const result = await service.execute('session.create', { directory: '/child', title: 'Worker' }, '/parent', {
      contextSessionId: 'ses_parent',
    });
    expect(result.directory).toBe('/child');
    expect(calls).toEqual([{
      route: 'import',
      body: {
        info: {
          id: result.sessionId,
          parentID: 'ses_parent',
          projectID: 'proj_parent',
          location: { directory: '/child' },
          title: 'Worker',
          permissions: [{ action: 'read', resource: '*', effect: 'allow' }],
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: expect.any(Number), updated: expect.any(Number) },
        },
        messages: [],
        location: { directory: '/child' },
      },
    }]);
    expect(result.sessionId).toMatch(/^ses_/);
  });

  it('keeps user-created sessions as roots and ignores a caller-supplied parent parameter', async () => {
    const { service, calls } = await harness();
    const result = await service.execute('session.create', { directory: '/root', parentID: 'ses_parent' });
    expect(result.sessionId).toBe('ses_root');
    expect(calls).toEqual([{ route: 'create', body: { location: { directory: '/root' } } }]);
  });

  it('does not create a root when the calling parent cannot be loaded', async () => {
    const { service, calls } = await harness();
    await expect(service.execute('session.create', { directory: '/child' }, '/parent', {
      contextSessionId: 'ses_missing',
    })).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
