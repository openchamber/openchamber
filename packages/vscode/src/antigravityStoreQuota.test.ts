import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// No antigravity-accounts.json in either scratch dir: every sign-in below
// lives only in OpenCode's credential store, which is the shape current
// opencode-antigravity-auth versions produce. The providers read TWO
// accounts-file paths — the config-dir file and the data-dir file
// (~/.local/share/opencode) — and both resolve from the environment when
// the module loads, so OPENCODE_CONFIG_DIR and XDG_DATA_HOME both point at
// scratch directories before the import; redirecting the config dir alone
// would let a developer's real accounts file silently supply the
// credential these tests attribute to the store (#1114).
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-vscode-antigravity-store-'));
const dataHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-vscode-antigravity-data-'));
const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
const originalDataHome = process.env.XDG_DATA_HOME;
process.env.OPENCODE_CONFIG_DIR = configDir;
process.env.XDG_DATA_HOME = dataHomeDir;

const restoreEnv = (name: string, original: string | undefined) => {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
};

const { fetchQuotaForProvider, listConfiguredQuotaProviders } = await import('./quotaProviders');
const { configureOpenCodeCredentials } = await import('./opencodeAuth');

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  configureOpenCodeCredentials(null);
});

after(() => {
  restoreEnv('OPENCODE_CONFIG_DIR', originalConfigDir);
  restoreEnv('XDG_DATA_HOME', originalDataHome);
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(dataHomeDir, { recursive: true, force: true });
});

const configureStoreOAuth = (refresh: string) => {
  configureOpenCodeCredentials({
    list: async () => [{
      id: 'test-google',
      integrationID: 'google',
      label: 'default',
      active: true,
      value: { type: 'oauth', methodID: 'oauth', metadata: {}, access: 'old-access', refresh, expires: 1 },
    }],
  });
};

const configureStoreApiKey = (key: string) => {
  configureOpenCodeCredentials({
    list: async () => [{
      id: 'test-google',
      integrationID: 'google',
      label: 'default',
      active: true,
      value: { type: 'key', key },
    }],
  });
};

describe('VS Code Antigravity quota from the credential store', () => {
  it('reads a store-only OAuth sign-in as configured and fetches its quota', async () => {
    configureStoreOAuth('store-refresh|store-project|managed-project');

    const configured = await listConfiguredQuotaProviders();
    assert.ok(configured.includes('antigravity'));

    const refreshTokens: Array<string | null> = [];
    globalThis.fetch = async (url, options) => {
      if (String(url) === 'https://oauth2.googleapis.com/token') {
        assert.ok(options?.body instanceof URLSearchParams);
        refreshTokens.push(options.body.get('refresh_token'));
        return Response.json({ access_token: 'store-access' });
      }
      assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer store-access');
      if (String(url).endsWith(':retrieveUserQuotaSummary')) {
        return Response.json({ groups: [] });
      }
      return Response.json({
        models: {
          'gemini-store': { quotaInfo: { remainingFraction: 0.9, resetTime: '2026-10-25T10:00:00Z' } },
        },
      });
    };

    const result = await fetchQuotaForProvider('antigravity');

    assert.equal(result.ok, true);
    assert.equal(result.configured, true);
    assert.deepEqual(refreshTokens, ['store-refresh']);
    assert.equal(result.usage?.models?.['gemini-store']?.windows['5h']?.remainingPercent, 90);
    assert.ok(!JSON.stringify(result).includes('store-refresh'));
    assert.ok(!JSON.stringify(result).includes('store-access'));
  });

  it('reports a credential-store read failure as a refresh error, not as Not configured', async () => {
    configureOpenCodeCredentials({
      list: async () => {
        throw new Error('credential store unavailable');
      },
    });

    const result = await fetchQuotaForProvider('antigravity');

    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.equal(result.error, 'Failed to read OpenCode credentials');
  });

  it('reports a store login the Antigravity client confirms is not its own as Not configured', async () => {
    configureStoreOAuth('gemini-refresh|gemini-project');

    globalThis.fetch = async (url) => {
      if (String(url) === 'https://oauth2.googleapis.com/token') {
        return Response.json({ error: 'unauthorized_client' }, { status: 400 });
      }
      throw new Error('no quota call expected for a foreign login');
    };

    const result = await fetchQuotaForProvider('antigravity');

    assert.equal(result.ok, false);
    assert.equal(result.configured, false);
    assert.equal(result.error, 'Not configured');
  });

  it('does not treat a google API-key entry as an Antigravity login', async () => {
    configureStoreApiKey('api-key-value');

    const configured = await listConfiguredQuotaProviders();
    assert.ok(!configured.includes('antigravity'));

    globalThis.fetch = async () => {
      throw new Error('no network call expected without a login');
    };

    const result = await fetchQuotaForProvider('antigravity');

    assert.equal(result.ok, false);
    assert.equal(result.configured, false);
    assert.equal(result.error, 'Not configured');
  });
});
