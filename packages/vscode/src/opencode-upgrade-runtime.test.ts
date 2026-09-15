import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getOpenCodeUpgradeStatus, upgradeManagedOpenCode, type OpenCodeUpgradeManager } from './opencode-upgrade-runtime';

const originalFetch = globalThis.fetch;
const originalLowerRegistry = process.env.npm_config_registry;
const originalRegistry = process.env.NPM_CONFIG_REGISTRY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalLowerRegistry === undefined) delete process.env.npm_config_registry;
  else process.env.npm_config_registry = originalLowerRegistry;
  if (originalRegistry === undefined) delete process.env.NPM_CONFIG_REGISTRY;
  else process.env.NPM_CONFIG_REGISTRY = originalRegistry;
});

const createManager = (mode: 'managed' | 'external' = 'managed') => {
  let restartCount = 0;
  const manager: OpenCodeUpgradeManager = {
    getApiUrl: () => 'http://127.0.0.1:4096',
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic test' }),
    getDebugInfo: () => ({ mode }),
    restart: async () => { restartCount += 1; },
  };
  return { manager, getRestartCount: () => restartCount };
};

describe('VS Code OpenCode upgrades', () => {
  test('reports an available update for a managed OpenCode process', async () => {
    const { manager } = createManager();
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/global/health')) return new Response(JSON.stringify({ version: '1.18.8' }));
      if (url.includes('registry.npmjs.org')) return new Response(JSON.stringify({ version: '1.18.9' }));
      return new Response(JSON.stringify({ tag_name: 'v1.18.9' }));
    }) as typeof fetch;

    assert.deepEqual(await getOpenCodeUpgradeStatus(manager), {
      available: true,
      currentVersion: '1.18.8',
      latestVersion: '1.18.9',
      upgrade: { supported: true, manager: 'opencode', reason: null },
    });
  });

  test('uses authenticated registry metadata without exposing credentials', async () => {
    const { manager } = createManager();
    process.env.npm_config_registry = '';
    process.env.NPM_CONFIG_REGISTRY = 'https://test-user:test-password@mirror.example.com/npm/';
    const calls: Array<[string, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      calls.push([url, init]);
      if (url.endsWith('/global/health')) return new Response(JSON.stringify({ version: '1.18.8' }));
      if (url.includes('mirror.example.com')) return new Response(JSON.stringify({ version: '1.18.9' }));
      return new Response(JSON.stringify({ tag_name: 'v1.18.9' }));
    }) as typeof fetch;

    await getOpenCodeUpgradeStatus(manager);
    const npmCall = calls.find(([url]) => url.includes('mirror.example.com'));

    assert.equal(npmCall?.[0], 'https://mirror.example.com/npm/opencode-ai/latest');
    assert.equal(npmCall?.[0].includes('test-password'), false);
    assert.equal((npmCall?.[1]?.headers as Record<string, string>).Authorization, `Basic ${Buffer.from('test-user:test-password').toString('base64')}`);
  });

  test('falls back to GitHub when the configured registry URL is invalid', async () => {
    const { manager } = createManager();
    process.env.npm_config_registry = '';
    process.env.NPM_CONFIG_REGISTRY = 'not-a-url';
    const calls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/global/health')) return new Response(JSON.stringify({ version: '1.18.8' }));
      return new Response(JSON.stringify({ tag_name: 'v1.18.9' }));
    }) as typeof fetch;

    assert.deepEqual(await getOpenCodeUpgradeStatus(manager), {
      available: true,
      currentVersion: '1.18.8',
      latestVersion: '1.18.9',
      upgrade: { supported: true, manager: 'opencode', reason: null },
    });
    assert.equal(calls.includes('https://api.github.com/repos/anomalyco/opencode/releases/latest'), true);
  });

  test('fails closed for externally managed OpenCode without contacting the updater', async () => {
    const { manager } = createManager('external');
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response('{}');
    }) as typeof fetch;

    assert.deepEqual(await upgradeManagedOpenCode(manager), {
      status: 409,
      body: {
        success: false,
        code: 'OPENCODE_UPGRADE_UNSUPPORTED',
        error: 'This OpenCode runtime cannot be upgraded by OpenChamber.',
      },
    });
    assert.equal(fetchCount, 0);
  });

  test('upgrades then restarts the extension-owned OpenCode process', async () => {
    const { manager, getRestartCount } = createManager();
    let request: RequestInit | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      assert.equal(String(input), 'http://127.0.0.1:4096/global/upgrade');
      request = init;
      return new Response(JSON.stringify({ success: true, version: '1.18.9' }));
    }) as typeof fetch;

    assert.deepEqual(await upgradeManagedOpenCode(manager, '1.18.9'), {
      status: 200,
      body: { success: true, version: '1.18.9', restarted: true },
    });
    assert.equal(getRestartCount(), 1);
    assert.equal(request?.method, 'POST');
    assert.deepEqual(JSON.parse(String(request?.body)), { target: '1.18.9' });
    assert.equal((request?.headers as Record<string, string>).Authorization, 'Basic test');
  });

  test('names the latest release when the caller sends no target', async () => {
    const { manager } = createManager();
    let upgradeBody: unknown;
    // SAFETY: the stub answers the only two call shapes this test exercises —
    // a URL string and an init bag — which is all `fetch` is used with here.
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.includes('registry.npmjs.org')) return new Response(JSON.stringify({ version: '1.18.23' }));
      if (url.includes('api.github.com')) return new Response(JSON.stringify({ tag_name: 'v1.18.23' }));
      upgradeBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ success: true, version: '1.18.23' }));
    }) as typeof fetch;

    assert.equal((await upgradeManagedOpenCode(manager)).status, 200);
    assert.deepEqual(upgradeBody, { target: '1.18.23' });
  });

  test('fails without calling the updater when the latest release cannot be resolved', async () => {
    const { manager, getRestartCount } = createManager();
    // SAFETY: the stub answers the only call shape this test exercises — a URL
    // string — and fails loudly if the updater is reached at all.
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith('/global/upgrade')) throw new Error('the updater must not be called without a target');
      return new Response('nope', { status: 503 });
    }) as typeof fetch;

    const result = await upgradeManagedOpenCode(manager);
    assert.equal(result.status, 502);
    assert.equal(result.body.code, 'OPENCODE_UPGRADE_TARGET_UNRESOLVED');
    assert.equal(getRestartCount(), 0);
  });

  test('surfaces the rejection OpenCode reported instead of the bare HTTP status', async () => {
    const { manager } = createManager();
    // SAFETY: the stub ignores its arguments and answers every call with the
    // rejection shape under test, so no call signature is misrepresented.
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ name: 'BadRequest', data: { message: 'Expected a semantic version', kind: 'Payload' } }),
      { status: 400 },
    )) as typeof fetch;

    assert.deepEqual(await upgradeManagedOpenCode(manager, '1.18.9'), {
      status: 400,
      body: { success: false, error: 'Expected a semantic version' },
    });
  });

  test('serializes concurrent managed upgrades', async () => {
    const { manager } = createManager();
    let release: (response: Response) => void = () => {};
    let upgradeCalled: () => void = () => {};
    const upgradeReached = new Promise<void>((resolve) => { upgradeCalled = resolve; });
    globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
      if (!String(input).endsWith('/global/upgrade')) {
        return Promise.resolve(new Response(JSON.stringify({ version: '1.18.9' })));
      }
      upgradeCalled();
      return new Promise<Response>((resolve) => { release = resolve; });
    }) as typeof fetch;

    const first = upgradeManagedOpenCode(manager);
    const second = await upgradeManagedOpenCode(manager);
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'OPENCODE_UPGRADE_IN_PROGRESS');

    await upgradeReached;
    release(new Response(JSON.stringify({ success: true })));
    assert.equal((await first).status, 200);
  });
});
