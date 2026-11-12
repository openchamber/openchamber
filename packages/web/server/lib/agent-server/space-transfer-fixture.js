// Test support. Real HTTP authentication and real git, with a local exec stand-in.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { afterAll } from 'vitest';
import { createAgentUpstream } from './agent-upstream.js';
import { registerSpaceTransferRoutes } from './space-transfer-routes.js';
import { createTestHost, createLocalPlace, makeBait, removeTestHosts } from '../spaces/code-in-bait.js';
import { createCodeIn } from '../spaces/code-in.js';
import { createCodeOut } from '../spaces/code-out.js';
import { transferCaps, SPACE_TRANSFER_ROUTE } from '../spaces/transfer-bundle.js';

export const ID = 'a1b2c3d4e5f6';
const cleanups = [];
afterAll(removeTestHosts);
export async function cleanupTransfers() {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

export async function transferFixture(options = {}) {
  const host = createTestHost();
  const { repo, g } = makeBait(host);
  if (options.shallow) {
    const clone = path.join(host.root, 'shallow');
    host.sh(host.root, ['clone', '--quiet', '--depth', '1', `file://${repo}`, clone]);
    fs.rmSync(repo, { recursive: true });
    fs.renameSync(clone, repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'shallow uncommitted\n');
  }
  const dataDir = path.join(host.root, 'agent-data');
  fs.mkdirSync(dataDir);
  // ui-auth reads this variable at module initialization, as its existing fixtures do.
  const previous = process.env.OPENCHAMBER_DATA_DIR;
  process.env.OPENCHAMBER_DATA_DIR = dataDir;
  const { createUiAuth } = await import('../ui-auth/ui-auth.js');
  if (previous === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previous;
  const auth = createUiAuth({ password: 'disposable-d2a', readSettingsFromDiskMigrated: async () => ({}) });
  const app = express();
  app.post('/auth/session', express.json(), auth.handleSessionCreate);
  app.use('/api', auth.requireAuth);
  const caps = { ...transferCaps({}), timeoutMs: 60_000, ...options.caps };
  registerSpaceTransferRoutes(app, { agent: options.agent ?? true, dataDir, environment: { ...host.environment, ...options.agentEnvironment },
    readSettings: async () => ({ projects: [{ path: repo }] }), caps });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const upstream = createAgentUpstream({ url: origin, token: 'disposable-d2a' });
  cleanups.push(() => upstream.close());
  const local = createLocalPlace(host, 'receive', ID, { codeOut: true });
  const executed = [];
  const runCommand = async (file, args, request) => {
    // A front-door git command must never name the agent's project, including a subdirectory.
    if (args[0] === '-C' && (args[1] === repo || args[1].startsWith(`${repo}/`))) throw new Error('front door opened the project');
    executed.push(args);
    const { runCommand: run } = await import('../spaces/run-command.js');
    return run(file, args, request);
  };
  const environment = { ...host.environment, OPENCHAMBER_SPACE_AGENT_TIMEOUT_MS: '60000', ...options.environment };
  const dependencies = { upstream: options.upstream ?? upstream, dataDir: path.join(host.root, 'front-data'), place: local.place, environment, runCommand };
  const input = { repository: repo, spaceId: ID };
  const route = (operation, query = {}) => `${SPACE_TRANSFER_ROUTE}/${ID}/${operation}?${new URLSearchParams({ directory: repo, ...query })}`;
  return { host, repo, g, dataDir, caps, origin, upstream, input, route, local, executed,
    codeIn: createCodeIn(dependencies), codeOut: createCodeOut(dependencies) };
}
