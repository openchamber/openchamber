import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getOpenCodeUpgradeStatus, upgradeManagedOpenCode, type OpenCodeUpgradeManager } from './opencode-upgrade-runtime';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const createManager = (mode: 'managed' | 'external' = 'managed'): OpenCodeUpgradeManager => ({
  getApiUrl: () => 'http://127.0.0.1:4096',
  getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic test' }),
  getDebugInfo: () => ({ mode, cliPath: '/test/opencode' }),
  upgradeCli: async () => {},
});

describe('VS Code OpenCode upgrades', () => {
  test('reports installed and latest versions from the v2 info route', async () => {
    const manager = createManager();
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/api/info')) return new Response(JSON.stringify({ version: '2.0.1', pid: 1, urls: [], paths: { tmp: '/tmp' } }));
      if (url.includes('registry.npmjs.org')) return new Response(JSON.stringify({ version: '2.0.2' }));
      return new Response(JSON.stringify({ tag_name: 'v2.0.2' }));
    }) as typeof fetch;

    assert.deepEqual(await getOpenCodeUpgradeStatus(manager), {
      available: true,
      currentVersion: '2.0.1',
      latestVersion: '2.0.2',
      upgrade: { supported: true, manager: 'opencode', reason: null },
    });
  });

  test('still reports the running version for an externally managed OpenCode', async () => {
    const manager = createManager('external');
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/api/info')) return new Response(JSON.stringify({ version: '2.0.2', pid: 1, urls: [], paths: { tmp: '/tmp' } }));
      return new Response(JSON.stringify({ version: '2.0.2' }));
    }) as typeof fetch;

    const status = await getOpenCodeUpgradeStatus(manager);
    assert.equal(status.currentVersion, '2.0.2');
    assert.deepEqual(status.upgrade, { supported: false, manager: 'external', reason: 'external' });
  });

  test('rejects external upgrades without contacting OpenCode', async () => {
    const manager = createManager('external');
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response('{}');
    }) as typeof fetch;

    const result = await upgradeManagedOpenCode(manager);
    assert.equal(result.status, 409);
    if (result.status !== 409) assert.fail('Expected unsupported response');
    assert.equal(result.body.code, 'OPENCODE_UPGRADE_UNSUPPORTED');
    assert.equal(fetchCount, 0);
  });
  test('shares concurrent upgrades and permits a new attempt after failure', async () => {
    const manager = createManager();
    let calls = 0;
    let rejectUpgrade: (error: Error) => void = () => { throw new Error('Upgrade not started'); };
    manager.upgradeCli = () => {
      calls += 1;
      return new Promise<void>((_resolve, reject) => { rejectUpgrade = reject; });
    };
    const first = upgradeManagedOpenCode(manager);
    const second = upgradeManagedOpenCode(manager);
    assert.equal(calls, 1);
    rejectUpgrade(new Error('Installation failed'));
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map((result) => result.status), [500, 500]);
    manager.upgradeCli = async () => { calls += 1; };
    assert.deepEqual(await upgradeManagedOpenCode(manager), { status: 200, body: { success: true } });
    assert.equal(calls, 2);
  });

  test('rejects a missing CLI or manager before executing anything', async () => {
    const manager = createManager();
    manager.getDebugInfo = () => ({ mode: 'managed', cliPath: null });
    manager.upgradeCli = async () => { assert.fail('Must not run'); };
    assert.equal((await upgradeManagedOpenCode(manager)).status, 409);
    assert.equal((await upgradeManagedOpenCode()).status, 409);
  });

});
