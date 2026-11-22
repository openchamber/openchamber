import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// shared.js freezes the OpenCode config directory when it loads, so the
// scratch location is set before the module under test is imported. Nothing
// here may touch the real ~/.config/opencode.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-config-actions-')));
process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
delete process.env.OPENCODE_CONFIG_DIR;
delete process.env.OPENCODE_CONFIG;

const { createConfigActions, parseConfigPath, maskConfigSecrets, CONFIG_ACTION_DEFINITIONS, CONFIG_PARAMETERS } = await import('./config-actions.js');
const { OpenChamberControlError } = await import('./error.js');

const userConfigPath = path.join(root, 'xdg', 'opencode', 'opencode.json');

const writeFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
};
const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const createActions = (overrides = {}) => {
  let stored = {
    themeId: 'flexoki',
    agentWebToolEnabled: true,
    desktopUiPassword: 'hunter2',
  };
  const formatSettingsResponse = vi.fn((settings) => {
    const { desktopUiPassword, ...rest } = settings;
    return { ...rest, hasDesktopUiPassword: Boolean(desktopUiPassword) };
  });
  // Stands in for the real sanitizer: it drops values it cannot accept.
  const sanitizeSettingsUpdate = vi.fn((changes) => Object.fromEntries(
    Object.entries(changes).filter(([, value]) => value !== 'not-a-valid-value'),
  ));
  const persistSettings = vi.fn(async (changes) => {
    stored = { ...stored, ...changes };
    return formatSettingsResponse(stored);
  });
  const scheduled = [];
  const deps = {
    readSettingsFromDiskMigrated: vi.fn(async () => stored),
    formatSettingsResponse,
    sanitizeSettingsUpdate,
    persistSettings,
    refreshOpenCodeAfterConfigChange: vi.fn(async () => ({ reloaded: true, external: false })),
    getRequestHandoff: () => vi.fn(async () => ({ ok: true })),
    env: {},
    platform: 'darwin',
    versions: { node: '22.0.0' },
    schedule: (callback, delay) => scheduled.push({ callback, delay }),
    log: { warn: vi.fn() },
    ...overrides,
  };
  return { actions: createConfigActions(deps), deps, scheduled, persistSettings };
};

const expectError = async (promise, statusCode, pattern) => {
  const error = await promise.then(() => null, (caught) => caught);
  expect(error).toBeInstanceOf(OpenChamberControlError);
  expect(error.statusCode).toBe(statusCode);
  if (pattern) expect(error.message).toMatch(pattern);
};

let projectDir;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(root, 'project-'));
  fs.rmSync(path.join(root, 'xdg'), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
});

describe('config action contract', () => {
  it('exports definitions, parameters and the action list in one order', () => {
    const { actions } = createActions();
    expect(actions.actions).toEqual(CONFIG_ACTION_DEFINITIONS.map(({ action }) => action));
    for (const definition of CONFIG_ACTION_DEFINITIONS) {
      expect(definition.title).toBeTruthy();
      expect(definition.description).toBeTruthy();
    }
    expect(Object.keys(CONFIG_PARAMETERS)).toEqual(expect.arrayContaining(['settingKey', 'settingValue', 'configPath', 'configScope']));
  });

  it('rejects an action it does not own', async () => {
    const { actions } = createActions();
    await expectError(actions.execute('session.list', {}), 400, /Unsupported/);
  });
});

describe('settings.keys and settings.get', () => {
  it('marks each key editable or says why not', async () => {
    const { actions } = createActions();
    const { keys } = await actions.execute('settings.keys');
    const byKey = Object.fromEntries(keys.map((entry) => [entry.key, entry]));
    expect(byKey.themeId).toMatchObject({ editable: true, scope: 'profile' });
    expect(byKey.desktopUiPassword).toMatchObject({ editable: false, secret: true });
    expect(byKey.hasDesktopUiPassword.reason).toMatch(/computed/);
    expect(byKey.sidebarWidth.reason).toMatch(/per device/);
    expect(byKey.desktopHosts.reason).toMatch(/desktop app/);
    expect(byKey.permissionDefaultMode.reason).toMatch(/permissions/);
    expect(byKey.projects.reason).toMatch(/projects\.add/);
  });

  it('reads every setting through the masking formatter', async () => {
    const { actions } = createActions();
    const result = await actions.execute('settings.get', {});
    expect(result.settings).toMatchObject({ themeId: 'flexoki', hasDesktopUiPassword: true });
    expect(result.settings.desktopUiPassword).toBeUndefined();
  });

  it('reads one setting with its metadata, and only whether a secret is set', async () => {
    const { actions } = createActions();
    await expect(actions.execute('settings.get', { settingKey: 'themeId' })).resolves.toMatchObject({
      key: 'themeId', value: 'flexoki', present: true, editable: true,
    });
    const secret = await actions.execute('settings.get', { settingKey: 'desktopUiPassword' });
    expect(secret).toMatchObject({ key: 'desktopUiPassword', secret: true, isSet: true, editable: false });
    expect(JSON.stringify(secret)).not.toContain('hunter2');
    await expect(actions.execute('settings.get', { settingKey: 'locale' })).resolves.toMatchObject({ value: null, present: false });
    await expectError(actions.execute('settings.get', { settingKey: 'noSuchSetting' }), 404, /settings\.keys/);
  });
});

describe('per-surface settings', () => {
  // Backed by the real preferences-file logic, so surface resolution here is
  // the one the settings route uses.
  const createSurfaceActions = async () => {
    const files = await import('../opencode/settings-files.js');
    let fields = files.buildPreferencesFields({}, { sidebarLayout: { attention: 'separate' }, themeId: 'flexoki' }, 1);
    let now = 1;
    const read = async ({ surface = null } = {}) => files.flattenPreferences(fields, surface);
    const persistSettings = vi.fn(async (changes, { surface = null } = {}) => {
      now += 1;
      fields = files.buildPreferencesFields(fields, { ...files.flattenPreferences(fields, surface), ...changes }, now, { surface, changedKeys: Object.keys(changes) });
      return files.flattenPreferences(fields, surface);
    });
    const { actions } = createActions({ readSettingsFromDiskMigrated: vi.fn(read), persistSettings });
    return { actions, persistSettings, read };
  };

  it('lists which keys are kept per surface', async () => {
    const { actions } = createActions();
    const byKey = Object.fromEntries((await actions.execute('settings.keys')).keys.map((entry) => [entry.key, entry]));
    expect(byKey.sidebarLayout.perSurface).toBe(true);
    expect(byKey.agentWebToolEnabled.perSurface).toBeUndefined();
  });

  it('writes a surface value under that surface only, and shows it beside the base', async () => {
    const { actions, persistSettings, read } = await createSurfaceActions();
    const layout = { attention: 'separate', otherAttention: 'shared' };
    const saved = await actions.execute('settings.set', { settingKey: 'sidebarLayout', settingValue: layout, surface: 'desktop' });
    expect(persistSettings).toHaveBeenCalledWith({ sidebarLayout: layout }, { surface: 'desktop' });
    expect(saved).toMatchObject({ surface: 'desktop', updated: { sidebarLayout: layout } });
    expect((await read({ surface: 'desktop' })).sidebarLayout).toEqual(layout);
    expect((await read()).sidebarLayout).toEqual({ attention: 'separate' });

    const one = await actions.execute('settings.get', { settingKey: 'sidebarLayout' });
    expect(one).toMatchObject({ value: { attention: 'separate' }, perSurface: true, surfaces: { desktop: layout } });
    expect(one.surfaces.web).toBeUndefined();
    await expect(actions.execute('settings.get', { settingKey: 'sidebarLayout', surface: 'desktop' }))
      .resolves.toMatchObject({ value: layout, surface: 'desktop' });
    const all = await actions.execute('settings.get', {});
    expect(all.surfaces).toEqual({ desktop: { sidebarLayout: layout } });
  });

  it('says a key not kept per surface reaches every surface, even when a surface is named', async () => {
    const { actions, persistSettings } = await createSurfaceActions();
    const result = await actions.execute('settings.set', { settingKey: 'agentWebToolEnabled', settingValue: false, surface: 'desktop' });
    expect(persistSettings).toHaveBeenCalledWith({ agentWebToolEnabled: false }, { surface: 'desktop' });
    expect(result.note).toMatch(/agentWebToolEnabled is not kept per surface kind/);
  });

  it('says a base write does not reach a surface that has its own value', async () => {
    const { actions } = await createSurfaceActions();
    const result = await actions.execute('settings.set', { settingKey: 'sidebarLayout', settingValue: { attention: 'off' } });
    expect(result.note).toMatch(/sidebarLayout is kept per surface kind/);
    await expectError(actions.execute('settings.get', { surface: 'toaster' }), 400, /surface must be/);
  });
});

describe('settings.set', () => {
  it('saves one setting and answers the saved value', async () => {
    const { actions, persistSettings } = createActions();
    const result = await actions.execute('settings.set', { settingKey: 'themeId', settingValue: 'nord' });
    expect(persistSettings).toHaveBeenCalledWith({ themeId: 'nord' });
    expect(result.updated).toEqual({ themeId: 'nord' });
    expect(result.note).toMatch(/reload/);
  });

  it('saves several settings at once', async () => {
    const { actions, persistSettings } = createActions();
    const result = await actions.execute('settings.set', { settings: { themeId: 'nord', agentWebToolEnabled: false } });
    expect(persistSettings).toHaveBeenCalledWith({ themeId: 'nord', agentWebToolEnabled: false });
    expect(result.updated).toEqual({ themeId: 'nord', agentWebToolEnabled: false });
  });

  it('refuses the whole call and saves nothing when any key is refused, naming each reason', async () => {
    const { actions, persistSettings } = createActions();
    const error = await actions.execute('settings.set', {
      settings: { themeId: 'nord', desktopUiPassword: 'x', permissionDefaultMode: 'auto', sidebarWidth: 300, nope: 1, desktopHosts: [] },
    }).catch((caught) => caught);
    expect(error.statusCode).toBe(400);
    expect(error.message).toMatch(/desktopUiPassword: it is a secret/);
    expect(error.message).toMatch(/permissionDefaultMode: .*permissions/);
    expect(error.message).toMatch(/sidebarWidth: .*per device/);
    expect(error.message).toMatch(/nope: not an OpenChamber setting/);
    expect(error.message).toMatch(/desktopHosts: the desktop app/);
    expect(persistSettings).not.toHaveBeenCalled();
  });

  it('turns a value the sanitizer drops into a 400 instead of a silent no-op', async () => {
    const { actions, persistSettings } = createActions();
    await expectError(actions.execute('settings.set', { settingKey: 'themeId', settingValue: 'not-a-valid-value' }), 400, /does not accept the value given for themeId/);
    expect(persistSettings).not.toHaveBeenCalled();
  });

  it('needs confirm to turn off the control tool', async () => {
    const { actions, persistSettings } = createActions();
    await expectError(actions.execute('settings.set', { settingKey: 'agentControlToolEnabled', settingValue: false }), 400, /confirm/);
    expect(persistSettings).not.toHaveBeenCalled();
    await actions.execute('settings.set', { settingKey: 'agentControlToolEnabled', settingValue: false, confirm: true });
    expect(persistSettings).toHaveBeenCalledWith({ agentControlToolEnabled: false });
    await actions.execute('settings.set', { settingKey: 'agentControlToolEnabled', settingValue: true });
    expect(persistSettings).toHaveBeenLastCalledWith({ agentControlToolEnabled: true });
  });

  it('validates the call shape', async () => {
    const { actions } = createActions();
    await expectError(actions.execute('settings.set', {}), 400, /required/);
    await expectError(actions.execute('settings.set', { settingKey: 'themeId' }), 400, /settingValue is required/);
    await expectError(actions.execute('settings.set', { settingKey: 'themeId', settingValue: 'a', settings: {} }), 400, /not both/);
    await expectError(actions.execute('settings.set', { settings: [] }), 400, /object/);
    await expectError(actions.execute('settings.set', { settings: {} }), 400, /empty/);
  });
});

describe('parseConfigPath', () => {
  it('splits dots, quoted keys and array indexes', () => {
    expect(parseConfigPath('mcp.servers.github')).toEqual(['mcp', 'servers', 'github']);
    expect(parseConfigPath('providers.openai.models["gpt-4.1"].name')).toEqual(['providers', 'openai', 'models', 'gpt-4.1', 'name']);
    expect(parseConfigPath("plugins[0]")).toEqual(['plugins', 0]);
    expect(parseConfigPath('a[\'b.c\']')).toEqual(['a', 'b.c']);
    expect(parseConfigPath('')).toEqual([]);
  });

  it('refuses malformed and prototype paths', () => {
    for (const bad of ['a..b', 'a.', 'a[x]', 'a["b', '__proto__.x', 'a.constructor', 'a]b']) {
      expect(() => parseConfigPath(bad)).toThrow(OpenChamberControlError);
    }
    expect(() => parseConfigPath(Array.from({ length: 40 }, () => 'a').join('.'))).toThrow(/segments/);
  });
});

describe('maskConfigSecrets', () => {
  it('masks secret-looking values but keeps env and file references', () => {
    expect(maskConfigSecrets({
      providers: { openai: { settings: { apiKey: 'sk-live', baseURL: 'https://x' } } },
      mcp: { servers: { gh: { headers: { Authorization: '{env:GH_TOKEN}' }, environment: { GITHUB_TOKEN: 'ghp_1' } } } },
    })).toEqual({
      providers: { openai: { settings: { apiKey: '********', baseURL: 'https://x' } } },
      mcp: { servers: { gh: { headers: { Authorization: '{env:GH_TOKEN}' }, environment: { GITHUB_TOKEN: '********' } } } },
    });
  });

  it('masks values under bare-key names, nested and as a direct leaf', () => {
    expect(maskConfigSecrets({
      privateKey: '-----BEGIN', accessKey: 'AKIA123', sshKey: 'ssh-secret', encryptionKey: 'abc',
      licenseKey: 'LIC-1', signingKey: 'sig', sessionKey: 'sess', private_key: 'pk', key: 'bare',
      keybinds: 'ctrl+c', baseURL: 'https://x',
      nested: { access_key: '{env:AK}' },
    })).toEqual({
      privateKey: '********', accessKey: '********', sshKey: '********', encryptionKey: '********',
      licenseKey: '********', signingKey: '********', sessionKey: '********', private_key: '********', key: '********',
      keybinds: 'ctrl+c', baseURL: 'https://x',
      nested: { access_key: '{env:AK}' },
    });
    expect(maskConfigSecrets('-----BEGIN', 'privateKey')).toBe('********');
    expect(maskConfigSecrets('{file:/keys/id}', 'sshKey')).toBe('{file:/keys/id}');
  });

  it('masks every string leaf under a secret-named key, through nested objects and arrays', () => {
    expect(maskConfigSecrets({
      privateKey: { material: 'LEAK', nested: { pem: 'LEAK2' } },
      jwk: { privateKey: { kty: 'RSA', d: 'LEAK3' } },
      provider: { apiKey: { value: 'LEAK4' } },
      token: { value: 'LEAK5' },
      wrapped: [{ privateKey: [{ material: 'LEAK7' }] }],
      refs: { privateKey: { material: '{env:PK}', file: '{file:/keys/id}' } },
      plain: { nested: { material: 'readable', count: 3 } },
    })).toEqual({
      privateKey: { material: '********', nested: { pem: '********' } },
      jwk: { privateKey: { kty: '********', d: '********' } },
      provider: { apiKey: { value: '********' } },
      token: { value: '********' },
      wrapped: [{ privateKey: [{ material: '********' }] }],
      refs: { privateKey: { material: '{env:PK}', file: '{file:/keys/id}' } },
      plain: { nested: { material: 'readable', count: 3 } },
    });
  });

  it('masks passphrase values, as a leaf, in plural form and through a subtree', () => {
    expect(maskConfigSecrets('LEAK', 'passphrase')).toBe('********');
    expect(maskConfigSecrets('LEAK', 'passphrases')).toBe('********');
    expect(maskConfigSecrets('LEAK', 'myPassphrase')).toBe('********');
    expect(maskConfigSecrets({
      passphrase: 'LEAK',
      passphrases: ['LEAK2', { value: 'LEAK3' }],
      nested: { passphrase: { material: 'LEAK4' } },
      refs: { passphrase: '{env:PP}', keyPassphrase: '{file:/keys/id}' },
    })).toEqual({
      passphrase: '********',
      passphrases: ['********', { value: '********' }],
      nested: { passphrase: { material: '********' } },
      refs: { passphrase: '{env:PP}', keyPassphrase: '{file:/keys/id}' },
    });
  });

  it('masks plural secret names and pins the fail-closed bare-keys reading', () => {
    expect(maskConfigSecrets({
      privateKeys: 'LEAK', accessKeys: 'LEAK', apiKeys: 'LEAK', tokens: 'LEAK',
      secrets: 'LEAK', passwords: 'LEAK', keys: 'LEAK', monkey: 'LEAK',
      keybinds: 'ctrl+c',
    })).toEqual({
      privateKeys: '********', accessKeys: '********', apiKeys: '********', tokens: '********',
      secrets: '********', passwords: '********', keys: '********', monkey: '********',
      keybinds: 'ctrl+c',
    });
  });
});

describe('opencode.config.get', () => {
  it('reads the merged config, a layer, and a sub-tree, with the layer paths', async () => {
    writeFile(userConfigPath, JSON.stringify({ model: 'anthropic/claude', providers: { openai: { settings: { apiKey: 'sk-1' } } } }));
    writeFile(path.join(projectDir, 'opencode.json'), JSON.stringify({ model: 'openai/gpt' }));
    const { actions } = createActions();
    const ctx = { contextDirectory: projectDir };

    const merged = await actions.execute('opencode.config.get', {}, ctx);
    expect(merged).toMatchObject({ scope: 'merged', found: true, configPath: null });
    expect(merged.value.model).toBe('openai/gpt');
    expect(merged.value.providers.openai.settings.apiKey).toBe('********');
    expect(merged.files).toMatchObject({ user: userConfigPath, project: path.join(projectDir, 'opencode.json') });

    await expect(actions.execute('opencode.config.get', { configScope: 'user', configPath: 'model' }, ctx))
      .resolves.toMatchObject({ scope: 'user', found: true, value: 'anthropic/claude' });
    await expect(actions.execute('opencode.config.get', { configPath: 'providers.openai.settings.apiKey' }, ctx))
      .resolves.toMatchObject({ found: true, value: '********' });
    await expect(actions.execute('opencode.config.get', { configPath: 'nope.deeper' }, ctx))
      .resolves.toMatchObject({ found: false, value: null });
  });

  it('validates scope and path', async () => {
    const { actions } = createActions();
    await expectError(actions.execute('opencode.config.get', { configScope: 'everything' }), 400, /configScope/);
    await expectError(actions.execute('opencode.config.get', { configScope: 'project' }), 400, /directory/);
    await expectError(actions.execute('opencode.config.get', { configPath: 'a..b' }), 400, /configPath/);
  });

  it('reports a config file that does not parse', async () => {
    writeFile(userConfigPath, '{ "model": ');
    const { actions } = createActions();
    const result = await actions.execute('opencode.config.get', {}, { contextDirectory: projectDir });
    expect(result.layerErrors).toEqual([expect.objectContaining({ path: userConfigPath })]);
  });
});

describe('opencode.config.set', () => {
  it('sets a nested value in the user file, keeping its comments', async () => {
    writeFile(userConfigPath, '{\n  // my model\n  "model": "anthropic/claude"\n}\n');
    const { actions } = createActions();
    const result = await actions.execute('opencode.config.set', { configPath: 'mcp.servers.github.disabled', configValue: true }, { contextDirectory: projectDir });
    expect(result).toMatchObject({ scope: 'user', file: userConfigPath, value: true, effectiveValue: true, shadowed: false });
    expect(result.note).toMatch(/opencode\.reload/);
    const text = fs.readFileSync(userConfigPath, 'utf8');
    expect(text).toContain('// my model');
    expect(JSON.parse(text.replace(/\/\/.*$/m, ''))).toEqual({ model: 'anthropic/claude', mcp: { servers: { github: { disabled: true } } } });
  });

  it('writes the project file, creating .opencode/opencode.json', async () => {
    const { actions } = createActions();
    const result = await actions.execute('opencode.config.set', { configScope: 'project', configPath: 'model', configValue: 'openai/gpt' }, { contextDirectory: projectDir });
    const file = path.join(projectDir, '.opencode', 'opencode.json');
    expect(result.file).toBe(file);
    expect(readJson(file)).toEqual({ model: 'openai/gpt' });
  });

  it('removes a key with null or configDelete, and reports a missing key without writing', async () => {
    writeFile(userConfigPath, JSON.stringify({ model: 'a/b', share: 'manual' }));
    const { actions } = createActions();
    await expect(actions.execute('opencode.config.set', { configPath: 'model', configValue: null }))
      .resolves.toMatchObject({ deleted: true, effectiveValue: null, shadowed: false });
    await actions.execute('opencode.config.set', { configPath: 'share', configDelete: true });
    expect(readJson(userConfigPath)).toEqual({});
    const before = fs.readFileSync(userConfigPath, 'utf8');
    await expect(actions.execute('opencode.config.set', { configPath: 'mcp.servers.x', configDelete: true }))
      .resolves.toMatchObject({ deleted: false });
    expect(fs.readFileSync(userConfigPath, 'utf8')).toBe(before);
  });

  it('writes the custom file OPENCODE_CONFIG names, and nothing else', async () => {
    const customPath = path.join(root, 'custom', 'opencode.jsonc');
    writeFile(customPath, '{\n  // mine\n  "share": "manual"\n}\n');
    writeFile(userConfigPath, JSON.stringify({ model: 'a/b' }));
    process.env.OPENCODE_CONFIG = customPath;
    try {
      const { actions } = createActions();
      const result = await actions.execute('opencode.config.set', { configScope: 'custom', configPath: 'model', configValue: 'openai/gpt' }, { contextDirectory: projectDir });
      expect(result).toMatchObject({ scope: 'custom', file: customPath, value: 'openai/gpt', effectiveValue: 'openai/gpt', shadowed: false });
      const text = fs.readFileSync(customPath, 'utf8');
      expect(text).toContain('// mine');
      expect(JSON.parse(text.replace(/\/\/.*$/m, ''))).toEqual({ share: 'manual', model: 'openai/gpt' });
      expect(readJson(userConfigPath)).toEqual({ model: 'a/b' });
    } finally {
      delete process.env.OPENCODE_CONFIG;
    }
  });

  it('says a custom write is overridden by the project file, as OpenCode loads the project file later', async () => {
    const customPath = path.join(root, 'custom', 'opencode.json');
    writeFile(customPath, '{}');
    writeFile(path.join(projectDir, 'opencode.json'), JSON.stringify({ model: 'project/model' }));
    process.env.OPENCODE_CONFIG = customPath;
    try {
      const { actions } = createActions();
      const result = await actions.execute('opencode.config.set', { configScope: 'custom', configPath: 'model', configValue: 'custom/model' }, { contextDirectory: projectDir });
      expect(result).toMatchObject({ scope: 'custom', shadowed: true, effectiveValue: 'project/model' });
      expect(readJson(customPath)).toEqual({ model: 'custom/model' });
    } finally {
      delete process.env.OPENCODE_CONFIG;
    }
  });

  it('refuses every config write in enterprise mode and leaves the file alone', async () => {
    writeFile(userConfigPath, JSON.stringify({ model: 'a/b' }));
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    try {
      const { actions } = createActions();
      await expectError(actions.execute('opencode.config.set', { configPath: 'share', configValue: 'auto' }), 403, /enterprise mode/);
      expect(readJson(userConfigPath)).toEqual({ model: 'a/b' });
    } finally {
      delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    }
    const { actions } = createActions();
    await expect(actions.execute('opencode.config.set', { configPath: 'share', configValue: 'manual' })).resolves.toMatchObject({ scope: 'user' });
  });

  it('says when another file overrides the value it wrote', async () => {
    writeFile(path.join(projectDir, 'opencode.json'), JSON.stringify({ model: 'openai/gpt' }));
    const { actions } = createActions();
    const result = await actions.execute('opencode.config.set', { configPath: 'model', configValue: 'anthropic/claude' }, { contextDirectory: projectDir });
    expect(result).toMatchObject({ shadowed: true, effectiveValue: 'openai/gpt' });
    expect(readJson(userConfigPath)).toEqual({ model: 'anthropic/claude' });
  });

  it('validates the request before writing', async () => {
    writeFile(userConfigPath, JSON.stringify({ model: 'a/b' }));
    const { actions } = createActions();
    await expectError(actions.execute('opencode.config.set', { configValue: 1 }), 400, /configPath is required/);
    await expectError(actions.execute('opencode.config.set', { configPath: 'model' }), 400, /configValue is required/);
    await expectError(actions.execute('opencode.config.set', { configPath: 'model', configDelete: true, configValue: 'x' }), 400, /configDelete/);
    await expectError(actions.execute('opencode.config.set', { configPath: 'plugins[0]', configValue: 'x' }), 400, /array/);
    await expectError(actions.execute('opencode.config.set', { configPath: 'model.inner', configValue: 'x' }), 400, /non-object/);
    await expectError(actions.execute('opencode.config.set', { configScope: 'merged', configPath: 'model', configValue: 'x' }), 400, /user, project, custom/);
    // OPENCODE_CONFIG is unset in this file, so there is no custom file to write.
    await expectError(actions.execute('opencode.config.set', { configScope: 'custom', configPath: 'model', configValue: 'x' }), 400, /OPENCODE_CONFIG is not set/);
    await expectError(actions.execute('opencode.config.set', { configScope: 'project', configPath: 'model', configValue: 'x' }), 400, /directory/);
    expect(readJson(userConfigPath)).toEqual({ model: 'a/b' });
  });

  it('refuses to rewrite a file that does not parse', async () => {
    writeFile(userConfigPath, '{ "model": ');
    const { actions } = createActions();
    await expectError(actions.execute('opencode.config.set', { configPath: 'model', configValue: 'x' }), 409, /by hand/);
    expect(fs.readFileSync(userConfigPath, 'utf8')).toBe('{ "model": ');
  });
});

describe('opencode.reload', () => {
  it('restarts a managed OpenCode the way the reload route does', async () => {
    const { actions, deps } = createActions();
    await expect(actions.execute('opencode.reload')).resolves.toMatchObject({ reloaded: true });
    expect(deps.refreshOpenCodeAfterConfigChange).toHaveBeenCalledWith('agent configuration reload');
  });

  it('says an external OpenCode needs a manual restart', async () => {
    const { actions } = createActions({ refreshOpenCodeAfterConfigChange: async () => ({ reloaded: false, external: true }) });
    await expect(actions.execute('opencode.reload')).resolves.toMatchObject({ reloaded: false, external: true });
  });

  it('answers 503 without a lifecycle and passes failures through', async () => {
    await expectError(createActions({ refreshOpenCodeAfterConfigChange: null }).actions.execute('opencode.reload'), 503);
    const failing = createActions({ refreshOpenCodeAfterConfigChange: async () => { throw new Error('not ready'); } });
    await expect(failing.actions.execute('opencode.reload')).rejects.toThrow('not ready');
  });
});

describe('openchamber.restart', () => {
  it('answers first, then hands off to a successor after the delay', async () => {
    const requestHandoff = vi.fn(async () => ({ ok: true }));
    const { actions, scheduled } = createActions({ getRequestHandoff: () => requestHandoff, restartDelayMs: 500 });
    const result = await actions.execute('openchamber.restart');
    expect(result).toMatchObject({ scheduled: true, delayMs: 500 });
    expect(requestHandoff).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delay).toBe(500);

    await expect(actions.execute('openchamber.restart')).resolves.toMatchObject({ alreadyScheduled: true });
    expect(scheduled).toHaveLength(1);

    scheduled[0].callback();
    await vi.waitFor(() => expect(requestHandoff).toHaveBeenCalledWith({ exitProcess: true }));
  });

  it('logs a handoff that did not happen and allows another try', async () => {
    const requestHandoff = vi.fn(async () => ({ ok: false, reason: 'timeout' }));
    const { actions, scheduled, deps } = createActions({ getRequestHandoff: () => requestHandoff });
    await actions.execute('openchamber.restart');
    scheduled[0].callback();
    await vi.waitFor(() => expect(deps.log.warn).toHaveBeenCalledWith(expect.stringContaining('timeout')));
    await vi.waitFor(async () => expect(await actions.execute('openchamber.restart')).not.toHaveProperty('alreadyScheduled'));
  });

  it('answers 501 where no in-place restart is possible', async () => {
    const cases = [
      [{ env: { OPENCHAMBER_RUNTIME: 'desktop' } }, /desktop app/],
      [{ platform: 'win32' }, /Windows/],
      [{ env: { OPENCHAMBER_SELF_HANDOFF: '0' } }, /OPENCHAMBER_SELF_HANDOFF/],
      [{ versions: { node: '22', bun: '1.2.0' } }, /Bun/],
      [{ getRequestHandoff: () => null }, /embedded/],
    ];
    for (const [overrides, pattern] of cases) {
      const { actions, scheduled } = createActions(overrides);
      await expectError(actions.execute('openchamber.restart'), 501, pattern);
      expect(scheduled).toHaveLength(0);
    }
  });
});

describe('settings.devices', () => {
  it('returns what the windows reported, and says when none has', async () => {
    const devices = [{ deviceId: 'device-aaaa', surface: 'web', values: { sidebarWidth: 280 }, updatedAt: 1 }];
    const { actions } = createActions({ listDeviceSettings: () => devices });
    await expect(actions.execute('settings.devices', {})).resolves.toMatchObject({ devices });

    const empty = createActions({ listDeviceSettings: () => [] }).actions;
    await expect(empty.execute('settings.devices', {})).resolves.toMatchObject({ devices: [], note: expect.stringMatching(/No window has reported/) });
  });

  it('answers 503 on a server without the store', async () => {
    const { actions } = createActions();
    await expectError(actions.execute('settings.devices', {}), 503, /not available/);
  });
});
