import { describe, expect, test } from 'bun:test';

import { findJsonSyntaxError, isLintedJsonPath } from './jsonSyntaxLint';

describe('JSON syntax check', () => {
  test('checks JSON and JSONC files only', () => {
    expect(isLintedJsonPath('/repo/package.json')).toBe(true);
    expect(isLintedJsonPath('/repo/.vscode/settings.jsonc')).toBe(true);
    expect(isLintedJsonPath('/repo/data.jsonl')).toBe(false);
    expect(isLintedJsonPath('/repo/config.json5')).toBe(false);
    expect(isLintedJsonPath('/repo/json')).toBe(false);
  });

  test('leaves comment-like text inside strings alone', () => {
    expect(findJsonSyntaxError('{"url": "http://example.com", "glob": "a/*b*/c", "q": "\\"//"}')).toBeNull();
  });

  test('points at the error on its own line after comments and trailing commas', () => {
    const text = '{\n  // note\n  "a": [1, 2,], /* x */\n  "b" 2\n}';
    expect(findJsonSyntaxError(text)).toBe(text.indexOf('2\n}'));
  });

  test('passes valid JSON, JSONC and an empty file', () => {
    expect(findJsonSyntaxError('{"a": [1, 2, {"b": null}], "c": "d"}')).toBeNull();
    expect(findJsonSyntaxError('{\n  // c\n  "a": 1,\n}')).toBeNull();
    expect(findJsonSyntaxError('  \n')).toBeNull();
  });

  test('points at the first place the JSON breaks', () => {
    const missingComma = '{\n  "a": 1\n  "b": 2\n}';
    expect(findJsonSyntaxError(missingComma)).toBe(missingComma.indexOf('"b"'));
    const unclosed = '{"a": [1, 2}';
    expect(findJsonSyntaxError(unclosed)).not.toBeNull();
    expect(findJsonSyntaxError("{'a': 1}")).not.toBeNull();
  });
});
