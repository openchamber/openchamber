import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { queryPluginRegistry } from './opencodeConfig';

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
