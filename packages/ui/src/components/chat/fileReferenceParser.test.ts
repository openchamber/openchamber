import { describe, expect, test } from 'bun:test';

import { localPathFromFileUrl, normalizeReferencePath, parseFileReference } from './fileReferenceParser';

const parse = parseFileReference;

describe('parseFileReference', () => {
  test('returns null for empty or whitespace input', () => {
    expect(parse('')).toBeNull();
    expect(parse('   ')).toBeNull();
  });

  test('parses bare path', () => {
    expect(parse('src/foo.ts')).toEqual({ path: 'src/foo.ts' });
  });

  test('parses path with single line', () => {
    expect(parse('src/foo.ts:42')).toEqual({ path: 'src/foo.ts', line: 42 });
  });

  test('parses path with line and column', () => {
    expect(parse('src/foo.ts:42:8')).toEqual({ path: 'src/foo.ts', line: 42, column: 8 });
  });

  test('parses path with line range', () => {
    expect(parse('src/foo.ts:42-58')).toEqual({ path: 'src/foo.ts', line: 42, endLine: 58 });
  });

  test('parses path with single-line range (start equals end)', () => {
    expect(parse('src/foo.ts:10-10')).toEqual({ path: 'src/foo.ts', line: 10, endLine: 10 });
  });

  test('rejects range with end before start', () => {
    expect(parse('src/foo.ts:20-10')).toBeNull();
  });

  test('falls back to path-only when range endpoint is non-numeric', () => {
    expect(parse('src/foo.ts:10-abc')).toEqual({ path: 'src/foo.ts' });
    expect(parse('src/foo.ts:abc-20')).toEqual({ path: 'src/foo.ts' });
  });

  test('strips backtick and quote wrapping from range forms', () => {
    expect(parse('`src/foo.ts:10-20`')).toEqual({ path: 'src/foo.ts', line: 10, endLine: 20 });
    expect(parse('"src/foo.ts:1-3"')).toEqual({ path: 'src/foo.ts', line: 1, endLine: 3 });
  });

  test('parses absolute Windows path with line range', () => {
    expect(parse('C:/repo/src/foo.ts:5-9')).toEqual({ path: 'C:/repo/src/foo.ts', line: 5, endLine: 9 });
  });

  test('preserves line:col form (does not interpret as range)', () => {
    expect(parse('src/foo.ts:42:8')).toEqual({ path: 'src/foo.ts', line: 42, column: 8 });
  });

  test('preserves hash form', () => {
    expect(parse('src/foo.ts#L42C8')).toEqual({ path: 'src/foo.ts', line: 42, column: 8 });
    expect(parse('src/foo.ts#L42')).toEqual({ path: 'src/foo.ts', line: 42 });
  });

  test('range form takes precedence over line-only when suffix matches digits-dash-digits', () => {
    expect(parse('src/foo.ts:42-58')).toEqual({ path: 'src/foo.ts', line: 42, endLine: 58 });
  });
});

describe('localPathFromFileUrl', () => {
  test('converts local file URLs to absolute paths', () => {
    expect(localPathFromFileUrl('file:///private/tmp/report%20viewer.html')).toBe('/private/tmp/report viewer.html');
    expect(localPathFromFileUrl('file://localhost/private/tmp/REPORT.md')).toBe('/private/tmp/REPORT.md');
    expect(localPathFromFileUrl('file:///C:/Users/test/report.html')).toBe('C:/Users/test/report.html');
  });

  test('rejects non-file URLs and remote file hosts', () => {
    expect(localPathFromFileUrl('https://example.com/report.html')).toBeNull();
    expect(localPathFromFileUrl('file://remote-host/share/report.html')).toBeNull();
    expect(localPathFromFileUrl('file:///tmp/bad%ZZpath')).toBeNull();
  });
});

describe('bare Windows drive reference resolution', () => {
  test('drops the leading slash a bare /C:/ markdown href carries', () => {
    const parsed = parseFileReference('/C:/example/project/package.json');
    expect(parsed).not.toBeNull();
    if (!parsed) throw new Error('Expected a Windows file reference');
    expect(normalizeReferencePath(parsed.path)).toBe('C:/example/project/package.json');
  });
});
