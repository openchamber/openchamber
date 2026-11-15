import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveWorktreeDirectory } from './worktree-directory.js';

const primaryWorktree = path.resolve(path.sep, 'projects', 'my-app');
const homeDirectory = path.resolve(path.sep, 'home', 'dev');

describe('resolveWorktreeDirectory', () => {
  it('returns null when the setting is absent or not a non-empty string', () => {
    expect(resolveWorktreeDirectory({}, primaryWorktree, homeDirectory)).toBeNull();
    expect(resolveWorktreeDirectory({ worktree: {} }, primaryWorktree, homeDirectory)).toBeNull();
    expect(resolveWorktreeDirectory({ worktree: { directory: null } }, primaryWorktree, homeDirectory)).toBeNull();
    expect(resolveWorktreeDirectory({ worktree: { directory: '   ' } }, primaryWorktree, homeDirectory)).toBeNull();
    expect(resolveWorktreeDirectory({ worktree: { directory: 42 } }, primaryWorktree, homeDirectory)).toBeNull();
    expect(resolveWorktreeDirectory({ worktree: 'nope' }, primaryWorktree, homeDirectory)).toBeNull();
    expect(resolveWorktreeDirectory(null, primaryWorktree, homeDirectory)).toBeNull();
  });

  it('resolves a relative folder against the canonical checkout', () => {
    expect(resolveWorktreeDirectory({ worktree: { directory: '.worktrees' } }, primaryWorktree, homeDirectory))
      .toBe(path.join(primaryWorktree, '.worktrees'));
    expect(resolveWorktreeDirectory({ worktree: { directory: '../trees' } }, primaryWorktree, homeDirectory))
      .toBe(path.join(path.dirname(primaryWorktree), 'trees'));
  });

  it('uses an absolute path as-is', () => {
    const absolute = path.resolve(path.sep, 'var', 'trees');
    expect(resolveWorktreeDirectory({ worktree: { directory: absolute } }, primaryWorktree, homeDirectory))
      .toBe(absolute);
  });

  it('expands a leading ~ against the home directory', () => {
    expect(resolveWorktreeDirectory({ worktree: { directory: '~' } }, primaryWorktree, homeDirectory))
      .toBe(homeDirectory);
    expect(resolveWorktreeDirectory({ worktree: { directory: '~/trees' } }, primaryWorktree, homeDirectory))
      .toBe(path.join(homeDirectory, 'trees'));
  });
});

describe('readWorktreeDirectorySetting', () => {
  let root;
  let checkout;
  let globalDir;
  let readSetting;

  const writeConfig = (filePath, config) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(config));
  };

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-worktree-config-'));
    checkout = path.join(root, 'workspace', 'repository');
    globalDir = path.join(root, 'global');
    fs.mkdirSync(checkout, { recursive: true });
    vi.stubEnv('OPENCODE_CONFIG_DIR', globalDir);
    vi.stubEnv('OPENCODE_CONFIG', '');
    vi.resetModules();
    readSetting = (await import('./shared.js')).readWorktreeDirectorySetting;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(['opencode.json', path.join('.opencode', 'opencode.jsonc')])('inherits %s above the checkout', (name) => {
    writeConfig(path.join(root, 'workspace', name), { worktree: { directory: '../trees' } });
    expect(readSetting(checkout)).toBe(path.join(root, 'workspace', 'trees'));
  });

  it('merges global, custom, direct and .opencode files in OpenCode order', () => {
    const globalJson = path.join(globalDir, 'opencode.json');
    const globalJsonc = path.join(globalDir, 'opencode.jsonc');
    const custom = path.join(root, 'custom.json');
    const ancestor = path.join(root, 'workspace', 'opencode.json');
    const local = path.join(checkout, 'opencode.jsonc');
    const ancestorDot = path.join(root, 'workspace', '.opencode', 'opencode.jsonc');
    const localDot = path.join(checkout, '.opencode', 'opencode.json');
    const localDotJsonc = path.join(checkout, '.opencode', 'opencode.jsonc');
    vi.stubEnv('OPENCODE_CONFIG', custom);
    for (const [index, filePath] of [globalJson, globalJsonc, custom, ancestor, local, ancestorDot, localDot, localDotJsonc].entries()) {
      writeConfig(filePath, { worktree: { directory: `trees-${index}` } });
      expect(readSetting(checkout)).toBe(path.join(checkout, `trees-${index}`));
    }
  });

  it('keeps an inherited directory when a closer config sets unrelated keys', () => {
    const target = path.join(root, 'trees');
    writeConfig(path.join(root, 'workspace', '.opencode', 'opencode.jsonc'), { worktree: { directory: target } });
    writeConfig(path.join(checkout, '.opencode', 'opencode.json'), { model: 'test/model' });
    expect(readSetting(checkout)).toBe(target);
  });

  it('lets a closer config unset an inherited directory', () => {
    writeConfig(path.join(root, 'workspace', '.opencode', 'opencode.json'), { worktree: { directory: '../trees' } });
    writeConfig(path.join(checkout, '.opencode', 'opencode.jsonc'), { worktree: null });
    expect(readSetting(checkout)).toBeNull();
  });

  it('rejects an invalid ancestor instead of returning the default folder', () => {
    const filePath = path.join(root, 'workspace', 'opencode.json');
    fs.writeFileSync(filePath, '{ "worktree": ');
    expect(() => readSetting(checkout)).toThrow(/invalid JSONC/);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{ "worktree": ');
  });
});
