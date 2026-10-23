import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { createProjectConfigRuntime } from '../projects/project-config.js';
import { createScheduledTasksRuntime } from '../scheduled-tasks/runtime.js';
import { createNotificationCenterRuntime, createNotificationCenterPersistence } from '../notifications/center.js';
import { createMessageQueueRuntime } from '../message-queue/runtime.js';
import { createBotsHost } from './host.js';
import { botGit } from './production-git.js';

/** Real composition, persistence, routes and queues with controlled inference HTTP. */
export async function createHostFixture({ fetchImpl, policyOptions, getSpaceArchive, getSpacesHost = () => null } = {}) {
  const root = await fs.mkdtemp('/tmp/opencode/bots-host-');
  const dataDir = path.join(root, 'data');
  const project = { id: 'project', path: path.join(root, 'repository') };
  await fs.mkdir(project.path);
  await botGit(project.path, ['init', '--quiet', '--initial-branch=main']);
  await botGit(project.path, ['-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'Fixture']);
  await botGit(project.path, ['remote', 'add', 'origin', 'https://github.com/fixture/repository.git']);
  const records = new Map();
  const calls = { http: [], knowledge: [], alerts: [], events: [], modes: [] };
  const state = { active: {}, output: null };
  const upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://inference.test');
    calls.http.push({ method: req.method, path: url.pathname });
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/session/active') return res.end(JSON.stringify({ data: state.active }));
    if (url.pathname === '/api/session') return res.end(JSON.stringify({ data: [], cursor: {} }));
    if (url.pathname.endsWith('/message')) {
      const messages = state.output === null ? [] : [
        { id: 'idle_fixture', type: 'idle', outcome: 'succeeded', time: { created: Date.now() } },
        { id: 'msg_fixture', type: 'assistant', content: [{ type: 'text', text: JSON.stringify(state.output) }],
          tokens: { input: 3, output: 2, reasoning: 1, cache: { read: 4, write: 5 } }, time: { created: Date.now(), completed: Date.now() } },
      ];
      return res.end(JSON.stringify({ data: messages, cursor: {} }));
    }
    return res.end(JSON.stringify({ data: records.get(url.pathname.split('/').at(-1)) ?? [] }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const buildOpenCodeUrl = (route) => `http://127.0.0.1:${upstream.address().port}${route}`;
  const projectConfigRuntime = createProjectConfigRuntime({ fsPromises: fs, path, projectsDirPath: path.join(dataDir, 'projects') });
  const broadcast = (event) => calls.events.push(event);
  const center = createNotificationCenterRuntime({ persistence: createNotificationCenterPersistence({ dataDir }), broadcast, saveDelayMs: 0 });
  let host;
  const queue = createMessageQueueRuntime({ dataDir, buildOpenCodeUrl, getOpenCodeAuthHeaders: () => ({}),
    globalEventHub: { subscribeEvent: () => () => {}, subscribeStatus: () => () => {} },
    assertBotDispatch: (input) => host.assertDispatch(input), broadcastGlobalUiEvent: broadcast });
  const scheduler = createScheduledTasksRuntime({ projectConfigRuntime, listProjects: async () => [project],
    buildOpenCodeUrl, getOpenCodeAuthHeaders: () => ({}), runBot: (...args) => host.runScheduled(...args), logger: { info() {}, warn() {} } });
  const knowledge = { sync: async (...args) => { calls.knowledge.push(args); }, collect: async () => ({
    notes: [], plans: [], memory: { enabled: false, complete: true, global: [], project: [] },
  }) };
  const client = { session: {
    get: async ({ sessionID }) => ({ data: records.get(sessionID) }),
    update: async () => {},
  }, message: { list: async ({ sessionID }) => (await fetch(buildOpenCodeUrl(`/api/session/${sessionID}/message`))).json() } };
  const sessionService = {
    archiveStore: { isArchived: async () => false },
    create: async (input, options) => {
      const id = `ses_discovery_${records.size}`;
      records.set(id, { id, location: { directory: input.directory }, metadata: options.metadata });
      await options.onSessionCreated({ sessionId: id, directory: input.directory });
      return { sessionId: id, directory: input.directory };
    },
    send: async (sessionId) => { state.active[sessionId] = { type: 'running' }; return { promptDispatched: true }; },
  };
  const buildHost = () => createBotsHost({ dataDir, projectsDir: path.join(dataDir, 'projects'), projectConfigRuntime, fetchImpl, policyOptions,
    scheduledTasksRuntime: scheduler, listProjects: async () => [project], resolveProject: async () => project,
    sessionService, readOnlySessionService: sessionService, clientFor: () => client,
    permissionAutoAcceptRuntime: { setSessionPolicy: async (...args) => { calls.modes.push(args); } },
    sessionKnowledgeRuntime: knowledge, readSessionDefaults: async () => ({ providerID: 'fixture', modelID: 'model' }),
    buildOpenCodeUrl, getOpenCodeAuthHeaders: () => ({}), getSpacesHost, getSpaceArchive, messageQueueRuntime: queue,
    notificationCenter: center, notify: async (payload) => { calls.alerts.push(payload); }, broadcast,
    getFixLoopRuntime: () => ({ createBotWatch: async () => {}, stopBotWatch: async () => {} }), logger: { warn() {} } });
  host = buildHost();
  const app = express();
  host.registerRoutes(app);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/projects/project/bots`;
  const request = async (route = '', method = 'GET', body) => {
    const options = { method };
    if (body) {
      options.headers = { 'content-type': 'application/json' };
      options.body = JSON.stringify(body);
    }
    const response = await fetch(baseUrl + route, options);
    return { status: response.status, body: await response.json() };
  };
  return { host, buildHost, request, calls, state, records, root, dataDir, project, center, projectConfigRuntime, scheduler,
    async close() {
      await host.stop(); scheduler.stop(); queue.stop(); await queue.flush(); await center.stop();
      for (const entry of [server, upstream]) { entry.closeAllConnections(); await new Promise((resolve) => entry.close(resolve)); }
      await fs.rm(root, { recursive: true, force: true });
    } };
}
