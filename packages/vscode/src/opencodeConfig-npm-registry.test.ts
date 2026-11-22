import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { clearNpmInfoCacheForTests, queryPluginRegistry } from './opencodeConfig';

const NPM_PACKUMENT_MAX_BYTES = 16 * 1024 * 1024;

const originalRegistry = process.env.npm_config_registry;
const originalUserConfig = process.env.npm_config_userconfig;

afterEach(() => {
  if (originalRegistry === undefined) delete process.env.npm_config_registry;
  else process.env.npm_config_registry = originalRegistry;
  if (originalUserConfig === undefined) delete process.env.npm_config_userconfig;
  else process.env.npm_config_userconfig = originalUserConfig;
});

test('plugin metadata uses the shared resolver with credential-safe URLs', async () => {
  process.env.npm_config_userconfig = `${import.meta.dirname}/missing-test.npmrc`;
  process.env.npm_config_registry = 'https://user:p%40ss@mirror.example.com/custom/npm/';
  const fetch = mock.method(globalThis, 'fetch', async () => Response.json({
    'dist-tags': { latest: '1.2.3' }, versions: { '1.2.3': {} },
  }));
  try {
    const response = await queryPluginRegistry(['@scope/credential-test']);
    assert.equal(response.results[0]?.kind, 'npm-ok');
    const [url, init] = fetch.mock.calls[0].arguments;
    assert.equal(String(url), 'https://mirror.example.com/custom/npm/@scope%2Fcredential-test');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Basic ${Buffer.from('user:p@ss').toString('base64')}`);
  } finally {
    fetch.mock.restore();
  }
});

test('npm packument lookup cancels oversized streamed responses at the byte cap', async () => {
  process.env.npm_config_userconfig = `${import.meta.dirname}/missing-test.npmrc`;
  delete process.env.npm_config_registry;
  const megabyte = 1024 * 1024;
  const totalBytes = 64 * megabyte;
  const chunk = Buffer.alloc(megabyte, 0x20);
  let streamedBytes = 0;
  let cancelled = false;
  const fetch = mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (streamedBytes >= totalBytes) {
        controller.close();
        return;
      }
      const next = chunk.subarray(0, Math.min(chunk.byteLength, totalBytes - streamedBytes));
      streamedBytes += next.byteLength;
      controller.enqueue(next);
    },
    cancel() {
      cancelled = true;
    },
  }), { headers: { 'content-type': 'application/json' } }));
  try {
    const response = await queryPluginRegistry(['oversized-streamed-packument']);
    assert.deepEqual(response.results[0], {
      kind: 'npm-network',
      spec: 'oversized-streamed-packument',
      error: 'Registry response exceeded size limit',
    });
    assert.ok(streamedBytes > NPM_PACKUMENT_MAX_BYTES);
    assert.ok(streamedBytes < totalBytes);
    assert.equal(cancelled, true);
  } finally {
    fetch.mock.restore();
  }
});

test('npm packument lookup accepts a response exactly at the byte cap', async () => {
  process.env.npm_config_userconfig = `${import.meta.dirname}/missing-test.npmrc`;
  delete process.env.npm_config_registry;
  const packument = JSON.stringify({ 'dist-tags': { latest: '1.2.3' }, versions: { '1.2.3': {} } });
  const body = `${packument}${' '.repeat(NPM_PACKUMENT_MAX_BYTES - Buffer.byteLength(packument))}`;
  assert.equal(Buffer.byteLength(body), NPM_PACKUMENT_MAX_BYTES);
  const fetch = mock.method(globalThis, 'fetch', async () => new Response(body, {
    headers: { 'content-type': 'application/json' },
  }));
  try {
    const response = await queryPluginRegistry(['at-cap-packument@1.2.3']);
    assert.deepEqual(response.results[0], {
      kind: 'npm-ok',
      spec: 'at-cap-packument@1.2.3',
      name: 'at-cap-packument',
      currentVersion: '1.2.3',
      latestVersion: '1.2.3',
      versions: ['1.2.3'],
      hasUpdate: false,
    });
  } finally {
    fetch.mock.restore();
  }
});

test('npm packument lookup keeps the 404 result unchanged', async () => {
  process.env.npm_config_userconfig = `${import.meta.dirname}/missing-test.npmrc`;
  delete process.env.npm_config_registry;
  const fetch = mock.method(globalThis, 'fetch', async () => new Response(null, { status: 404 }));
  try {
    const response = await queryPluginRegistry(['missing-packument']);
    assert.deepEqual(response.results[0], {
      kind: 'npm-missing-package',
      spec: 'missing-packument',
      name: 'missing-packument',
      error: 'Package not found',
    });
  } finally {
    fetch.mock.restore();
  }
});

const originalDateNow = Date.now;

afterEach(() => {
  Date.now = originalDateNow;
  clearNpmInfoCacheForTests();
});

const stubFetch = () =>
  mock.method(globalThis, 'fetch', async () =>
    Response.json({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } }));

test('npm info cache sweeps expired entries for other names on access', async () => {
  process.env.npm_config_userconfig = `${import.meta.dirname}/missing-test.npmrc`;
  delete process.env.npm_config_registry;
  let now = 1_000_000;
  Date.now = () => now;
  const fetch = stubFetch();
  try {
    await queryPluginRegistry(['sweep-alpha']);
    now += 3_600_001;
    await queryPluginRegistry(['sweep-beta']);
    assert.equal(fetch.mock.callCount(), 2);
    now = 1_001_000;
    await queryPluginRegistry(['sweep-alpha']);
    assert.equal(fetch.mock.callCount(), 3);
  } finally {
    fetch.mock.restore();
  }
});

test('npm info cache is capped, evicting the oldest entries', async () => {
  process.env.npm_config_userconfig = `${import.meta.dirname}/missing-test.npmrc`;
  delete process.env.npm_config_registry;
  const fetch = stubFetch();
  try {
    const names = Array.from({ length: 501 }, (_, i) => `cap-eviction-${i}`);
    for (let i = 0; i < names.length; i += 100) {
      await queryPluginRegistry(names.slice(i, i + 100));
    }
    assert.equal(fetch.mock.callCount(), 501);
    await queryPluginRegistry(['cap-eviction-500']);
    assert.equal(fetch.mock.callCount(), 501);
    await queryPluginRegistry(['cap-eviction-0']);
    assert.equal(fetch.mock.callCount(), 502);
  } finally {
    fetch.mock.restore();
  }
});
