import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { resolveNpmRegistryRequest } from './npm-registry-config.js';

const originalLowerRegistry = process.env.npm_config_registry;
const originalUpperRegistry = process.env.NPM_CONFIG_REGISTRY;
const originalUserConfig = process.env.NPM_CONFIG_USERCONFIG;
const originalLowerUserConfig = process.env.npm_config_userconfig;
const originalPrivateRegistry = process.env.PRIVATE_NPM_REGISTRY;
const originalPrivateToken = process.env.PRIVATE_NPM_TOKEN;
const originalScopedRegistry = process.env['npm_config_@scope:registry'];
let userConfigPath;

describe('npm registry configuration', () => {
  beforeEach(() => {
    userConfigPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-npmrc-')), '.npmrc');
    process.env.NPM_CONFIG_USERCONFIG = userConfigPath;
    delete process.env.npm_config_userconfig;
    delete process.env.npm_config_registry;
    delete process.env.NPM_CONFIG_REGISTRY;
    delete process.env.PRIVATE_NPM_REGISTRY;
    delete process.env.PRIVATE_NPM_TOKEN;
    delete process.env['npm_config_@scope:registry'];
  });

  afterEach(() => {
    fs.rmSync(path.dirname(userConfigPath), { recursive: true, force: true });
    if (originalLowerRegistry === undefined) delete process.env.npm_config_registry;
    else process.env.npm_config_registry = originalLowerRegistry;
    if (originalUpperRegistry === undefined) delete process.env.NPM_CONFIG_REGISTRY;
    else process.env.NPM_CONFIG_REGISTRY = originalUpperRegistry;
    if (originalUserConfig === undefined) delete process.env.NPM_CONFIG_USERCONFIG;
    else process.env.NPM_CONFIG_USERCONFIG = originalUserConfig;
    if (originalLowerUserConfig === undefined) delete process.env.npm_config_userconfig;
    else process.env.npm_config_userconfig = originalLowerUserConfig;
    if (originalPrivateRegistry === undefined) delete process.env.PRIVATE_NPM_REGISTRY;
    else process.env.PRIVATE_NPM_REGISTRY = originalPrivateRegistry;
    if (originalPrivateToken === undefined) delete process.env.PRIVATE_NPM_TOKEN;
    else process.env.PRIVATE_NPM_TOKEN = originalPrivateToken;
    if (originalScopedRegistry === undefined) delete process.env['npm_config_@scope:registry'];
    else process.env['npm_config_@scope:registry'] = originalScopedRegistry;
  });

  test('uses the default public registry without npm configuration', () => {
    expect(resolveNpmRegistryRequest('@scope/pkg')).toEqual({
      url: 'https://registry.npmjs.org/@scope%2Fpkg',
      headers: {},
    });
  });

  test('uses the user npm registry for an unscoped package', () => {
    fs.writeFileSync(userConfigPath, 'registry=https://mirror.example.com/custom/npm/\n');

    expect(resolveNpmRegistryRequest('private-plugin')).toEqual({
      url: 'https://mirror.example.com/custom/npm/private-plugin',
      headers: {},
    });
  });

  test('prefers a scoped user registry', () => {
    fs.writeFileSync(userConfigPath, [
      'registry=https://mirror.example.com/npm/',
      '@scope:registry=https://packages.example.com/npm/',
    ].join('\n'));

    expect(resolveNpmRegistryRequest('@scope/plugin').url).toBe('https://packages.example.com/npm/@scope%2Fplugin');
  });

  test('prefers a scoped user registry over an inherited general registry', () => {
    fs.writeFileSync(userConfigPath, '@scope:registry=https://packages.example.com/npm/\n');
    process.env.NPM_CONFIG_REGISTRY = 'https://inherited.example.com/npm/';

    expect(resolveNpmRegistryRequest('@scope/plugin').url).toBe('https://packages.example.com/npm/@scope%2Fplugin');
  });

  test('prefers a scoped inherited registry over user npm configuration', () => {
    fs.writeFileSync(userConfigPath, 'registry=https://mirror.example.com/npm/\n');
    process.env['npm_config_@scope:registry'] = 'https://packages.example.com/npm/';

    expect(resolveNpmRegistryRequest('@scope/plugin').url).toBe('https://packages.example.com/npm/@scope%2Fplugin');
  });

  test('prefers an inherited npm registry over user configuration', () => {
    fs.writeFileSync(userConfigPath, 'registry=https://mirror.example.com/npm/\n');
    process.env.NPM_CONFIG_REGISTRY = 'https://inherited.example.com/npm/';

    expect(resolveNpmRegistryRequest('plugin').url).toBe('https://inherited.example.com/npm/plugin');
  });

  test('uses a matching npm token without exposing it in the request URL', () => {
    fs.writeFileSync(userConfigPath, [
      'registry=https://packages.example.com/npm/',
      '//packages.example.com/npm/:_authToken=private-token',
    ].join('\n'));

    const request = resolveNpmRegistryRequest('private-plugin');

    expect(request.url).toBe('https://packages.example.com/npm/private-plugin');
    expect(request.url).not.toContain('private-token');
    expect(request.headers).toEqual({ Authorization: 'Bearer private-token' });
  });

  test('uses npm basic authentication with its base64-encoded password', () => {
    fs.writeFileSync(userConfigPath, [
      'registry=https://packages.example.com/npm/',
      '//packages.example.com/npm/:username=registry-user',
      '//packages.example.com/npm/:_password=c2VjcmV0',
    ].join('\n'));

    expect(resolveNpmRegistryRequest('private-plugin').headers).toEqual({
      Authorization: 'Basic cmVnaXN0cnktdXNlcjpzZWNyZXQ=',
    });
  });

  test('expands environment variables in user npm configuration', () => {
    process.env.PRIVATE_NPM_TOKEN = 'expanded-token';
    fs.writeFileSync(userConfigPath, [
      'registry=${PRIVATE_NPM_REGISTRY}',
      '//packages.example.com/npm/:_authToken=${PRIVATE_NPM_TOKEN}',
    ].join('\n'));
    process.env.PRIVATE_NPM_REGISTRY = 'https://packages.example.com/npm/';

    expect(resolveNpmRegistryRequest('private-plugin')).toEqual({
      url: 'https://packages.example.com/npm/private-plugin',
      headers: { Authorization: 'Bearer expanded-token' },
    });
  });

  test('reads quoted values the way npm does', () => {
    fs.writeFileSync(userConfigPath, [
      '@scope:registry = "https://packages.example.com/npm/"',
      "//packages.example.com/npm/:_authToken='quoted-token'",
    ].join('\n'));

    expect(resolveNpmRegistryRequest('@scope/plugin')).toEqual({
      url: 'https://packages.example.com/npm/@scope%2Fplugin',
      headers: { Authorization: 'Bearer quoted-token' },
    });
  });

  test('honors the lowercase userconfig variable npm sets for child processes', () => {
    delete process.env.NPM_CONFIG_USERCONFIG;
    process.env.npm_config_userconfig = userConfigPath;
    fs.writeFileSync(userConfigPath, 'registry=https://mirror.example.com/npm/\n');

    try {
      expect(resolveNpmRegistryRequest('plugin').url).toBe('https://mirror.example.com/npm/plugin');
    } finally {
      delete process.env.npm_config_userconfig;
    }
  });

  test('rejects unresolved npm configuration environment variables', () => {
    fs.writeFileSync(userConfigPath, 'registry=${MISSING_NPM_REGISTRY}\n');

    expect(() => resolveNpmRegistryRequest('private-plugin')).toThrow('Invalid npm registry URL');
  });

  test('rejects malformed registry values without exposing their contents', () => {
    fs.writeFileSync(userConfigPath, 'registry=not-a-url-private-token\n');

    expect(() => resolveNpmRegistryRequest('plugin')).toThrow('Invalid npm registry URL');
  });
});
