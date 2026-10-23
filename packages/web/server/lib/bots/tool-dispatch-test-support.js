import path from 'node:path';
import { createBotDriver } from './runtime-test-support.js';
import { createBotServices } from './services.js';
import { createBotIdentityStore } from './identities.js';
import { createBotExecutionStore } from './execution-store.js';
import { createMutationStore } from '../source-control/mutation-storage.js';
import { accountCredential, controlledUpstream, disconnectedPolicy, gitHubTarget } from './services/http.test-support.js';

/** Real runtime, identity/HTTP adapters and disk journals with controlled peers.
 * No SDK or provider fixture in this driver represents live authentication.
 */
export const createToolDispatchDriver = async (root) => {
  const driver = await createBotDriver(root, { held: ['fixing'] });
  const controls = { credentialAvailable: true, contextAvailable: true, blocked: false,
    afterPrepare: null, loseResponse: false, writes: 0 };
  const pulls = new Map();
  const upstream = await controlledUpstream((request) => {
    if (request.path === '/user') return { body: { id: 42, login: 'user-42' } };
    const number = Number(request.path.match(/\/pulls\/(\d+)$/)?.[1]);
    if (pulls.has(number)) return { body: pulls.get(number) };
    if (/\/issues\/\d+\/comments$/.test(request.path) && request.method === 'POST') {
      controls.writes += 1;
      return controls.loseResponse ? { disconnect: true } : { body: { id: 800 + controls.writes } };
    }
    return { status: 404 };
  });
  const dataDir = path.join(root, 'providers');
  const identities = createBotIdentityStore({ dataDir, readGitHubAccount: async () => controls.credentialAvailable ? accountCredential() : null });
  const identity = await identities.create({ kind: 'github-account', label: 'Controlled identity', accountId: 'account-one', credentialRevision: 1 });
  const policyOptions = { ...disconnectedPolicy, readFile: () => {
    if (controls.blocked) return JSON.stringify({ enterpriseMode: true, allowedBotDestinations: [] });
    throw Object.assign(new Error(), { code: 'ENOENT' });
  } };
  const services = createBotServices({ dataDir, identities, fetchImpl: upstream.fetchImpl, policyOptions });
  driver.dependencies.services = { ...services, async prepare(request) {
    const effect = await services.prepare(request);
    await controls.afterPrepare?.();
    return effect;
  } };
  driver.dependencies.serviceContext = async () => controls.contextAvailable
    ? { github: { identityId: identity.id, identityRevision: 1, target: gitHubTarget } } : {};
  let runtime = driver.restart();
  return { ...driver, runtime, controls, upstream,
    journal: createBotExecutionStore({ store: driver.store }),
    mutations: createMutationStore({ filePath: path.join(dataDir, 'source-control-mutations.json') }),
    async admit(origin = 'first') {
      const item = await runtime.admit('project', 'bugs', { source: { kind: 'manual', id: origin }, title: 'Controlled tool item' });
      await runtime.pump('project');
      const number = 17 + pulls.size;
      await driver.store.update('project', (snapshot) => ({ snapshot: { ...snapshot, items: snapshot.items.map((entry) => entry.id === item.id
        ? { ...entry, pr: { number, url: `https://github.com/acme/example/pull/${number}`, headSha: driver.controls.headSha, baseSha: driver.controls.baseSha } } : entry) } }));
      pulls.set(number, { number, node_id: `PR_${number}`, state: 'open',
        head: { sha: driver.controls.headSha, ref: `bot/${item.id}`, repo: { full_name: 'acme/example' } },
        base: { ref: 'main', repo: { full_name: 'acme/example' } } });
      return (await runtime.detail('project', item.id)).item;
    },
    tool: (item, operationId, body = 'Controlled comment', action = 'pr.comment') => runtime.handleTool({
      sessionId: item.sessions.fixing, action, input: { operationId, body },
    }),
    restart() { runtime = driver.restart(); return runtime; },
    close: () => upstream.close(),
  };
};
