import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

let rootDir;
let projectDir;
let userConfigPath;
let plugins;
const MAX_PLUGIN_FILE_BYTES = 1024 * 1024;

function thrownBy(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected function to throw');
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

describe('opencode plugins data layer', () => {
  beforeAll(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-plugins-'));
    userConfigPath = path.join(rootDir, 'user-opencode.json');
    process.env.OPENCODE_CONFIG = userConfigPath;
    plugins = await import('./plugins.js');
  });

  beforeEach(() => {
    process.env.OPENCODE_CONFIG = userConfigPath;
    projectDir = fs.mkdtempSync(path.join(rootDir, 'project-'));
    fs.rmSync(userConfigPath, { force: true });
  });

  afterAll(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    delete process.env.OPENCODE_CONFIG;
  });

  test('parses v1 tuples and v2 objects into the same entry', () => {
    expect(plugins.parsePluginRaw('foo')).toEqual({ spec: 'foo' });
    expect(plugins.parsePluginRaw('foo@1.0.0')).toEqual({ spec: 'foo@1.0.0' });
    expect(plugins.parsePluginRaw(['foo', { a: 1 }])).toEqual({ spec: 'foo', options: { a: 1 } });
    expect(plugins.parsePluginRaw(['foo', {}])).toEqual({ spec: 'foo' });
    expect(plugins.parsePluginRaw({ package: 'foo', options: { a: 1 } })).toEqual({ spec: 'foo', options: { a: 1 } });
    expect(plugins.parsePluginRaw({ package: 'foo' })).toEqual({ spec: 'foo' });
    expect(() => plugins.parsePluginRaw(123)).toThrow('Plugin spec');
  });

  test('serializes plugin entries in v2 shape, never a tuple', () => {
    expect(plugins.serializePluginEntry({ spec: 'foo' })).toBe('foo');
    expect(plugins.serializePluginEntry({ spec: 'foo', options: undefined })).toBe('foo');
    expect(plugins.serializePluginEntry({ spec: 'foo', options: {} })).toBe('foo');
    expect(plugins.serializePluginEntry({ spec: 'foo', options: { a: 1 } })).toEqual({ package: 'foo', options: { a: 1 } });
  });

  test('rejects invalid specs and file names', () => {
    expect(() => plugins.createPluginEntry({ spec: 123, scope: 'user' }, projectDir)).toThrow('Plugin spec');
    expect(() => plugins.writePluginDirFile({ fileName: '', content: '', scope: 'project' }, projectDir)).toThrow('Plugin file name');
    expect(() => plugins.writePluginDirFile({ fileName: '../bad.js', content: '', scope: 'project' }, projectDir)).toThrow('Plugin file name');
    expect(() => plugins.writePluginDirFile({ fileName: 'a/b.js', content: '', scope: 'project' }, projectDir)).toThrow('Plugin file name');
    expect(() => plugins.writePluginDirFile({ fileName: 'A.js', content: '', scope: 'project' }, projectDir)).toThrow('Plugin file name');
    expect(() => plugins.writePluginDirFile({ fileName: 'foo.txt', content: '', scope: 'project' }, projectDir)).toThrow('Plugin file name');
  });

  test('creates string and object entries with duplicate rejection', () => {
    plugins.createPluginEntry({ spec: 'plain-plugin', scope: 'user' }, projectDir);
    plugins.createPluginEntry({ spec: 'tuple-plugin', options: { apiKey: 'x' }, scope: 'user' }, projectDir);

    expect(readJson(userConfigPath).plugins).toEqual(['plain-plugin', { package: 'tuple-plugin', options: { apiKey: 'x' } }]);
    expect(readJson(userConfigPath).plugin).toBeUndefined();
    expect(() => plugins.createPluginEntry({ spec: 'plain-plugin', scope: 'user' }, projectDir)).toThrow('already exists');
    expect(thrownBy(() => plugins.createPluginEntry({ spec: 'plain-plugin', scope: 'user' }, projectDir))).toHaveProperty('code', 'ENTRY_EXISTS');
  });

  test('writes a plain repository address in the form OpenCode loads', () => {
    plugins.createPluginEntry({ spec: ' https://github.com/owner/repo.git ', scope: 'user' }, projectDir);

    expect(readJson(userConfigPath).plugins).toEqual(['git+https://github.com/owner/repo.git']);
    expect(thrownBy(() => plugins.createPluginEntry({ spec: 'git+https://github.com/owner/repo.git', scope: 'user' }, projectDir)))
      .toHaveProperty('code', 'ENTRY_EXISTS');
  });

  test('refuses a spec OpenCode cannot load and leaves the config untouched', () => {
    writeJson(userConfigPath, { plugins: ['alpha'] });

    expect(thrownBy(() => plugins.createPluginEntry({ spec: 'https://example.com/plugin.tgz', scope: 'user' }, projectDir)))
      .toHaveProperty('code', 'UNLOADABLE_SPEC');
    expect(thrownBy(() => plugins.updatePluginEntry(plugins.encodePluginId('config', 'user:alpha'), { spec: 'my plugin' }, projectDir)))
      .toHaveProperty('code', 'UNLOADABLE_SPEC');
    expect(readJson(userConfigPath)).toEqual({ plugins: ['alpha'] });
  });

  test('keeps an existing entry OpenCode cannot load when only its options change', () => {
    const legacy = 'https://example.com/plugin.tgz';
    writeJson(userConfigPath, { plugins: [legacy] });

    plugins.updatePluginEntry(plugins.encodePluginId('config', `user:${legacy}`), { spec: legacy, options: { a: 1 } }, projectDir);
    expect(readJson(userConfigPath).plugins).toEqual([{ package: legacy, options: { a: 1 } }]);
  });

  test('routes project entries to project config and user entries to custom user config', () => {
    plugins.createPluginEntry({ spec: 'user-plugin', scope: 'user' }, projectDir);
    plugins.createPluginEntry({ spec: 'project-plugin', scope: 'project' }, projectDir);

    expect(readJson(userConfigPath).plugins).toEqual(['user-plugin']);
    expect(readJson(path.join(projectDir, '.opencode', 'opencode.json')).plugins).toEqual(['project-plugin']);
  });

  test('re-resolves custom config env between calls', () => {
    const firstConfigPath = path.join(rootDir, 'first', 'opencode.json');
    const secondConfigPath = path.join(rootDir, 'second', 'opencode.json');

    process.env.OPENCODE_CONFIG = firstConfigPath;
    plugins.createPluginEntry({ spec: 'first-plugin', scope: 'user' }, projectDir);
    plugins.writePluginDirFile({ fileName: 'first.js', content: 'one', scope: 'user' }, projectDir);

    process.env.OPENCODE_CONFIG = secondConfigPath;
    plugins.createPluginEntry({ spec: 'second-plugin', scope: 'user' }, projectDir);
    plugins.writePluginDirFile({ fileName: 'second.js', content: 'two', scope: 'user' }, projectDir);

    expect(readJson(firstConfigPath).plugins).toEqual(['first-plugin']);
    expect(readJson(secondConfigPath).plugins).toEqual(['second-plugin']);
    expect(fs.existsSync(path.join(path.dirname(firstConfigPath), 'plugins', 'first.js'))).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(secondConfigPath), 'plugins', 'second.js'))).toBe(true);
  });

  test('rewrites a v1 plugin array into v2 plugins when one entry is updated', () => {
    writeJson(userConfigPath, { plugin: ['first', ['second', { a: 1 }], 'third'] });

    plugins.updatePluginEntry(plugins.encodePluginId('config', 'user:second'), { spec: 'second-new', options: {} }, projectDir);
    const migrated = readJson(userConfigPath);
    expect(migrated.plugin).toBeUndefined();
    expect(migrated.plugins).toEqual(['first', 'second-new', 'third']);

    plugins.updatePluginEntry(plugins.encodePluginId('config', 'user:first'), { spec: 'first-new', options: { b: 2 } }, projectDir);
    expect(readJson(userConfigPath).plugins).toEqual([{ package: 'first-new', options: { b: 2 } }, 'second-new', 'third']);
  });

  test('reads a v2 plugins array and updates it in place', () => {
    writeJson(userConfigPath, { plugins: ['alpha', { package: 'beta', options: { a: 1 } }] });

    expect(plugins.listPluginEntries(projectDir).map((entry) => entry.spec)).toEqual(['alpha', 'beta']);
    plugins.updatePluginEntry(plugins.encodePluginId('config', 'user:beta'), { options: { a: 2 } }, projectDir);
    expect(readJson(userConfigPath).plugins).toEqual(['alpha', { package: 'beta', options: { a: 2 } }]);
  });

  test('deletes entries and prunes the empty plugins key', () => {
    writeJson(userConfigPath, { plugins: ['only'] });

    plugins.deletePluginEntry(plugins.encodePluginId('config', 'user:only'), projectDir);
    expect(readJson(userConfigPath)).toEqual({});
  });

  test('lists user plugins when a project layer is unparseable', () => {
    const partialProject = [
      '{',
      '  "$schema": "https://opencode.ai/config.json",',
      '  plugin: ["broken-project-plugin"],',
      '}',
      '',
    ].join('\n');
    writeJson(userConfigPath, { plugin: ['user-plugin'] });
    const projectFile = path.join(projectDir, '.opencode', 'opencode.jsonc');
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(projectFile, partialProject, 'utf8');

    expect(plugins.listPluginEntries(projectDir).map((entry) => entry.spec)).toEqual(['user-plugin']);
    expect(fs.readFileSync(projectFile, 'utf8')).toBe(partialProject);
    expect(fs.existsSync(`${projectFile}.openchamber.backup`)).toBe(false);
  });

  test('lists entries from user and project layers with scopes and parsed kinds', () => {
    writeJson(userConfigPath, { plugin: ['npm-plugin', '/abs/plugin.js', '@scope/pkg@1.0.0'] });
    writeJson(path.join(projectDir, '.opencode', 'opencode.json'), { plugin: ['./local-plugin.js'] });

    const entries = plugins.listPluginEntries(projectDir);
    expect(entries).toEqual([
      expect.objectContaining({ spec: 'npm-plugin', scope: 'user', kind: 'config', parsedKind: 'npm', sourcePath: userConfigPath }),
      expect.objectContaining({ spec: '/abs/plugin.js', scope: 'user', kind: 'config', parsedKind: 'path', sourcePath: userConfigPath }),
      expect.objectContaining({ spec: '@scope/pkg@1.0.0', scope: 'user', kind: 'config', parsedKind: 'npm', sourcePath: userConfigPath }),
      expect.objectContaining({ spec: './local-plugin.js', scope: 'project', kind: 'config', parsedKind: 'path', sourcePath: path.join(projectDir, '.opencode', 'opencode.json') }),
    ]);
    fs.rmSync(userConfigPath, { force: true });
    expect(plugins.listPluginEntries(projectDir)).toEqual([
      expect.objectContaining({ spec: './local-plugin.js', scope: 'project' }),
    ]);
  });

  test('encodes and decodes ids', () => {
    const id = plugins.encodePluginId('config', 'user:oh-my-openagent@4.3.0');
    expect(plugins.decodePluginId(id)).toEqual({ prefix: 'config', value: 'user:oh-my-openagent@4.3.0' });
  });

  test('round-trips plugin dir files', () => {
    plugins.writePluginDirFile({ fileName: 'my-plugin.ts', content: 'export default {}', scope: 'project' }, projectDir);
    const file = plugins.listPluginDirFiles(projectDir).find((candidate) => candidate.fileName === 'my-plugin.ts');

    expect(file).toEqual(expect.objectContaining({ fileName: 'my-plugin.ts', scope: 'project', kind: 'file' }));
    expect(plugins.readPluginDirFile(file.id, projectDir)).toEqual({ fileName: 'my-plugin.ts', scope: 'project', content: 'export default {}' });
    plugins.deletePluginDirFile(file.id, projectDir);
    expect(plugins.listPluginDirFiles(projectDir).filter((candidate) => candidate.scope === 'project')).toEqual([]);
    expect(() => plugins.deletePluginDirFile(file.id, projectDir)).toThrow('not found');
  });

  test('reads a plugin file at the byte limit without changing its contents', () => {
    const content = 'x'.repeat(MAX_PLUGIN_FILE_BYTES);
    plugins.writePluginDirFile({ fileName: 'at-limit.js', content, scope: 'project' }, projectDir);
    const file = plugins.listPluginDirFiles(projectDir).find((candidate) => candidate.fileName === 'at-limit.js');

    expect(fs.statSync(path.join(projectDir, '.opencode', 'plugins', 'at-limit.js')).size).toBe(MAX_PLUGIN_FILE_BYTES);
    expect(plugins.readPluginDirFile(file.id, projectDir)).toEqual({ fileName: 'at-limit.js', scope: 'project', content });
  });

  test('refuses an over-cap plugin write and leaves any existing file byte-identical (#1444)', () => {
    const dirPath = path.join(projectDir, '.opencode', 'plugins');
    fs.mkdirSync(dirPath, { recursive: true });
    const overCap = 'x'.repeat(MAX_PLUGIN_FILE_BYTES + 1);

    const createError = thrownBy(() => plugins.writePluginDirFile({ fileName: 'new-over.js', content: overCap, scope: 'project' }, projectDir));
    expect(createError.code).toBe('PLUGIN_FILE_TOO_LARGE');
    expect(fs.existsSync(path.join(dirPath, 'new-over.js'))).toBe(false);

    const existingPath = path.join(dirPath, 'existing.js');
    fs.writeFileSync(existingPath, 'original', 'utf8');
    const updateError = thrownBy(() => plugins.writePluginDirFile({ fileName: 'existing.js', content: overCap, scope: 'project' }, projectDir, { overwrite: true }));
    expect(updateError.code).toBe('PLUGIN_FILE_TOO_LARGE');
    expect(fs.readFileSync(existingPath, 'utf8')).toBe('original');
  });

  test('refuses an oversized plugin file before reading it', () => {
    const fileName = 'over-limit.js';
    const filePath = path.join(projectDir, '.opencode', 'plugins', fileName);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'x'.repeat(MAX_PLUGIN_FILE_BYTES + 1), 'utf8');
    const id = plugins.encodePluginId('file', `project:${fileName}`);
    const originalReadFileSync = fs.readFileSync;
    let readAttempted = false;

    fs.readFileSync = (...args) => {
      if (args[0] === filePath) {
        readAttempted = true;
        throw new Error('oversized plugin file was read');
      }
      return originalReadFileSync.apply(fs, args);
    };

    try {
      const error = thrownBy(() => plugins.readPluginDirFile(id, projectDir));
      expect(error.code).toBe('PLUGIN_FILE_TOO_LARGE');
      expect(error.message).toBe(`Plugin file exceeds maximum size of ${MAX_PLUGIN_FILE_BYTES} bytes`);
      expect(readAttempted).toBe(false);
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
  });

  test('returns null when a plugin file is missing', () => {
    const id = plugins.encodePluginId('file', 'project:missing.js');

    expect(plugins.readPluginDirFile(id, projectDir)).toBeNull();
  });

  test('rejects duplicate plugin dir files unless overwrite is true', () => {
    plugins.writePluginDirFile({ fileName: 'dup.js', content: 'one', scope: 'project' }, projectDir);
    expect(() => plugins.writePluginDirFile({ fileName: 'dup.js', content: 'two', scope: 'project' }, projectDir)).toThrow('already exists');
    expect(thrownBy(() => plugins.writePluginDirFile({ fileName: 'dup.js', content: 'two', scope: 'project' }, projectDir))).toHaveProperty('code', 'FILE_EXISTS');

    plugins.writePluginDirFile({ fileName: 'dup.js', content: 'two', scope: 'project' }, projectDir, { overwrite: true });
    expect(fs.readFileSync(path.join(projectDir, '.opencode', 'plugins', 'dup.js'), 'utf8')).toBe('two');
  });

  test('lists only valid plugin dir files', () => {
    const dir = path.join(projectDir, '.opencode', 'plugins');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'valid.mjs'), '', 'utf8');
    fs.writeFileSync(path.join(dir, 'README.md'), '', 'utf8');

    expect(plugins.listPluginDirFiles(projectDir).filter((file) => file.scope === 'project')).toEqual([
      expect.objectContaining({ fileName: 'valid.mjs', scope: 'project' }),
    ]);
  });
});
