import assert from 'node:assert/strict';
import test from 'node:test';

import { runPackagedWorkspaceSmoke } from './packaged-workspace-smoke.mjs';

const image = `ghcr.io/openchamber/opencode-workspace@sha256:${'a'.repeat(64)}`;
const gateway = `ghcr.io/openchamber/workspace-egress-gateway@sha256:${'b'.repeat(64)}`;

test('configures, starts, and cleans a packaged Docker workspace without exposing credentials', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url: String(url), init, body });
    if (String(url).endsWith('/auth/reauth')) return Response.json({ proof: 'proof', nonce: body.nonce });
    if (String(url).endsWith('/api/workspaces/settings')) return Response.json({ configured: true });
    if (String(url).endsWith('/api/workspaces/sessions/start')) return Response.json({ status: 'completed', workspaceID: 'workspace-1', sessionID: 'session-1' }, { status: 201 });
    if (String(url).endsWith('/api/workspaces/workspace-1')) return Response.json({ cleaned: true, remainingResources: [] });
    return Response.json({ error: 'unexpected route' }, { status: 404 });
  };

  const result = await runPackagedWorkspaceSmoke({
    baseUrl: 'http://127.0.0.1:2606', clientToken: 'client-secret', password: 'step-up-secret', directory: '/tmp/project', runtimeImage: image, gatewayImage: gateway, fetchImpl,
  });
  assert.deepEqual(result, { workspaceID: 'workspace-1', sessionID: 'session-1' });
  assert.equal(requests.filter((request) => request.url.endsWith('/auth/reauth')).length, 3);
  assert.ok(requests.every((request) => request.init.headers.Authorization === 'Bearer client-secret'));
  assert.equal(requests.at(-1).init.method, 'DELETE');
});

test('fails if provider cleanup leaves resources behind', async () => {
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (String(url).endsWith('/auth/reauth')) return Response.json({ proof: 'proof', nonce: body.nonce });
    if (String(url).endsWith('/api/workspaces/settings')) return Response.json({ configured: true });
    if (String(url).endsWith('/api/workspaces/sessions/start')) return Response.json({ status: 'completed', workspaceID: 'workspace-1', sessionID: 'session-1' }, { status: 201 });
    return Response.json({ cleaned: false, remainingResources: ['volume'] }, { status: 409 });
  };
  await assert.rejects(runPackagedWorkspaceSmoke({
    baseUrl: 'http://127.0.0.1:2606', clientToken: 'client-secret', password: 'step-up-secret', directory: '/tmp/project', runtimeImage: image, gatewayImage: gateway, fetchImpl,
  }), /cleanup failed/);
});
