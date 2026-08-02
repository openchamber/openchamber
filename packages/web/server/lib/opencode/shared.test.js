import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = `/tmp/openchamber-config-${process.pid}`;
const configRoot = path.join(root, 'config');
const configDir = path.join(configRoot, 'opencode');
const project = path.join(root, 'project');
const custom = path.join(root, 'custom.json');
const customDir = path.join(root, 'custom-dir');
const managedDir = path.join(root, 'managed');
const home = path.join(root, 'home');
const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalCustomConfig = process.env.OPENCODE_CONFIG;
const originalCustomConfigDir = process.env.OPENCODE_CONFIG_DIR;
const originalConfigContent = process.env.OPENCODE_CONFIG_CONTENT;
const originalManagedConfigDir = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR;
const originalDisableProjectConfig = process.env.OPENCODE_DISABLE_PROJECT_CONFIG;
const originalHome = process.env.HOME;

process.env.XDG_CONFIG_HOME = configRoot;
process.env.OPENCODE_CONFIG = custom;
process.env.OPENCODE_CONFIG_DIR = customDir;
process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = managedDir;
process.env.HOME = home;
delete process.env.OPENCODE_CONFIG_CONTENT;
delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG;

const { getJsonEntrySource, getJsonWriteTarget, readConfigFile, readConfigLayers, resolveConfigValue } = await import('./shared.js');
const { getProviderSources } = await import('./providers.js');

describe('OpenCode config loading', () => {
  beforeAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(project, '.git'));
    fs.mkdirSync(customDir);
    fs.mkdirSync(managedDir);
    fs.mkdirSync(home);
  });

  afterAll(() => {
    if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalConfigHome;
    if (originalCustomConfig === undefined) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = originalCustomConfig;
    if (originalCustomConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = originalCustomConfigDir;
    if (originalConfigContent === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
    else process.env.OPENCODE_CONFIG_CONTENT = originalConfigContent;
    if (originalManagedConfigDir === undefined) delete process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR;
    else process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = originalManagedConfigDir;
    if (originalDisableProjectConfig === undefined) delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG;
    else process.env.OPENCODE_DISABLE_PROJECT_CONFIG = originalDisableProjectConfig;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('uses OpenCode layer precedence: global, custom, then project', () => {
    fs.writeFileSync(path.join(configDir, 'opencode.json'), JSON.stringify({
      provider: { custom: { options: { apiKey: 'global', baseURL: 'https://global.test' } } },
    }));
    fs.writeFileSync(custom, JSON.stringify({
      provider: { custom: { options: { apiKey: 'custom' } } },
    }));
    fs.writeFileSync(path.join(project, 'opencode.json'), JSON.stringify({
      provider: { custom: { options: { apiKey: 'project' } } },
    }));

    expect(readConfigLayers(project).mergedConfig.provider.custom.options).toEqual({
      apiKey: 'project',
      baseURL: 'https://global.test',
    });
  });

  it('loads all local OpenCode config sources in authoritative order', () => {
    const nested = path.join(project, 'nested');
    fs.mkdirSync(path.join(nested, '.opencode'), { recursive: true });
    fs.mkdirSync(path.join(project, '.opencode'), { recursive: true });
    fs.mkdirSync(path.join(home, '.opencode'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), '{ "order": "global-config", "globalConfig": true }');
    fs.writeFileSync(path.join(configDir, 'opencode.json'), '{ "order": "global-json", "globalJson": true }');
    fs.writeFileSync(path.join(configDir, 'opencode.jsonc'), '{ "order": "global-jsonc", "globalJsonc": true }');
    fs.writeFileSync(custom, '{ "order": "custom-file", "customFile": true }');
    fs.writeFileSync(path.join(project, 'opencode.json'), '{ "order": "ancestor-project", "ancestorProject": true }');
    fs.writeFileSync(path.join(nested, 'opencode.jsonc'), '{ "order": "nested-project", "nestedProject": true }');
    fs.writeFileSync(path.join(nested, '.opencode', 'opencode.json'), '{ "order": "nested-dot", "nestedDot": true }');
    fs.writeFileSync(path.join(project, '.opencode', 'opencode.jsonc'), '{ "order": "ancestor-dot", "ancestorDot": true }');
    fs.writeFileSync(path.join(home, '.opencode', 'opencode.json'), '{ "order": "home-dot", "homeDot": true }');
    fs.writeFileSync(path.join(customDir, 'opencode.jsonc'), '{ "order": "custom-dir", "customDir": true }');
    process.env.OPENCODE_CONFIG_CONTENT = '{ "order": "inline", "inline": true }';
    fs.writeFileSync(path.join(managedDir, 'opencode.json'), '{ "order": "managed", "managed": true }');

    const layers = readConfigLayers(nested);

    expect(layers.mergedConfig).toMatchObject({
      order: 'managed',
      globalConfig: true,
      globalJson: true,
      globalJsonc: true,
      customFile: true,
      ancestorProject: true,
      nestedProject: true,
      nestedDot: true,
      ancestorDot: true,
      homeDot: true,
      customDir: true,
      inline: true,
      managed: true,
    });
    expect(layers.sources.map(({ scope }) => scope)).toEqual([
      'user', 'user', 'user', 'custom', 'project', 'project', 'project', 'project',
      'user', 'custom-directory', 'inline', 'managed',
    ]);
  });

  it('uses the effective source and a project-scoped write target', () => {
    const nested = path.join(project, 'source-test');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(custom, '{ "agent": { "review": { "model": "custom" } } }');
    fs.writeFileSync(path.join(project, 'opencode.json'), '{ "agent": { "review": { "model": "project" } } }');

    const layers = readConfigLayers(nested);
    const source = getJsonEntrySource(layers, 'agent', 'review');

    expect(source.section.model).toBe('project');
    expect(source.path).toBe(path.join(project, 'opencode.json'));
    expect(getJsonWriteTarget(layers, 'project')).toEqual({
      config: {},
      path: path.join(nested, 'opencode.json'),
    });
  });

  it('discovers ancestors outside a Git worktree and parses the disable flag like OpenCode', () => {
    const parent = path.join(root, 'non-git');
    const nested = path.join(parent, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(parent, 'opencode.json'), '{ "ancestor": true }');

    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = 'false';
    expect(readConfigLayers(nested).mergedConfig.ancestor).toBe(true);
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
    expect(readConfigLayers(nested).mergedConfig.ancestor).toBeUndefined();
    delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG;
  });

  it('reports an inline winner as read-only instead of redirecting writes', () => {
    process.env.OPENCODE_CONFIG_CONTENT = '{ "agent": { "review": { "model": "inline" } } }';
    const source = getJsonEntrySource(readConfigLayers(project), 'agent', 'review');

    expect(source).toMatchObject({ scope: 'inline', path: null, writable: false });
    delete process.env.OPENCODE_CONFIG_CONTENT;
  });

  it('reports every provider config source with its exact path', () => {
    const provider = '{ "provider": { "custom-provider": {} } }';
    fs.writeFileSync(custom, provider);
    fs.writeFileSync(path.join(project, 'opencode.json'), provider);
    fs.writeFileSync(path.join(customDir, 'opencode.jsonc'), provider);
    process.env.OPENCODE_CONFIG_CONTENT = provider;
    fs.writeFileSync(path.join(managedDir, 'opencode.json'), provider);

    expect(getProviderSources('custom-provider', project).sources).toMatchObject({
      custom: { exists: true, path: custom },
      project: { exists: true, path: path.join(project, 'opencode.json') },
      customDirectory: { exists: true, path: path.join(customDir, 'opencode.jsonc') },
      inline: { exists: true, path: null },
      managed: { exists: true, path: path.join(managedDir, 'opencode.json') },
    });
    delete process.env.OPENCODE_CONFIG_CONTENT;
  });

  it('expands config variables and fails closed without leaking unavailable names', () => {
    process.env.OPENCHAMBER_TEST_SMALL_MODEL = 'custom/model';
    process.env.OPENCHAMBER_TEST_SECRET = 'sk-must-stay-out-of-config';
    fs.writeFileSync(custom, `{
      "small_model": "{env:OPENCHAMBER_TEST_SMALL_MODEL}",
      "provider": { "custom": { "options": { "apiKey": "{env:OPENCHAMBER_TEST_SECRET}" } } }
    }`);
    const layers = readConfigLayers(project);
    expect(layers.mergedConfig.small_model).toBe('{env:OPENCHAMBER_TEST_SMALL_MODEL}');
    expect(JSON.stringify(layers)).not.toContain(process.env.OPENCHAMBER_TEST_SECRET);
    expect(resolveConfigValue(layers, 'small_model', project)).toBe('custom/model');

    fs.writeFileSync(custom, '{ "small_model": "{env:OPENCHAMBER_SECRET_MODEL_NAME}" }');
    expect(() => resolveConfigValue(readConfigLayers(project), 'small_model', project))
      .toThrow('Failed to resolve OpenCode configuration');
    try {
      resolveConfigValue(readConfigLayers(project), 'small_model', project);
    } catch (error) {
      expect(error.message).not.toContain('OPENCHAMBER_SECRET_MODEL_NAME');
    }
    delete process.env.OPENCHAMBER_TEST_SMALL_MODEL;
    delete process.env.OPENCHAMBER_TEST_SECRET;
  });

  it('allows the higher-precedence project policy to replace a custom policy', () => {
    fs.writeFileSync(custom, '{ "disabled_providers": ["custom-provider"] }');
    fs.writeFileSync(path.join(project, 'opencode.json'), '{ "disabled_providers": [] }');

    expect(readConfigLayers(project).mergedConfig.disabled_providers).toEqual([]);
  });

  it('rejects malformed JSONC without including config contents in the error', () => {
    const file = path.join(root, 'malformed.json');
    const secret = 'sk-must-not-leak';
    fs.writeFileSync(file, `{ "provider": { "apiKey": "${secret}" `);

    expect(() => readConfigFile(file)).toThrow('Failed to read OpenCode configuration');
    try {
      readConfigFile(file);
    } catch (error) {
      expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain(file);
    }
  });
});
