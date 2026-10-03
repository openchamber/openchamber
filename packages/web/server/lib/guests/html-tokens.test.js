import { describe, expect, test } from 'bun:test';

import {
  injectGuestAssetTokens,
  listRelativeGuestScriptHrefs,
  parseGuestUrlToken,
  resolveGuestHtmlRelativePath,
} from './html-tokens.js';

describe('parseGuestUrlToken', () => {
  test('reads a string or the first array entry', () => {
    expect(parseGuestUrlToken('abc')).toBe('abc');
    expect(parseGuestUrlToken(['abc', 'def'])).toBe('abc');
    expect(parseGuestUrlToken(undefined)).toBe('');
    expect(parseGuestUrlToken('')).toBe('');
  });
});

describe('listRelativeGuestScriptHrefs', () => {
  test('keeps relative scripts and drops remote ones', () => {
    expect(listRelativeGuestScriptHrefs(
      '<script src="./main.js"></script><script src="https://cdn.example/a.js"></script>',
    )).toEqual(['./main.js']);
    expect(listRelativeGuestScriptHrefs('')).toEqual([]);
  });
});

describe('resolveGuestHtmlRelativePath', () => {
  test('resolves against the entry file and blocks escape', () => {
    expect(resolveGuestHtmlRelativePath('panel/index.html', './main.js')).toBe('panel/main.js');
    expect(resolveGuestHtmlRelativePath('panel/index.html', 'main.js?oc_url_token=x')).toBe('panel/main.js');
    expect(resolveGuestHtmlRelativePath('panel/index.html', '../secret.js')).toBe('secret.js');
    expect(resolveGuestHtmlRelativePath('panel/index.html', '../../outside.js')).toBeNull();
    expect(resolveGuestHtmlRelativePath('index.html', './panel/main.js')).toBe('panel/main.js');
  });
});

describe('injectGuestAssetTokens', () => {
  test('adds the token to a relative script src', () => {
    expect(injectGuestAssetTokens('<script src="./main.js"></script>', 'tok/en'))
      .toBe('<script src="./main.js?oc_url_token=tok%2Fen"></script>');
  });

  test('leaves absolute and data urls alone', () => {
    const html = '<script src="https://cdn.example/a.js"></script><img src="data:image/svg+xml,x">';
    expect(injectGuestAssetTokens(html, 'tok')).toBe(html);
  });

  test('does not duplicate an existing token', () => {
    expect(injectGuestAssetTokens('<script src="./main.js?oc_url_token=old"></script>', 'new'))
      .toBe('<script src="./main.js?oc_url_token=old"></script>');
  });
});
