import { describe, expect, test } from 'bun:test';

import { parseCodeReferences, splitCodeReferences } from './codeReferences';

describe('parseCodeReferences', () => {
  test('reads a path with a line number', () => {
    expect(parseCodeReferences('broken since src/foo.ts:42 landed')).toEqual([
      { text: 'src/foo.ts:42', filePath: 'src/foo.ts', line: 42 },
    ]);
  });

  test('reads a deep path without a line number', () => {
    expect(parseCodeReferences('see packages/ui/src/lib/x.tsx for the mapping')).toEqual([
      { text: 'packages/ui/src/lib/x.tsx', filePath: 'packages/ui/src/lib/x.tsx', line: null },
    ]);
  });

  test('reads a single file name with a known code extension', () => {
    expect(parseCodeReferences('the list lives in scanner.js')).toEqual([
      { text: 'scanner.js', filePath: 'scanner.js', line: null },
    ]);
  });

  test('reads several references in one text, in order', () => {
    const references = parseCodeReferences('start at src/a.ts:1 then src/b/index.tsx');
    expect(references).toEqual([
      { text: 'src/a.ts:1', filePath: 'src/a.ts', line: 1 },
      { text: 'src/b/index.tsx', filePath: 'src/b/index.tsx', line: null },
    ]);
  });

  test('keeps punctuation around a reference out of it', () => {
    expect(parseCodeReferences('(see src/foo.ts:7), thanks')).toEqual([
      { text: 'src/foo.ts:7', filePath: 'src/foo.ts', line: 7 },
    ]);
  });

  test('rejects version numbers', () => {
    expect(parseCodeReferences('released in v1.2.3 yesterday')).toBeNull();
    expect(parseCodeReferences('costs 3.14 dollars')).toBeNull();
  });

  test('rejects plain words', () => {
    expect(parseCodeReferences('nothing to see here')).toBeNull();
    expect(parseCodeReferences('the README.md explains it')).toBeNull();
  });

  test('rejects file paths inside URLs', () => {
    expect(parseCodeReferences('docs at https://example.com/path/file.ts explain it')).toBeNull();
    expect(parseCodeReferences('clone from https://example.com/a/b/c.ts')).toBeNull();
  });

  test('rejects a path whose extension runs on', () => {
    expect(parseCodeReferences('the file src/foo.tsjson is a mistake')).toBeNull();
    expect(parseCodeReferences('the file src/foo.ts. is trailing')).toBeNull();
  });

  test('returns null for empty text', () => {
    expect(parseCodeReferences('')).toBeNull();
  });
});

describe('splitCodeReferences', () => {
  test('splits a text into text and reference segments', () => {
    expect(splitCodeReferences('fix src/a.ts:2 first')).toEqual([
      { kind: 'text', value: 'fix ' },
      { kind: 'reference', reference: { text: 'src/a.ts:2', filePath: 'src/a.ts', line: 2 } },
      { kind: 'text', value: ' first' },
    ]);
  });

  test('returns null when nothing matches', () => {
    expect(splitCodeReferences('no references')).toBeNull();
  });
});
