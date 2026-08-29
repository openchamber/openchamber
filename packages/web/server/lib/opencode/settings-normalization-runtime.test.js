import { describe, expect, it } from 'vitest';

import { createSettingsNormalizationRuntime } from './settings-normalization-runtime.js';

const createTestRuntime = (overrides = {}) => {
  const defaults = {
    os: { homedir: () => '/home/testuser' },
    path: {
      resolve: (...args) => args[args.length - 1],
      sep: '/',
      dirname: (p) => p.split('/').slice(0, -1).join('/') || '/',
    },
    processLike: { platform: 'linux', env: {} },
    realpathSync: (p) => p,
    tunnelBootstrapTtlDefaultMs: 600000,
    tunnelBootstrapTtlMinMs: 60000,
    tunnelBootstrapTtlMaxMs: 3600000,
    tunnelSessionTtlDefaultMs: 86400000,
    tunnelSessionTtlMinMs: 3600000,
    tunnelSessionTtlMaxMs: 604800000,
  };

  return createSettingsNormalizationRuntime({ ...defaults, ...overrides });
};

describe('settings normalization runtime - symlink resolution', () => {
  describe('normalizePathForPersistence', () => {
    it('resolves symlinks via realpathSync', () => {
      const runtime = createTestRuntime({
        realpathSync: (p) =>
          p === '/home/user/workplace' ? '/workplace/user' : p,
      });

      const result = runtime.normalizePathForPersistence('/home/user/workplace');
      expect(result).toBe('/workplace/user');
    });

    it('falls back to original path when realpathSync throws', () => {
      const runtime = createTestRuntime({
        realpathSync: () => {
          throw new Error('ENOENT');
        },
      });

      const result = runtime.normalizePathForPersistence('/nonexistent/path');
      expect(result).toBe('/nonexistent/path');
    });

    it('passes through when realpathSync is not provided', () => {
      const runtime = createTestRuntime({ realpathSync: undefined });

      const result = runtime.normalizePathForPersistence('/some/path');
      expect(result).toBe('/some/path');
    });

    it('preserves lowercase colon-prefixed paths on non-Windows platforms', () => {
      const runtime = createTestRuntime({ realpathSync: undefined });

      expect(runtime.normalizePathForPersistence('c:project')).toBe('c:project');
    });

    it('uppercases Windows drive letter before and after realpath resolution', () => {
      const runtime = createTestRuntime({
        processLike: { platform: 'win32', env: {} },
        realpathSync: (p) => {
          // Simulate safeRealpathSync returning a lowercase drive letter
          if (p === 'C:\\Users\\me\\project') return 'c:\\real\\project';
          return p;
        },
      });

      const result = runtime.normalizePathForPersistence('c:\\Users\\me\\project');
      // Drive letter uppercased on input AND after realpath
      expect(result).toBe('C:\\real\\project');
    });
  });

  describe('sanitizeProjects', () => {
    it('resolves symlinks in project paths', () => {
      const runtime = createTestRuntime({
        realpathSync: (p) =>
          p === '/home/user/workplace/MyProject'
            ? '/workplace/user/MyProject'
            : p,
      });

      const projects = [
        { id: 'proj1', path: '/home/user/workplace/MyProject', label: 'MyProject', color: 'primary', addedAt: 1000, lastOpenedAt: 1000 },
      ];

      const result = runtime.sanitizeProjects(projects);
      expect(result[0].path).toBe('/workplace/user/MyProject');
    });

    it('falls back to path.resolve when realpathSync throws', () => {
      const runtime = createTestRuntime({
        realpathSync: () => { throw new Error('ENOENT'); },
        path: { resolve: (p) => '/resolved' + p, sep: '/', dirname: (p) => p.split('/').slice(0, -1).join('/') || '/' },
      });

      const projects = [
        { id: 'proj1', path: '/missing/path', label: 'Missing', color: 'primary', addedAt: 1000, lastOpenedAt: 1000 },
      ];

      const result = runtime.sanitizeProjects(projects);
      expect(result[0].path).toBe('/resolved/missing/path');
    });

    it('keeps a default thinking level next to its model and drops it alone', () => {
      const runtime = createTestRuntime({
        realpathSync: (p) => p,
        path: { resolve: (p) => p, sep: '/', dirname: (p) => p.split('/').slice(0, -1).join('/') || '/' },
      });

      const projects = [
        { id: 'proj1', path: '/a', defaultModel: 'anthropic/claude-opus-5', defaultVariant: 'high' },
        { id: 'proj2', path: '/b', defaultVariant: 'high' },
      ];

      const result = runtime.sanitizeProjects(projects);
      expect(result[0].defaultVariant).toBe('high');
      expect(result[1].defaultVariant).toBe(undefined);
    });

    it('deduplicates projects that resolve to the same realpath', () => {
      const runtime = createTestRuntime({
        realpathSync: (p) => p.startsWith('/symlink') ? '/real/project' : p,
        path: { resolve: (p) => p, sep: '/', dirname: (p) => p.split('/').slice(0, -1).join('/') || '/' },
      });

      const projects = [
        { id: 'proj1', path: '/symlink/a', label: 'A', color: 'primary', addedAt: 1000, lastOpenedAt: 1000 },
        { id: 'proj2', path: '/symlink/b', label: 'B', color: 'keyword', addedAt: 2000, lastOpenedAt: 2000 },
      ];

      const result = runtime.sanitizeProjects(projects);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('proj1');
    });
  });

  describe('normalizeSettingsPaths', () => {
    it('resolves symlinks in lastDirectory', () => {
      const runtime = createTestRuntime({
        realpathSync: (p) =>
          p === '/home/user/workplace/LyraRefactoring'
            ? '/workplace/user/LyraRefactoring'
            : p,
      });

      const result = runtime.normalizeSettingsPaths({
        lastDirectory: '/home/user/workplace/LyraRefactoring',
      });

      expect(result.changed).toBe(true);
      expect(result.settings.lastDirectory).toBe('/workplace/user/LyraRefactoring');
    });

    it('does not flag as changed when path is already canonical', () => {
      const runtime = createTestRuntime();

      const result = runtime.normalizeSettingsPaths({
        lastDirectory: '/real/path',
      });

      expect(result.changed).toBe(false);
    });
  });
});

// issue #1913: on case-insensitive filesystems realpathSync preserves the input
// casing, so a project stored as lowercase never matches the real-case session
// directory. readdir walking recovers the true on-disk casing.
describe('settings normalization runtime - case-insensitive filesystem casing (#1913)', () => {
  const posixPath = {
    resolve: (...args) => args[args.length - 1],
    sep: '/',
    dirname: (p) => p.split('/').slice(0, -1).join('/') || '/',
    join: (...parts) => parts.join('/').replace(/\/+/g, '/'),
  };

  // Directory tree: /Users/me/Desktop/VcFiles/app (true casing).
  const listing = {
    '/': ['Users'],
    '/Users': ['me'],
    '/Users/me': ['Desktop'],
    '/Users/me/Desktop': ['VcFiles'],
    '/Users/me/Desktop/VcFiles': ['app'],
  };
  const readdirSync = (dir) => {
    if (!Object.prototype.hasOwnProperty.call(listing, dir)) throw new Error('ENOENT');
    return listing[dir];
  };

  const darwinRuntime = () => createTestRuntime({
    path: posixPath,
    processLike: { platform: 'darwin', env: {} },
    realpathSync: (p) => p,
    readdirSync,
  });

  it('recovers the on-disk casing when the stored path is lowercase', () => {
    const runtime = darwinRuntime();
    expect(runtime.normalizePathForPersistence('/users/me/desktop/vcfiles/app'))
      .toBe('/Users/me/Desktop/VcFiles/app');
  });

  it('leaves a path that already matches disk casing untouched', () => {
    const runtime = darwinRuntime();
    expect(runtime.normalizePathForPersistence('/Users/me/Desktop/VcFiles/app'))
      .toBe('/Users/me/Desktop/VcFiles/app');
  });

  it('does not rewrite when a component is genuinely missing', () => {
    const runtime = darwinRuntime();
    expect(runtime.normalizePathForPersistence('/Users/me/Desktop/nonexistent/app'))
      .toBe('/Users/me/Desktop/nonexistent/app');
  });

  it('never rewrites case on a case-sensitive filesystem (linux)', () => {
    const runtime = createTestRuntime({
      path: posixPath,
      processLike: { platform: 'linux', env: {} },
      realpathSync: (p) => p,
      readdirSync,
    });
    expect(runtime.normalizePathForPersistence('/users/me/desktop/vcfiles/app'))
      .toBe('/users/me/desktop/vcfiles/app');
  });

  it('normalizeSettingsPaths flags a change so the corrected path is persisted', () => {
    const runtime = darwinRuntime();
    const projects = [{ id: 'a', path: '/users/me/desktop/vcfiles/app', label: 'App' }];
    const result = runtime.normalizeSettingsPaths({ projects });
    expect(result.changed).toBe(true);
    expect(result.settings.projects[0].path).toBe('/Users/me/Desktop/VcFiles/app');
  });
});
