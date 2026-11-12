import { describe, expect, test } from 'bun:test';
import * as spec from './plugin-spec.js';

describe('parseNpmSpec', () => {
  test('unscoped: no version', () => {
    expect(spec.parseNpmSpec('foo')).toEqual({ name: 'foo', version: null });
  });

  test('unscoped: exact version', () => {
    expect(spec.parseNpmSpec('foo@1.2.3')).toEqual({ name: 'foo', version: '1.2.3' });
  });

  test('unscoped: range version', () => {
    expect(spec.parseNpmSpec('foo@^1.2.0')).toEqual({ name: 'foo', version: '^1.2.0' });
  });

  test('unscoped: dist-tag', () => {
    expect(spec.parseNpmSpec('foo@latest')).toEqual({ name: 'foo', version: 'latest' });
  });

  test('scoped: no version', () => {
    expect(spec.parseNpmSpec('@scope/foo')).toEqual({ name: '@scope/foo', version: null });
  });

  test('scoped: exact version', () => {
    expect(spec.parseNpmSpec('@scope/foo@1.2.3')).toEqual({ name: '@scope/foo', version: '1.2.3' });
  });

  test('scoped: dist-tag', () => {
    expect(spec.parseNpmSpec('@scope/foo@beta')).toEqual({ name: '@scope/foo', version: 'beta' });
  });

  test('malformed: empty string', () => {
    expect(spec.parseNpmSpec('')).toEqual({ malformed: true, raw: '' });
  });

  test('malformed: bare @', () => {
    expect(spec.parseNpmSpec('@')).toEqual({ malformed: true, raw: '@' });
  });

  test('malformed: @@', () => {
    expect(spec.parseNpmSpec('@@')).toEqual({ malformed: true, raw: '@@' });
  });

  test('malformed: empty version after @', () => {
    expect(spec.parseNpmSpec('foo@')).toEqual({ malformed: true, raw: 'foo@' });
  });

  test('malformed: scoped empty name after slash', () => {
    expect(spec.parseNpmSpec('@scope/')).toEqual({ malformed: true, raw: '@scope/' });
  });

  test('malformed: scoped empty version', () => {
    expect(spec.parseNpmSpec('@scope/foo@')).toEqual({ malformed: true, raw: '@scope/foo@' });
  });

  test('malformed: null input', () => {
    expect(spec.parseNpmSpec(null)).toEqual({ malformed: true, raw: 'null' });
  });

  test('malformed: undefined input', () => {
    expect(spec.parseNpmSpec(undefined)).toEqual({ malformed: true, raw: 'undefined' });
  });

  test('malformed: number input', () => {
    expect(spec.parseNpmSpec(42)).toEqual({ malformed: true, raw: '42' });
  });

  test('malformed: array input', () => {
    expect(spec.parseNpmSpec(['foo'])).toEqual({ malformed: true, raw: 'foo' });
  });

  test('malformed: object input', () => {
    expect(spec.parseNpmSpec({})).toEqual({ malformed: true, raw: '[object Object]' });
  });
});

describe('isExactSemver', () => {
  test('plain semver', () => {
    expect(spec.isExactSemver('1.2.3')).toBe(true);
  });

  test('semver with pre-release', () => {
    expect(spec.isExactSemver('1.2.3-beta.1')).toBe(true);
  });

  test('semver with build metadata', () => {
    expect(spec.isExactSemver('1.2.3+build.5')).toBe(true);
  });

  test('range: caret', () => {
    expect(spec.isExactSemver('^1.2.0')).toBe(false);
  });

  test('dist-tag', () => {
    expect(spec.isExactSemver('latest')).toBe(false);
  });

  test('empty string', () => {
    expect(spec.isExactSemver('')).toBe(false);
  });

  test('partial: major.minor only', () => {
    expect(spec.isExactSemver('1.2')).toBe(false);
  });

  test('partial: major only', () => {
    expect(spec.isExactSemver('1')).toBe(false);
  });
});

describe('parsePathSpec', () => {
  test('identifies Windows absolute paths as path specs', () => {
    expect(spec.isPathSpec('C:\\Users\\me\\plugin.js')).toBe(true);
    expect(spec.isPathSpec('\\\\server\\share\\plugin.js')).toBe(true);
    expect(spec.isPathSpec('@scope/plugin')).toBe(false);
  });

  test('tilde home shorthand with subpath', () => {
    expect(spec.parsePathSpec('~/x.js', { homedir: '/home/u', cwd: '/p' })).toEqual({
      absolutePath: '/home/u/x.js',
    });
  });

  test('bare tilde = homedir', () => {
    expect(spec.parsePathSpec('~', { homedir: '/home/u', cwd: '/p' })).toEqual({
      absolutePath: '/home/u',
    });
  });

  test('relative ./', () => {
    expect(spec.parsePathSpec('./x.js', { homedir: '/home/u', cwd: '/p' })).toEqual({
      absolutePath: '/p/x.js',
    });
  });

  test('relative ../', () => {
    expect(spec.parsePathSpec('../x.js', { homedir: '/home/u', cwd: '/p/a' })).toEqual({
      absolutePath: '/p/x.js',
    });
  });

  test('absolute path passthrough', () => {
    expect(spec.parsePathSpec('/abs/x.js', { homedir: '/home/u', cwd: '/p' })).toEqual({
      absolutePath: '/abs/x.js',
    });
  });

  test('Windows absolute path passthrough', () => {
    expect(spec.parsePathSpec('C:\\Users\\me\\plugin.js', { homedir: '/home/u', cwd: '/p' })).toEqual({
      absolutePath: 'C:\\Users\\me\\plugin.js',
    });
  });
});

describe('isGitSpec', () => {
  test('accepts the hosted shortcuts npm and OpenCode document', () => {
    expect(spec.isGitSpec('github:acme/opencode-plugin')).toBe(true);
    expect(spec.isGitSpec('gitlab:acme/opencode-plugin')).toBe(true);
    expect(spec.isGitSpec('bitbucket:acme/opencode-plugin')).toBe(true);
    expect(spec.isGitSpec('gist:acme/1a2b3c')).toBe(true);
  });

  test('accepts a hosted shortcut with a ref and a subdirectory', () => {
    expect(spec.isGitSpec('github:acme/plugins#main::path:packages/opencode-plugin')).toBe(true);
  });

  test('accepts the git+ transport forms', () => {
    expect(spec.isGitSpec('git+https://github.com/acme/opencode-plugin.git#main')).toBe(true);
    expect(spec.isGitSpec('git+ssh://git@github.com/acme/opencode-plugin.git#main')).toBe(true);
    expect(spec.isGitSpec('git+file:///srv/plugins/opencode-plugin')).toBe(true);
    expect(spec.isGitSpec('git://github.com/acme/opencode-plugin.git')).toBe(true);
  });

  test('does not claim npm specs, paths, or a bare URL', () => {
    expect(spec.isGitSpec('foo')).toBe(false);
    expect(spec.isGitSpec('@scope/foo@1.2.3')).toBe(false);
    expect(spec.isGitSpec('/abs/plugin.js')).toBe(false);
    expect(spec.isGitSpec('./local.js')).toBe(false);
    // A bare https URL is not one of the documented git forms.
    expect(spec.isGitSpec('https://github.com/acme/opencode-plugin.git')).toBe(false);
  });
});

describe('parsedKindForSpec', () => {
  test('classifies a git spec as its own kind, not npm', () => {
    // Without this a Git spec fell through to the npm branch, which queried
    // the registry with the literal spec and reported it unreachable.
    expect(spec.parsedKindForSpec('github:acme/opencode-plugin')).toBe('git');
    expect(spec.parsedKindForSpec('git+ssh://git@github.com/acme/plugin.git#main')).toBe('git');
  });

  test('classifies OpenCode 2 control entries, which name no package', () => {
    expect(spec.parsedKindForSpec('-hooks')).toBe('control');
    expect(spec.parsedKindForSpec('-opencode.browser')).toBe('control');
    expect(spec.parsedKindForSpec('-*')).toBe('control');
    expect(spec.parsedKindForSpec('*')).toBe('control');
    expect(spec.parsedKindForSpec('acme.*')).toBe('control');
    expect(spec.parsedKindForSpec('opencode.browser')).toBe('control');
    // OpenCode rejects a lone `-`, so it stays an (invalid) package spec.
    expect(spec.parsedKindForSpec('-')).toBe('npm');
  });

  test('keeps paths and npm specs on their existing kinds', () => {
    expect(spec.parsedKindForSpec('/abs/plugin.js')).toBe('path');
    expect(spec.parsedKindForSpec('./local.js')).toBe('path');
    expect(spec.parsedKindForSpec('@scope/foo@1.2.3')).toBe('npm');
    expect(spec.parsedKindForSpec('foo')).toBe('npm');
  });
});
