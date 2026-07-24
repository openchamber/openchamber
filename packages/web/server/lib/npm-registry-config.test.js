import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveNpmRegistryBase } from './npm-registry-config.js';

describe('resolveNpmRegistryBase', () => {
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
    expect(resolveNpmRegistryBase()).toBe('https://registry.npmjs.org');
  });

  it('honors npm_config_registry', () => {
    process.env.npm_config_registry = 'https://mirror.example.com/npm';
    expect(resolveNpmRegistryBase()).toBe('https://mirror.example.com/npm');
  });

  it('honors NPM_CONFIG_REGISTRY', () => {
    process.env.NPM_CONFIG_REGISTRY = 'https://mirror.example.com/npm';
    expect(resolveNpmRegistryBase()).toBe('https://mirror.example.com/npm');
  });

  it('prefers npm_config_registry over NPM_CONFIG_REGISTRY', () => {
    process.env.npm_config_registry = 'https://lower.example.com';
    process.env.NPM_CONFIG_REGISTRY = 'https://upper.example.com';
    expect(resolveNpmRegistryBase()).toBe('https://lower.example.com');
  });

  it('trims trailing slashes so it concatenates cleanly with /<package>', () => {
    process.env.NPM_CONFIG_REGISTRY = 'https://mirror.example.com/npm/';
    expect(resolveNpmRegistryBase()).toBe('https://mirror.example.com/npm');
  });

  it('falls back to the default for a blank configured value', () => {
    process.env.NPM_CONFIG_REGISTRY = '   ';
    expect(resolveNpmRegistryBase()).toBe('https://registry.npmjs.org');
  });
});
