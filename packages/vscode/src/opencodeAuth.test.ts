import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { configureOpenCodeCredentials, getProviderAuth, openCodeCredentialSource, readOpenCodeCredentials } from './opencodeAuth';

// The reader and its projection are the web server's and tested there
// (`packages/web/server/lib/opencode/auth.test.js`); this covers the
// extension-host connection.
describe('VS Code credential source', () => {
  afterEach(() => configureOpenCodeCredentials(null));

  it('reads through the shared reader once wired', async () => {
    configureOpenCodeCredentials({
      list: async () => [{ id: 'cred_1', integrationID: 'deepseek', label: 'default', active: true, value: { type: 'key', key: 'ds' } }],
    });
    assert.deepEqual(await getProviderAuth('deepseek'), { type: 'api', key: 'ds' });
  });

  it('throws while OpenCode has no API URL instead of answering empty', async () => {
    configureOpenCodeCredentials(openCodeCredentialSource({ getApiUrl: () => null, getOpenCodeAuthHeaders: () => ({}), getManagedLaunchEnvironment: () => null }));
    await assert.rejects(readOpenCodeCredentials(), /API URL is not available/);
  });
});
