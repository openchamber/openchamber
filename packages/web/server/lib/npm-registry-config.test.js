import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveNpmRegistryRequest } from './npm-registry-config.js';

describe('resolveNpmRegistryRequest', () => {
  let savedLower;
  let savedUpper;

  beforeEach(() => {
    savedLower = process.env.npm_config_registry;
    savedUpper = process.env.NPM_CONFIG_REGISTRY;
    delete process.env.npm_config_registry;
    delete process.env.NPM_CONFIG_REGISTRY;
  });

  afterEach(() => {
    if (savedLower === undefined) delete process.env.npm_config_registry;
    else process.env.npm_config_registry = savedLower;
    if (savedUpper === undefined) delete process.env.NPM_CONFIG_REGISTRY;
    else process.env.NPM_CONFIG_REGISTRY = savedUpper;
  });

  it('defaults to the public npm registry when nothing is configured', () => {
    expect(resolveNpmRegistryRequest('pkg')).toEqual({
      url: 'https://registry.npmjs.org/pkg',
      headers: {},
    });
  });

  it('preserves base paths and trims trailing slashes', () => {
    process.env.NPM_CONFIG_REGISTRY = 'https://mirror.example.com/custom/npm///';
    expect(resolveNpmRegistryRequest('pkg', 'latest').url).toBe('https://mirror.example.com/custom/npm/pkg/latest');
  });

  it('prefers npm_config_registry over NPM_CONFIG_REGISTRY', () => {
    process.env.npm_config_registry = 'https://lower.example.com';
    process.env.NPM_CONFIG_REGISTRY = 'https://upper.example.com';
    expect(resolveNpmRegistryRequest('pkg').url).toBe('https://lower.example.com/pkg');
  });

  it('uses the uppercase value when the lowercase value is blank', () => {
    process.env.npm_config_registry = '   ';
    process.env.NPM_CONFIG_REGISTRY = 'https://upper.example.com/npm';
    expect(resolveNpmRegistryRequest('pkg').url).toBe('https://upper.example.com/npm/pkg');
  });

  it('falls back to the default for a blank configured value', () => {
    process.env.NPM_CONFIG_REGISTRY = '   ';
    expect(resolveNpmRegistryRequest('pkg').url).toBe('https://registry.npmjs.org/pkg');
  });

  it('encodes scoped names as one metadata path segment', () => {
    process.env.NPM_CONFIG_REGISTRY = 'https://mirror.example.com/npm/';
    expect(resolveNpmRegistryRequest('@scope/pkg').url).toBe('https://mirror.example.com/npm/@scope%2Fpkg');
  });

  it('moves URL credentials to authorization without exposing them in the request URL', () => {
    process.env.NPM_CONFIG_REGISTRY = 'https://test-user:test-password@mirror.example.com/npm/';

    const request = resolveNpmRegistryRequest('@scope/pkg');

    expect(request.url).toBe('https://mirror.example.com/npm/@scope%2Fpkg');
    expect(request.url).not.toContain('test-user');
    expect(request.url).not.toContain('test-password');
    expect(request.headers).toEqual({
      Authorization: `Basic ${Buffer.from('test-user:test-password').toString('base64')}`,
    });
  });

  it('rejects invalid registry URLs without including their value in the error', () => {
    process.env.NPM_CONFIG_REGISTRY = 'not-a-url-test-password';

    expect(() => resolveNpmRegistryRequest('pkg')).toThrow('Invalid npm registry URL');
    try {
      resolveNpmRegistryRequest('pkg');
    } catch (error) {
      expect(String(error)).not.toContain('test-password');
    }
  });
});
