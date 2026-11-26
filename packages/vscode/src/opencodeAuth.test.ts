import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { createOpenCodeTrust } from '../../web/server/lib/opencode-trust/index.js';
import { readOpenCodeUsageLimits } from '../../web/server/lib/opencode/auth.js';
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
    assert.deepEqual(await getProviderAuth('deepseek'), { label: 'default', type: 'api', key: 'ds' });
  });

  it('throws while OpenCode has no API URL instead of answering empty', async () => {
    configureOpenCodeCredentials(openCodeCredentialSource({ getApiUrl: () => null, getOpenCodeAuthHeaders: () => ({}), getManagedLaunchEnvironment: () => null, getWorkingDirectory: () => '' }));
    await assert.rejects(readOpenCodeCredentials(), /API URL is not available/);
  });

  it('blocks directory-scoped integration and usage-limits reads for untrusted workspaces without hiding stored credentials', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vscode-auth-trust-')));
    const repo = path.join(root, 'untrusted-repo');
    await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, 'evil.js'), 'export default {}');
    await writeFile(path.join(repo, 'opencode.json'), JSON.stringify({ plugins: ['./evil.js'] }));

    const trust = createOpenCodeTrust({
      storePath: path.join(root, 'trust.json'),
      homeDirectory: path.join(root, 'home'),
    });

    const requests: Array<{ path: string; directory: string | undefined }> = [];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const rawDir = req.headers['x-opencode-directory'];
      requests.push({
        path: url.pathname,
        directory: Array.isArray(rawDir) ? rawDir.join(',') : rawDir,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (url.pathname === '/api/credential') {
        res.end(JSON.stringify({
          data: [{ id: 'cred_1', integrationID: 'deepseek', label: 'default', active: true, value: { type: 'key', key: 'ds' } }],
        }));
        return;
      }
      if (url.pathname === '/api/integration') {
        res.end(JSON.stringify({
          data: [{ id: 'zai-coding-plan', connections: [{ type: 'env', name: 'ZHIPU_API_KEY' }] }],
        }));
        return;
      }
      if (url.pathname === '/api/experimental/usage/limits') {
        res.end(JSON.stringify({
          data: { workspace: { name: 'Team' }, budgets: [] },
        }));
        return;
      }
      res.end('{}');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address: AddressInfo | string | null = server.address();
    const port = address instanceof Object ? address.port : 0;

    try {
      configureOpenCodeCredentials(openCodeCredentialSource(
        {
          getApiUrl: () => `http://127.0.0.1:${port}`,
          getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic test' }),
          getManagedLaunchEnvironment: () => ({ ZHIPU_API_KEY: 'zk-env' }),
          getWorkingDirectory: () => repo,
        },
        trust,
      ));

      const untrustedCredentials = await readOpenCodeCredentials();
      assert.deepEqual(untrustedCredentials, {
        deepseek: { label: 'default', type: 'api', key: 'ds' },
      });
      assert.equal(await readOpenCodeUsageLimits(), null);
      assert.deepEqual(requests, [{ path: '/api/credential', directory: undefined }]);

      requests.length = 0;
      const { assessment } = await trust.assess(repo, { fresh: true });
      await trust.trust(repo, assessment.fingerprint);

      const trustedCredentials = await readOpenCodeCredentials();
      assert.deepEqual(trustedCredentials, {
        deepseek: { label: 'default', type: 'api', key: 'ds' },
        'zai-coding-plan': { type: 'api', key: 'zk-env' },
      });
      const limits = await readOpenCodeUsageLimits();
      assert.deepEqual(limits, { workspace: { name: 'Team' }, budgets: [] });

      const integrationReq = requests.find((entry) => entry.path === '/api/integration');
      const limitsReq = requests.find((entry) => entry.path === '/api/experimental/usage/limits');
      assert.equal(integrationReq?.directory, encodeURIComponent(repo));
      assert.equal(limitsReq?.directory, encodeURIComponent(repo));
    } finally {
      configureOpenCodeCredentials(null);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
