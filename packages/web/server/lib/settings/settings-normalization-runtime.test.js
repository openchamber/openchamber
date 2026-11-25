import { describe, expect, it } from 'vitest';

import { createSettingsNormalizationRuntime } from './settings-normalization-runtime.js';

const createTestRuntime = ({ canonicalPathOf, ...overrides } = {}) => {
  const defaults = {
    os: { homedir: () => '/home/testuser' },
    path: {
      resolve: (...args) => args[args.length - 1],
      sep: '/',
      dirname: (p) => p.split('/').slice(0, -1).join('/') || '/',
    },
    processLike: { platform: 'linux', env: {} },
    tunnelBootstrapTtlDefaultMs: 600000,
    tunnelBootstrapTtlMinMs: 60000,
    tunnelBootstrapTtlMaxMs: 3600000,
    tunnelSessionTtlDefaultMs: 86400000,
    tunnelSessionTtlMinMs: 3600000,
    tunnelSessionTtlMaxMs: 604800000,
  };

  return createSettingsNormalizationRuntime({ ...defaults, ...overrides, canonicalPaths: canonicalPathOf && { of: canonicalPathOf, refresh: async () => {} } });
};

describe('settings normalization runtime - symlink resolution', () => {
  describe('normalizePathForPersistence', () => {
    it('stores the canonical path', () => {
      const runtime = createTestRuntime({
        canonicalPathOf: (p) =>
          p === '/home/user/workplace' ? '/workplace/user' : p,
      });

      const result = runtime.normalizePathForPersistence('/home/user/workplace');
      expect(result).toBe('/workplace/user');
    });

    it('passes through when no canonical path is known', () => {
      const runtime = createTestRuntime({ canonicalPathOf: undefined });

      const result = runtime.normalizePathForPersistence('/some/path');
      expect(result).toBe('/some/path');
    });

    it('preserves lowercase colon-prefixed paths on non-Windows platforms', () => {
      const runtime = createTestRuntime({ canonicalPathOf: undefined });

      expect(runtime.normalizePathForPersistence('c:project')).toBe('c:project');
    });

    it('uppercases Windows drive letter before and after realpath resolution', () => {
      const runtime = createTestRuntime({
        processLike: { platform: 'win32', env: {} },
        canonicalPathOf: (p) => {
          // A resolver can answer with a lowercase drive letter
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
        canonicalPathOf: (p) =>
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

    it('keeps a default thinking level next to its model and drops it alone', () => {
      const runtime = createTestRuntime({
        canonicalPathOf: (p) => p,
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

    it('keeps a project default agent', () => {
      const runtime = createTestRuntime({
        canonicalPathOf: (p) => p,
        path: { resolve: (p) => p, sep: '/', dirname: (p) => p.split('/').slice(0, -1).join('/') || '/' },
      });

      const result = runtime.sanitizeProjects([
        { id: 'proj1', path: '/a', defaultAgent: 'plan' },
      ]);

      expect(result[0].defaultAgent).toBe('plan');
    });

    it('keeps the label source next to the label it describes', () => {
      const runtime = createTestRuntime();

      const result = runtime.sanitizeProjects([
        { id: 'proj1', path: '/a', label: 'Example', labelSource: 'manual' },
        { id: 'proj2', path: '/b', label: 'Billing', labelSource: 'nonsense' },
        { id: 'proj3', path: '/c', labelSource: 'manual' },
        { id: 'proj4', path: '/d', label: 'd', labelSource: 'auto' },
      ]);

      expect(result[0].labelSource).toBe('manual');
      expect(result[1].labelSource).toBe(undefined);
      expect(result[2].labelSource).toBe(undefined);
      expect(result[3].labelSource).toBe('auto');
      expect(runtime.sanitizeProjects(JSON.parse(JSON.stringify(result)))).toEqual(result);
    });

    it('deduplicates projects that resolve to the same realpath', () => {
      const runtime = createTestRuntime({
        canonicalPathOf: (p) => p.startsWith('/symlink') ? '/real/project' : p,
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
        canonicalPathOf: (p) =>
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
