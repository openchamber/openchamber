import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBotIdentityStore } from './identities.js';
import { createBotServices } from './services.js';
import { accountCredential, controlledUpstream, disconnectedPolicy, gitHubTarget, HEAD,
  pullResponse } from './services/http.test-support.js';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-services-driver-'));
let fail = false;
const upstream = await controlledUpstream((request) => {
  if (request.path === '/user') return { body: { id: 42, login: 'user-42' } };
  if (request.method === 'GET') return { body: pullResponse() };
  return fail ? { status: 503, body: { message: 'controlled failure' } } : { body: { id: 991 } };
});
try {
  const identities = createBotIdentityStore({ dataDir, readGitHubAccount: async (id, revision) =>
    id === 'account-one' && revision === 1 ? accountCredential() : null });
  const identity = await identities.create({ kind: 'github-account', label: 'Driver account', accountId: 'account-one', credentialRevision: 1 });
  const services = createBotServices({ identities, dataDir, fetchImpl: upstream.fetchImpl, policyOptions: disconnectedPolicy });
  const input = { number: 17, headSha: HEAD, body: 'Controlled module-driver comment' };
  const request = { operation: 'pr.comment', botId: 'driver-bot', itemId: 'driver-item', identityId: identity.id,
    identityRevision: identity.revision, target: gitHubTarget, input };
  const effect = await services.prepare({ ...request, key: 'success' });
  assert.equal((await services.execute(effect, input)).status, 'succeeded');
  assert.equal((await services.execute(effect, input)).replayed, true);
  fail = true;
  const failing = await services.prepare({ ...request, key: 'failure' });
  await assert.rejects(() => services.execute(failing, input), { state: 'outcome-unknown' });
  assert.deepEqual(await services.reconcile(failing, input), { state: 'outcome-unknown' });
  assert.equal(upstream.requests.filter((entry) => entry.method === 'POST').length, 2);
  assert.ok(upstream.origins.every((origin) => origin === 'https://api.github.com'));
  console.log(JSON.stringify({ success: 'succeeded', replay: true, failure: 'outcome-unknown', upstreamWrites: 2 }));
} finally {
  await upstream.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
