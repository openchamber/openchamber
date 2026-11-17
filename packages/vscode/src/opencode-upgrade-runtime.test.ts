import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { getOpenCodeUpgradeStatus, setInfoProbeDeadlineForTest, upgradeManagedOpenCode, type OpenCodeUpgradeManager } from './opencode-upgrade-runtime';
import { OPENCODE_INFO_RESPONSE_MAX_BYTES } from './bounded-response-body';

const originalFetch = globalThis.fetch;
const originalLowerRegistry = process.env.npm_config_registry;
const originalRegistry = process.env.NPM_CONFIG_REGISTRY;
const originalUserConfig = process.env.npm_config_userconfig;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalLowerRegistry === undefined) delete process.env.npm_config_registry;
  else process.env.npm_config_registry = originalLowerRegistry;
  if (originalRegistry === undefined) delete process.env.NPM_CONFIG_REGISTRY;
  else process.env.NPM_CONFIG_REGISTRY = originalRegistry;
  if (originalUserConfig === undefined) delete process.env.npm_config_userconfig;
  else process.env.npm_config_userconfig = originalUserConfig;
});

// #2308 (twin of #1289): every test in this file must resolve the npm
// registry deterministically. Pin npm_config_userconfig to a missing
// file and clear any inherited registry override before each test, so
// the machine's ~/.npmrc (e.g. a registry mirror) can never leak into
// a test that did not pin it itself; tests 1-2 above override these
// values with their own pins. afterEach restores the originals.
beforeEach(() => {
  process.env.npm_config_userconfig = `${import.meta.dirname}/missing-test.npmrc`;
  delete process.env.npm_config_registry;
  delete process.env.NPM_CONFIG_REGISTRY;
});

const createManager = (mode: 'managed' | 'external' = 'managed'): OpenCodeUpgradeManager => ({
  getApiUrl: () => 'http://127.0.0.1:4096',
  getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic test' }),
  getDebugInfo: () => ({ mode, cliPath: '/test/opencode' }),
  upgradeCli: async () => {},
});

describe('VS Code OpenCode upgrades', () => {
  test('uses the configured registry and Basic headers for the v2 package version', async () => {
    process.env.npm_config_userconfig = `${import.meta.dirname}/missing-test.npmrc`;
    process.env.npm_config_registry = 'https://user:p%40ss@mirror.example.com/npm/';
    const fetch = mock.method(globalThis, 'fetch', async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = String(input);
      return Response.json({ version: url.endsWith('/api/info') ? '2.0.21' : '2.0.22' });
    });
    try {
      const status = await getOpenCodeUpgradeStatus(createManager());
      assert.equal(status.latestVersion, '2.0.22');
      const call = fetch.mock.calls.find((entry) => String(entry.arguments[0]).includes('mirror.example.com'));
      assert.equal(String(call?.arguments[0]), 'https://mirror.example.com/npm/@opencode%2Fcli/latest');
      assert.equal(new Headers(call?.arguments[1]?.headers).get('Authorization'), `Basic ${Buffer.from('user:p@ss').toString('base64')}`);
    } finally {
      fetch.mock.restore();
    }
  });

  test('reports invalid registry configuration without a public-registry fallback', async () => {
    process.env.npm_config_userconfig = `${import.meta.dirname}/missing-test.npmrc`;
    process.env.npm_config_registry = 'not-a-url';
    const fetch = mock.method(globalThis, 'fetch', async () => Response.json({ version: '2.0.21' }));
    try {
      const status = await getOpenCodeUpgradeStatus(createManager());
      assert.equal(status.available, null);
      assert.equal(status.error, 'Invalid npm registry URL');
      assert.equal(fetch.mock.calls.some((entry) => String(entry.arguments[0]).includes('registry.npmjs.org')), false);
    } finally {
      fetch.mock.restore();
    }
  });

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

  test('never claims an upgrade for a malformed version on either side', async () => {
    const manager = createManager();
    const statusFor = async (currentVersion: string, latestVersion: string) => {
      // SAFETY: the stub answers only the two routes getOpenCodeUpgradeStatus
      // fetches, with the same Response shapes the real endpoints return.
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.endsWith('/api/info')) return new Response(JSON.stringify({ version: currentVersion, pid: 1, urls: [], paths: { tmp: '/tmp' } }));
        return new Response(JSON.stringify({ version: latestVersion }));
      }) as typeof fetch;
      return getOpenCodeUpgradeStatus(manager);
    };

    // Trailing junk: parseInt('1junk') is 1, so this read as 2.1 > 2.0.9.
    assert.equal((await statusFor('2.0.9', '2.1junk')).available, false);
    // Empty part: parseInt('') fell back to 0, so the installed '2..1' read as 2.0.1 < 2.0.2.
    assert.equal((await statusFor('2..1', '2.0.2')).available, false);
    // Non-numeric part: read as 0, so '2.0.x' silently equalled a real 2.0.0.
    assert.equal((await statusFor('2.0.0', '2.0.x')).available, false);
    // Parseable versions still compare normally, prerelease included.
    assert.equal((await statusFor('2.0.1', '2.0.2')).available, true);
    assert.equal((await statusFor('2.0.2', '2.0.2-beta.1')).available, false);
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

describe('VS Code OpenCode upgrade status probe deadline (#789)', () => {
  test('settles as unavailable when /api/info never answers', async () => {
    setInfoProbeDeadlineForTest(50);
    // SAFETY: the stub answers the registry route at once and stalls only the
    // local /api/info probe, rejecting when its signal aborts.
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).endsWith('/api/info')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
      return Response.json({ version: '2.0.22' });
    }) as typeof fetch;
    try {
      const started = Date.now();
      const status = await getOpenCodeUpgradeStatus(createManager());
      assert.ok(Date.now() - started < 5_000, 'status must settle near the deadline, not hang');
      assert.equal(status.available, null);
      assert.ok(String(status.error ?? '').length > 0);
    } finally {
      setInfoProbeDeadlineForTest();
    }
  });
});

describe('VS Code OpenCode upgrade status registry body cap (#1051)', () => {
  const streamBody = (totalBytes: number, state: { pulledBytes: number; cancelled: boolean }) => new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulledBytes >= totalBytes) { controller.close(); return; }
      const size = Math.min(64 * 1024, totalBytes - state.pulledBytes);
      controller.enqueue(new Uint8Array(size).fill(0x20));
      state.pulledBytes += size;
    },
    cancel() { state.cancelled = true; },
  });

  test('fails as an error instead of buffering a streamed registry body over the 1 MiB cap', async () => {
    const state = { pulledBytes: 0, cancelled: false };
    // SAFETY: the stub answers /api/info at once and streams only the
    // registry route, with no content-length, like a chunked packument.
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/api/info')) return Response.json({ version: '2.0.1', pid: 1, urls: [], paths: { tmp: '/tmp' } });
      return new Response(streamBody(2 * 1024 * 1024, state), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const status = await getOpenCodeUpgradeStatus(createManager());
    assert.equal(status.available, null);
    assert.match(String(status.error ?? ''), /exceeds 1048576 bytes/);
    assert.equal(state.cancelled, true);
    assert.ok(state.pulledBytes < 2 * 1024 * 1024, 'stream must be cancelled, not drained');
  });

  test('accepts a registry body at exactly the 1 MiB cap', async () => {
    const prefix = JSON.stringify({ version: '2.0.23' });
    const body = prefix + ' '.repeat(1024 * 1024 - prefix.length);
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/api/info')) return Response.json({ version: '2.0.1', pid: 1, urls: [], paths: { tmp: '/tmp' } });
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const status = await getOpenCodeUpgradeStatus(createManager());
    assert.equal(status.latestVersion, '2.0.23');
    assert.equal(status.available, true);
  });

  test('accepts a registry body with a leading UTF-8 BOM, as response.json() did', async () => {
    const body = '\uFEFF' + JSON.stringify({ version: '2.0.23' });
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/api/info')) return Response.json({ version: '2.0.1', pid: 1, urls: [], paths: { tmp: '/tmp' } });
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const status = await getOpenCodeUpgradeStatus(createManager());
    assert.equal(status.latestVersion, '2.0.23');
    assert.equal(status.available, true);
  });
});

describe('VS Code OpenCode upgrade status /api/info body cap', () => {
  const streamBody = (totalBytes: number, state: { pulledBytes: number; cancelled: boolean }) => new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulledBytes >= totalBytes) { controller.close(); return; }
      const size = Math.min(64 * 1024, totalBytes - state.pulledBytes);
      controller.enqueue(new Uint8Array(size).fill(0x20));
      state.pulledBytes += size;
    },
    cancel() { state.cancelled = true; },
  });

  test('returns an unavailable error instead of draining an oversized /api/info response', async () => {
    const state = { pulledBytes: 0, cancelled: false };
    globalThis.fetch = async (input: Parameters<typeof fetch>[0]) => String(input).endsWith('/api/info')
      ? new Response(streamBody(2 * OPENCODE_INFO_RESPONSE_MAX_BYTES, state), { headers: { 'content-type': 'application/json' } })
      : Response.json({ version: '2.0.32' });

    const status = await getOpenCodeUpgradeStatus(createManager());

    assert.equal(status.available, null);
    assert.match(String(status.error ?? ''), /exceeded the 1 MiB limit/);
    assert.equal(state.cancelled, true);
    assert.ok(state.pulledBytes < 2 * OPENCODE_INFO_RESPONSE_MAX_BYTES);
  });

  test('accepts /api/info at exactly 1 MiB', async () => {
    const prefix = JSON.stringify({ version: '2.0.1' });
    const body = prefix + ' '.repeat(OPENCODE_INFO_RESPONSE_MAX_BYTES - Buffer.byteLength(prefix));
    globalThis.fetch = async (input: Parameters<typeof fetch>[0]) => String(input).endsWith('/api/info')
      ? new Response(body)
      : Response.json({ version: '2.0.2' });

    const status = await getOpenCodeUpgradeStatus(createManager());

    assert.equal(status.currentVersion, '2.0.1');
    assert.equal(status.available, true);
  });
});
