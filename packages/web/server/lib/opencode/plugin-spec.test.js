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
});
