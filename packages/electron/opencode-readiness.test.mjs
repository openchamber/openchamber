import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canReuseManagedOpenCodePreflight } from './opencode-readiness.mjs';

test('only the embedded managed preflight can replace a compatibility probe', async () => {
  const localOrigin = 'http://127.0.0.1:3901';
  let ready = true;
  const server = { getManagedOpenCodePreflight: async () => ready };
  const snapshot = { apiBaseUrl: localOrigin, localOrigin, server };
  assert.equal(await canReuseManagedOpenCodePreflight(snapshot), true);
  for (const apiBaseUrl of ['https://remote.example', 'http://127.0.0.1:3902', `${localOrigin}/proxy`, '', undefined]) {
    assert.equal(await canReuseManagedOpenCodePreflight({ ...snapshot, apiBaseUrl }), false);
  }
  assert.equal(await canReuseManagedOpenCodePreflight({ ...snapshot, server: null }), false);
  ready = false;
  assert.equal(await canReuseManagedOpenCodePreflight(snapshot), false);

});
