import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import supertest from 'supertest';
import { expect, vi } from 'vitest';
import { createBootstrapRuntime } from '../opencode/bootstrap-runtime.js';
import { registerServerStatusRoutes, registerCommonRequestMiddleware, registerAuthAndAccessRoutes } from '../opencode/core-routes.js';
import { registerOpenChamberRoutes } from '../opencode/openchamber-routes.js';
import { registerTtsRoutes } from '../tts/routes.js';
import { registerNotificationRoutes } from '../notifications/routes.js';
import { createTunnelAuth } from '../opencode/tunnel-auth.js';
import { createRemoteClientAuthRuntime } from '../client-auth/remote-clients.js';
import { createAgentToolRuntime } from '../agent-tool/runtime.js';
import { createOpenChamberControlService } from '../openchamber-control/service.js';
import { registerOpenChamberControlRoutes } from '../openchamber-control/routes.js';
import { createProjectDirectoryRuntime } from '../opencode/project-directory-runtime.js';
import { createSettingsNormalizationRuntime } from '../opencode/settings-normalization-runtime.js';
import { createMessageStreamWsRuntime } from '../event-stream/runtime.js';
import { createTerminalRuntime } from '../terminal/runtime.js';
import { registerFsRoutes } from '../fs/routes.js';
import { registerOpenCodeRoutes } from '../opencode/routes.js';
import { registerOpenCodeProxy } from '../opencode/proxy.js';
import { registerScheduledTaskRoutes } from '../scheduled-tasks/routes.js';
import { registerAgentMemoryRoutes } from '../agent-memory/routes.js';
import { ACTIONS } from './contract.js';
import { hashIntegrationToken } from './auth.js';

export const requestBody = (action = 'projects.list', input = {}) => ({
  schemaVersion: 1, requestId: crypto.randomUUID(), action, input,
});

export const createTestApp = async ({ password = 'fixture-password' } = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-integration-app-'));
  const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
  const previousPolicyFile = process.env.OPENCHAMBER_INTEGRATION_POLICY_FILE;
  process.env.OPENCHAMBER_DATA_DIR = root;
  process.env.OPENCHAMBER_INTEGRATION_POLICY_FILE = path.join(root, 'policy.json');
  const { createUiAuth } = await import('../ui-auth/ui-auth.js');
  const alpha = path.join(root, 'alpha');
  const beta = path.join(root, 'beta');
  await Promise.all([alpha, beta].map((directory) => fs.mkdir(directory)));
  const token = `oc_integration_${crypto.randomBytes(32).toString('base64url')}`;
  const policy = { schemaVersion: 1, domainId: 'alpha', credentials: [{
    id: 'hermes', domain: 'alpha', tokenHash: hashIntegrationToken(token),
    projectIds: ['alpha'], actions: [...ACTIONS], enabled: true, expiresAt: '2999-01-01T00:00:00Z',
  }] };
  const savePolicy = () => fs.writeFile(path.join(root, 'policy.json'), JSON.stringify(policy));
  await savePolicy();
  const settings = { projects: [{ id: 'alpha', path: alpha, label: 'Alpha' }, { id: 'beta', path: beta, label: 'Beta' }] };
  const sessions = [{ id: 'foreign', location: { directory: beta }, title: 'Private' }, { id: 'human', location: { directory: alpha }, title: 'Human' }];
  const readSettingsFromDiskMigrated = async () => settings;
  const normalization = createSettingsNormalizationRuntime({ os, path, processLike: process, realpathSync });
  const scopeDependencies = {
    readSettingsFromDiskMigrated,
    sanitizeProjects: normalization.sanitizeProjects,
    ...createProjectDirectoryRuntime({ fsPromises: fs, path, ...normalization, readSettingsFromDiskMigrated }),
  };
  const sessionService = {
    create: vi.fn(async (payload) => ({ sessionId: 'created', promptDispatched: true, ...payload })),
    send: vi.fn(async (sessionId, payload) => ({ sessionId, promptDispatched: true, ...payload })),
    fork: vi.fn(async (sessionId, payload) => ({ sourceSessionId: sessionId, sessionId: 'forked', promptDispatched: true, ...payload })),
  };
  const client = {
    session: {
      get: vi.fn(async ({ sessionID }) => sessions.find(({ id }) => id === sessionID)),
      list: vi.fn(async () => ({ data: sessions })),
      active: vi.fn(async () => ({})),
    },
    message: { list: vi.fn(async () => ({ data: [{ id: 'msg', type: 'assistant', time: { created: 1 }, content: [{ type: 'text', text: 'Hello' }] }] })) },
  };
  const controlService = createOpenChamberControlService({
    ...scopeDependencies, sessionService, createClient: () => client,
    buildOpenCodeUrl: () => 'http://127.0.0.1:1', getOpenCodeAuthHeaders: () => ({}),
  });
  const execute = vi.spyOn(controlService, 'execute');
  const remoteClientAuthRuntime = createRemoteClientAuthRuntime({ fsPromises: fs, path, crypto, storePath: path.join(root, 'clients.json') });
  const commonClient = await remoteClientAuthRuntime.createClient({ label: 'Human' });
  const app = express();
  const server = http.createServer(app);
  const agentToolRuntime = createAgentToolRuntime({ crypto, fsPromises: fs, path, instanceDir: root,
    getActivePort: () => 12345, executeAction: controlService.execute, env: {} });
  const agentEnv = agentToolRuntime.createChildEnv();
  const bootstrap = createBootstrapRuntime({
    express, createUiAuth, registerServerStatusRoutes, registerCommonRequestMiddleware,
    registerAuthAndAccessRoutes, registerTtsRoutes, registerNotificationRoutes, registerOpenChamberRoutes,
    registerAgentToolRoutes: (target, options) => options.agentToolRuntime.registerRoutes(target, options.express),
  });
  const { uiAuthController } = bootstrap.setupBaseRoutes(app, {
    ...scopeDependencies, process, server, fs, os, path, __dirname: root, openchamberDataDir: root,
    openChamberControlService: controlService, uiPassword: password,
    remoteClientAuthRuntime, tunnelAuthController: createTunnelAuth(), agentToolRuntime,
    sessionRuntime: {}, getHealthSnapshot: () => ({}), verboseRequestLogs: true,
  });
  registerOpenChamberControlRoutes(app, { controlService });
  registerOpenCodeRoutes(app, { ...scopeDependencies, readSettingsFromDisk: readSettingsFromDiskMigrated,
    formatSettingsResponse: (value) => value });
  registerFsRoutes(app, { ...scopeDependencies, ...normalization, os, path, fsPromises: fs, crypto, openchamberUserConfigRoot: root });
  registerScheduledTaskRoutes(app, { ...scopeDependencies, scheduledTaskService: { status: async () => ({ enabled: true }) } });
  registerAgentMemoryRoutes(app, { isAgentMemoryEnabled: async () => true, agentMemoryRuntime: { list: async () => [] } });
  const rejectWebSocketUpgrade = (socket, status) => { if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Unauthorized\r\n\r\n`); };
  const terminal = createTerminalRuntime({ app, server, fs, path, uiAuthController,
    isRequestOriginAllowed: async () => true, rejectWebSocketUpgrade,
    buildAugmentedPath: () => '', searchPathFor: () => null, isExecutable: () => false });
  const wsRuntime = createMessageStreamWsRuntime({
    server, uiAuthController, wsClients: new Set(), isRequestOriginAllowed: async () => true,
    rejectWebSocketUpgrade,
    buildOpenCodeUrl: () => 'http://127.0.0.1:1', getOpenCodeAuthHeaders: () => ({}),
  });
  registerOpenCodeProxy(app, { fs: { promises: fs }, os, path, getRuntime: () => ({ isOpenCodeReady: false }),
    getOpenCodeAuthHeaders: () => ({}), buildOpenCodeUrl: () => 'http://127.0.0.1:1', ensureOpenCodeApiPrefix: async () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const request = supertest(server);
  const login = password
    ? await request.post('/auth/session').send({ password })
    : await request.get('/auth/session');
  expect(login.status).toBe(200);
  const cookie = login.headers['set-cookie']?.map((entry) => entry.split(';')[0]).join('; ');
  if (password) {
    expect(cookie?.startsWith(`oc_ui_session_${server.address().port}=`)).toBe(true);
    const session = await request.get('/auth/session').set('Cookie', cookie);
    expect(session.body.authenticated).toBe(true);
  }
  return {
    app, server, request, cookie, root, alpha, beta, policy, savePolicy, token,
    commonToken: commonClient.token, agentToken: agentEnv.OPENCHAMBER_AGENT_TOOL_TOKEN,
    sessionService, sessions, client, controlService, execute,
    close: async () => {
      await terminal.shutdown();
      wsRuntime.wsServer.close();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await fs.rm(root, { recursive: true, force: true });
      if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
      else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
      if (previousPolicyFile === undefined) delete process.env.OPENCHAMBER_INTEGRATION_POLICY_FILE;
      else process.env.OPENCHAMBER_INTEGRATION_POLICY_FILE = previousPolicyFile;
    },
  };
};
