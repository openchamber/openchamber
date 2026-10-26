import assert from 'node:assert/strict';
import test from 'node:test';

import { clearAppCache } from './app-cache.mjs';

const createWindow = (calls, name) => ({
  webContents: { reload: () => calls.push(`reload:${name}`) },
});

test('clears the HTTP cache, keeps site storage, then reloads every window', async () => {
  const calls = [];
  const session = {
    clearCache: async () => { calls.push('clearCache'); },
    clearStorageData: async () => { calls.push('clearStorageData'); },
  };

  await clearAppCache({ session, windows: [createWindow(calls, 'main'), createWindow(calls, 'mini')] });

  assert.deepEqual(calls, ['clearCache', 'reload:main', 'reload:mini']);
});

test('does not reload windows when clearing the cache fails', async () => {
  const calls = [];
  const session = {
    clearCache: async () => { throw new Error('cache busy'); },
  };

  await assert.rejects(clearAppCache({ session, windows: [createWindow(calls, 'main')] }), /cache busy/);
  assert.deepEqual(calls, []);
});
