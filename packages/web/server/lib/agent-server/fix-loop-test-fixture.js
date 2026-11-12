// Test-only data and authenticated HTTP fixture. Provider/Git services contain no credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { vi } from 'vitest';
import { createAgentUpstream } from './agent-upstream.js';
import { registerFixLoopServiceRoutes } from './fix-loop-service-routes.js';
import { FIX_LOOP_SERVICE_ROUTE } from './fix-loop-contract.js';

export const HEAD = 'a'.repeat(40);
export const RESULT = 'b'.repeat(40);
const RECEIPT = '12345678-1234-4234-8234-123456789abc';
export const REF = `refs/heads/openchamber-approval/${RECEIPT}`;
export const CONTEXT = { provider: 'github', instance: 'github.com', accountId: 'account', directory: '/repo',
  repositoryId: 'repository', bindingRevision: 2, primaryRemote: 'origin' };
export const TARGET = { owner: 'upstream', repo: 'app', number: 7 };
const SNAPSHOT = { state: 'open', branch: 'fix', headSha: HEAD, headRepo: { id: 'fork', owner: 'contributor', repo: 'app' } };
export const PULL = { ...TARGET, title: 'Fix', url: 'https://github.com/upstream/app/pull/7', branch: 'fix', snapshot: SNAPSHOT };
export const FEEDBACK = { ...SNAPSHOT, viewer: 'reader', title: 'Fix', url: PULL.url, base: 'main', reviewDecision: null,
  ci: { state: 'failure', total: 1, success: 0, failure: 1, pending: 0, contexts: [] }, reviews: [], threads: [], comments: [] };
export const BINDING = { revision: 2, repository: { repositoryId: 'repository', configRevision: 'config',
  remotes: [{ name: 'fork', push: { displayUrl: 'https://github.com/contributor/app.git', fingerprint: 'fingerprint' } }] },
  binding: { remotes: [{ name: 'fork', readiness: 'ready', mode: 'managed' }] } };
export const AUTHORITY = { repositoryId: 'repository', bindingRevision: 2, configRevision: 'config',
  remote: { name: 'fork', endpoint: BINDING.repository.remotes[0].push }, transportMode: 'managed' };
export const autoLoop = (id = 'fixloop_agent') => ({ ...TARGET, id, sessionId: 'ses_agent', directory: '/repo',
  title: 'Fix', url: PULL.url, branch: 'fix', status: 'watching', statusReason: null,
  config: { watch: true, maxIterations: 10, tokenBudget: null, triggers: 'both', ignoreSelf: false, ignoreBots: true,
    allowAuthors: [], blockAuthors: [], mentionOnly: false, mentionText: '@openchamber', pushMode: 'auto' },
  iterations: 0, totalIterations: 0, tokensUsed: 0, ci: null, unresolvedThreads: null, changesRequested: null,
  worker: null, pendingApproval: null, review: null, lastCheckedAt: null, lastError: null, createdAt: 1, updatedAt: 1 });
const cleanups = [];
export async function cleanupFixLoops() { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
export async function fixLoopServiceFixture({ agentServer = true, projectDirectory = null } = {}) {
  const root = await fs.mkdtemp('/tmp/opencode/d2c-service-');
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const directory = projectDirectory ?? path.join(root, 'project');
  if (!projectDirectory) await fs.mkdir(directory);
  const context = { ...CONTEXT, directory };
  const common = { directory, accountId: 'account', ...TARGET };
  const requests = {
    admit: { context, ...TARGET }, feedback: common,
    'author-permission': { directory, accountId: 'account', owner: TARGET.owner, repo: TARGET.repo, username: 'reviewer' },
    'failed-checks': { directory, accountId: 'account', owner: TARGET.owner, repo: TARGET.repo, contexts: [] },
    'read-binding': { directory }, 'fetch-head': { context, ...TARGET, head: HEAD },
    'capture-ref': { directory, commit: RESULT, expectedHead: HEAD, localRef: REF },
    publish: { input: { ...AUTHORITY, directory, operation: 'push', sourceRef: REF, destinationRef: 'refs/heads/fix',
      forceWithLease: { expectedRemoteSha: HEAD } }, commit: RESULT },
    'review-operation': { context, ...TARGET, commit: RESULT, ref: 'refs/heads/fix',
      operation: { kind: 'comment', body: 'Fixed', idempotencyKey: 'fix-review:turn:0' }, replayOnly: false },
    'head-metadata': { directory, head: HEAD },
  };
  const git = { admit: vi.fn(async () => ({ context, pull: PULL })), readBinding: vi.fn(async () => BINDING),
    fetchHead: vi.fn(async () => undefined), publish: vi.fn(async () => ({ state: 'succeeded', token: 'private' })),
    applyReviewOperation: vi.fn(async () => ({ secret: 'private' })) };
  const project = { caps: { bundleBytes: 1024, metadataBytes: 16384, timeoutMs: 1000 },
    captureRef: vi.fn(async (input) => ({ commit: input.commit, localRef: input.localRef })),
    readHead: vi.fn(async () => ({ head: HEAD, objectFormat: 'sha1', shallow: [] })),
    exportHead: vi.fn(async (_input, file) => fs.writeFile(file, 'bundle')) };
  const deps = { agentServer, readSettings: async () => ({ projects: [{ path: directory }] }), dataDir: root,
    gitServices: () => git, projectServices: project, getOctokit: vi.fn(async () => ({ opaqueClient: true })),
    readFeedback: vi.fn(async () => FEEDBACK), readAuthorPermission: vi.fn(async () => true), readFailedChecks: vi.fn(async () => []) };
  const previous = process.env.OPENCHAMBER_DATA_DIR;
  process.env.OPENCHAMBER_DATA_DIR = root;
  const { createUiAuth } = await import('../ui-auth/ui-auth.js');
  if (previous === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previous;
  const auth = createUiAuth({ password: 'disposable-d2c', readSettingsFromDiskMigrated: async () => ({}) });
  const app = express();
  app.post('/auth/session', express.json(), auth.handleSessionCreate);
  app.use('/api', auth.requireAuth);
  registerFixLoopServiceRoutes(app, deps);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const upstream = createAgentUpstream({ url: origin, token: 'disposable-d2c' });
  cleanups.push(() => upstream.close());
  const send = (operation, value = requests[operation]) => upstream.request({ path: `${FIX_LOOP_SERVICE_ROUTE}/${operation}`,
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { root, directory, context, requests, git, project, deps, upstream, origin, send };
}
