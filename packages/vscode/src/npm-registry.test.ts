import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNpmRegistryRequest } from './npm-registry';

const originalLowerRegistry = process.env.npm_config_registry;
const originalUpperRegistry = process.env.NPM_CONFIG_REGISTRY;

afterEach(() => {
  if (originalLowerRegistry === undefined) delete process.env.npm_config_registry;
  else process.env.npm_config_registry = originalLowerRegistry;
  if (originalUpperRegistry === undefined) delete process.env.NPM_CONFIG_REGISTRY;
  else process.env.NPM_CONFIG_REGISTRY = originalUpperRegistry;
});

describe('VS Code npm registry requests', () => {
  test('defaults to npm and encodes scoped names as one metadata path segment', () => {
    delete process.env.npm_config_registry;
    delete process.env.NPM_CONFIG_REGISTRY;
    assert.deepEqual(resolveNpmRegistryRequest('@scope/pkg'), {
      url: 'https://registry.npmjs.org/@scope%2Fpkg',
      headers: {},
    });
  });

  test('preserves base paths, trims slashes, and honors lowercase precedence', () => {
    process.env.npm_config_registry = 'https://lower.example.com/custom/npm///';
    process.env.NPM_CONFIG_REGISTRY = 'https://upper.example.com';
    assert.equal(resolveNpmRegistryRequest('pkg', 'latest').url, 'https://lower.example.com/custom/npm/pkg/latest');
  });

  test('moves credentials to authorization without exposing them in the URL', () => {
    delete process.env.npm_config_registry;
    process.env.NPM_CONFIG_REGISTRY = 'https://test-user:test-password@mirror.example.com/npm/';
    const request = resolveNpmRegistryRequest('@scope/pkg');

    assert.equal(request.url, 'https://mirror.example.com/npm/@scope%2Fpkg');
    assert.equal(request.url.includes('test-password'), false);
    assert.deepEqual(request.headers, {
      Authorization: `Basic ${Buffer.from('test-user:test-password').toString('base64')}`,
    });
  });
});
