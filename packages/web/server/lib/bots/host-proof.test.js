import fs from 'node:fs/promises';
import path from 'node:path';
import { watch } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { expect, it } from 'vitest';
import { createHostFixture } from './host-test-support.js';
import { createBotStore } from './store.js';
import { createBotItem } from './schema.js';
import { createBotExecutionStore } from './execution-store.js';
import { createBotIdentityStore } from './identities.js';
import { createBotServices } from './services.js';
import { createBotServiceContext } from './service-context.js';
import { createProductionBotWorktrees } from './production-worktrees.js';
import { botDefinitionSchema } from './config.js';
import { botGit } from './production-git.js';
import { controlledUpstream, disconnectedPolicy } from './services/http.test-support.js';

it.each(['running', 'startup'])('production host shutdown cancels its actual proof process during %s and drains checkout cleanup', async (phase) => {
  let base;
  const upstream = await controlledUpstream(async ({ path: route }) => {
    if (route === '/app') return { body: { id: 1, slug: 'fixture' } };
    if (route === '/app/installations/2') return { body: { id: 2, app_id: 1, suspended_at: null } };
    if (route === '/app/installations/2/access_tokens') return { body: { token: 'disposable-installation', expires_at: new Date(Date.now() + 3600_000).toISOString() } };
    if (route === '/users/fixture%5Bbot%5D') return { body: { id: 42, login: 'fixture[bot]', type: 'Bot' } };
    if (route === '/repos/fixture/repository') return { body: { default_branch: 'main' } };
    if (route === '/repos/fixture/repository/git/ref/heads/main') return { body: { ref: 'refs/heads/main', object: { sha: base } } };
    return { status: 404 };
  });
  const f = await createHostFixture({ fetchImpl: upstream.fetchImpl, policyOptions: disconnectedPolicy });
  let watcher; let pid; let pumping; let emergency;
  try {
    base = (await botGit(f.project.path, ['rev-parse', 'HEAD'])).trim();
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const identity = await f.request('/identities', 'POST', { kind: 'github-app', label: 'Disposable app', appId: '1', installationId: '2', privateKey });
    expect(identity.status).toBe(200);
    const pidFile = path.join(f.root, 'proof.pid');
    const program = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(`${pidFile}.tmp`)},String(process.pid));fs.renameSync(${JSON.stringify(`${pidFile}.tmp`)},${JSON.stringify(pidFile)});setTimeout(()=>process.exit(0),8000);`;
    const bot = botDefinitionSchema.parse({ id: 'proof', name: 'Proof bot', mission: 'Fix a verified bug', enabled: phase === 'startup',
      identity: { github: { kind: 'app', identityId: identity.body.identity.id } }, proof: { command: process.execPath, args: ['-e', program] } });
    await f.projectConfigRuntime.updateBotsSection('project', () => ({ definitions: [bot] }));
    const store = createBotStore({ projectsDirPath: path.join(f.dataDir, 'projects') });
    const item = createBotItem({ id: 'host-proof', botId: bot.id, source: { kind: 'manual', id: 'host-proof' }, title: 'Host proof' });
    await store.update('project', (snapshot) => ({ snapshot: { ...snapshot, items: [item] } }));
    const identities = createBotIdentityStore({ dataDir: f.dataDir });
    const services = createBotServices({ dataDir: f.dataDir, identities, fetchImpl: upstream.fetchImpl, policyOptions: disconnectedPolicy });
    const context = createBotServiceContext({ identities, services, fetchImpl: upstream.fetchImpl, policyOptions: disconnectedPolicy });
    const worktrees = createProductionBotWorktrees({ dataDir: f.dataDir, context, readItem: async () => (await store.read('project')).items[0] });
    const checkout = await worktrees.create({ project: f.project, bot, item, key: 'host-proof:checkout' });
    const commit = async (message) => {
      await botGit(checkout.directory, ['add', '.']);
      await botGit(checkout.directory, ['-c', 'commit.gpgsign=false', 'commit', '-qm', message]);
      return (await botGit(checkout.directory, ['rev-parse', 'HEAD'])).trim();
    };
    await fs.writeFile(path.join(checkout.directory, 'regression.test.js'), 'throw new Error("Regression");\n');
    const testSha = await commit('Regression');
    await fs.writeFile(path.join(checkout.directory, 'fix.js'), 'export const fixed = true;\n');
    const fixSha = await commit('Fix');
    for (const state of ['investigating', 'fixing']) await store.update('project', (snapshot) => ({ snapshot: { ...snapshot,
      items: [{ ...snapshot.items[0], state }] } }));
    await store.update('project', (snapshot) => ({ snapshot: { ...snapshot, items: [{ ...snapshot.items[0], state: 'proving',
      worktree: checkout.directory, branch: checkout.branch, sessions: { fixing: 'ses_host_proof' } }] } }));
    await createBotExecutionStore({ store }).update('project', item.id, (entry) => ({ ...entry, data: { ...entry.data, checkout,
      runs: { 'fixing:0': { projectId: 'project', itemId: item.id, directory: checkout.directory, stage: 'fixing', dispatchedAt: 1, bot } } } }));
    if (phase === 'running') {
      expect(await f.host.start()).toEqual({ failures: [] });
      await f.projectConfigRuntime.updateBotsSection('project', (settings) => ({ ...settings, definitions: [{ ...bot, enabled: true }] }));
    }
    const entered = new Promise((resolve, reject) => {
      emergency = setTimeout(() => reject(new Error('Production proof never started')), 6_000);
      watcher = watch(f.root, async (_event, name) => {
        if (name !== 'proof.pid') return;
        try { pid = Number(await fs.readFile(pidFile, 'utf8')); resolve(); } catch (error) { reject(error); }
      });
    });
    pumping = phase === 'startup' ? f.host.start() : f.host.runtime.pump('project');
    await entered;
    clearTimeout(emergency);
    expect(process.kill(pid, 0)).toBe(true);
    const stopping = f.host.stop();
    try {
      await Promise.race([stopping, new Promise((_, reject) => {
        emergency = setTimeout(() => reject(new Error('Production shutdown failed to cancel proof')), 4_000);
      })]);
    } finally { clearTimeout(emergency); }
    await pumping;
    const current = (await store.read('project')).items[0];
    expect(current).toMatchObject({ state: 'proving', proof: { status: 'inconclusive', testSha, fixSha, testExitCode: null, fixExitCode: null } });
    expect(await fs.readdir(path.join(f.dataDir, 'bots/proof'))).toEqual([]);
    expect((await botGit(checkout.directory, ['rev-parse', 'HEAD'])).trim()).toBe(fixSha);
    expect(f.calls.http.some((entry) => entry.method === 'POST')).toBe(false);
    expect(upstream.requests.some((entry) => entry.path.endsWith('/pulls'))).toBe(false);
    expect(() => f.host.runtime.pump('project')).toThrow('The bot host is waiting for OpenCode readiness.');
  } finally {
    clearTimeout(emergency);
    watcher?.close();
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await pumping;
    await f.close();
    await upstream.close();
  }
}, 20_000);
