import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-vscode-antigravity-file-'));
const originalHome = process.env.HOME;
const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
process.env.HOME = scratchDir;
process.env.OPENCODE_CONFIG_DIR = scratchDir;
const accountsPath = path.join(scratchDir, 'antigravity-accounts.json');
const writeToken = (refreshToken: string) => {
  fs.writeFileSync(accountsPath, JSON.stringify({ accounts: [{ refreshToken }], activeIndex: 0 }));
};
writeToken('||');

const { fetchQuotaForProvider, listConfiguredQuotaProviders } = await import('./quotaProviders');
const { configureOpenCodeCredentials } = await import('./opencodeAuth');
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  configureOpenCodeCredentials(null);
});
after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

describe('VS Code Antigravity accounts-file fallback', () => {
  for (const [fileToken, expectedToken] of [['||', 'store-refresh'], ['file-refresh|file-project', 'file-refresh']]) {
    it(`uses ${expectedToken === 'store-refresh' ? 'the store for an unusable file token' : 'the usable file token first'}`, async () => {
      writeToken(fileToken);
      configureOpenCodeCredentials({
        list: async () => [{
          id: 'test-google', integrationID: 'google', label: 'default', active: true,
          value: { type: 'oauth', methodID: 'oauth', metadata: {}, access: 'old-access', refresh: 'store-refresh|store-project', expires: 1 },
        }],
      });
      const refreshTokens: Array<string | null> = [];
      globalThis.fetch = async (url, options) => {
        if (String(url) === 'https://oauth2.googleapis.com/token') {
          assert.ok(options?.body instanceof URLSearchParams);
          refreshTokens.push(options.body.get('refresh_token'));
          return Response.json({ access_token: 'test-access' });
        }
        if (String(url).endsWith(':retrieveUserQuotaSummary')) return Response.json({ groups: [] });
        return Response.json({ models: { 'gemini-test': { quotaInfo: { remainingFraction: 0.9 } } } });
      };

      assert.ok((await listConfiguredQuotaProviders()).includes('antigravity'));
      const result = await fetchQuotaForProvider('antigravity');
      assert.equal(result.ok, true);
      assert.equal(result.configured, true);
      assert.deepEqual(refreshTokens, [expectedToken]);
    });
  }
});
