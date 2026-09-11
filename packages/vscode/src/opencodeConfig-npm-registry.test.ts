import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { queryPluginRegistry } from './opencodeConfig';

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

test('plugin metadata uses a credential-safe scoped registry request', async () => {
  process.env.npm_config_registry = '';
  process.env.NPM_CONFIG_REGISTRY = 'https://test-user:test-password@mirror.example.com/custom/npm/';
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({
      'dist-tags': { latest: '1.2.3' },
      versions: { '1.2.3': {} },
    }));
  }) as typeof fetch;

  const response = await queryPluginRegistry(['@scope/credential-test']);

  assert.equal(response.results[0]?.kind, 'npm-ok');
  assert.equal(requestUrl, 'https://mirror.example.com/custom/npm/@scope%2Fcredential-test');
  assert.equal(requestUrl.includes('test-password'), false);
  assert.equal((requestInit?.headers as Record<string, string>).Authorization, `Basic ${Buffer.from('test-user:test-password').toString('base64')}`);
});
