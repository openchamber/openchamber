import { describe, expect, test } from 'bun:test';

import { getUrlScheme, isAppLinkUrl } from '@/lib/url';

describe('getUrlScheme', () => {
  test('extracts the lowercased scheme', () => {
    expect(getUrlScheme('Obsidian://open?vault=X')).toBe('obsidian');
    expect(getUrlScheme('https://example.test')).toBe('https');
  });

  test('returns null for unparseable values', () => {
    expect(getUrlScheme('')).toBeNull();
    expect(getUrlScheme('not a url')).toBeNull();
  });
});

describe('isAppLinkUrl', () => {
  test('accepts custom application schemes', () => {
    expect(isAppLinkUrl('obsidian://open?vault=Notebook&file=a%20b')).toBe(true);
    expect(isAppLinkUrl('vscode://file/path/to/file.ts')).toBe(true);
    expect(isAppLinkUrl('linear://issue/ABC-1')).toBe(true);
    expect(isAppLinkUrl('notion://note/xyz')).toBe(true);
    expect(isAppLinkUrl('slack://channel?id=C123')).toBe(true);
  });

  test('rejects browser and communication schemes', () => {
    expect(isAppLinkUrl('https://example.test')).toBe(false);
    expect(isAppLinkUrl('http://example.test')).toBe(false);
    expect(isAppLinkUrl('mailto:user@example.test')).toBe(false);
    expect(isAppLinkUrl('tel:+1234567890')).toBe(false);
    expect(isAppLinkUrl('sms:+1234567890')).toBe(false);
    expect(isAppLinkUrl('webcal://example.test/cal.ics')).toBe(false);
  });

  test('rejects dangerous and internal schemes', () => {
    expect(isAppLinkUrl('javascript:alert(1)')).toBe(false);
    expect(isAppLinkUrl('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
    expect(isAppLinkUrl('vbscript:msgbox(1)')).toBe(false);
    expect(isAppLinkUrl('blob:https://example.test/uuid')).toBe(false);
    expect(isAppLinkUrl('about:blank')).toBe(false);
    expect(isAppLinkUrl('file:///etc/passwd')).toBe(false);
    expect(isAppLinkUrl('ws://localhost:8080')).toBe(false);
    expect(isAppLinkUrl('ftp://files.example.test')).toBe(false);
    expect(isAppLinkUrl('intent://scan/#Intent;scheme=zxing;end')).toBe(false);
    expect(isAppLinkUrl('chrome://settings')).toBe(false);
    expect(isAppLinkUrl('devtools://devtools/bundled/inspector.html')).toBe(false);
    expect(isAppLinkUrl('ms-msdt:/id%20PCWDiagnostic')).toBe(false);
    expect(isAppLinkUrl('search-ms:query=report')).toBe(false);
    expect(isAppLinkUrl('shell:AppsFolder')).toBe(false);
  });

  test('rejects OpenChamber and Capacitor self-deep-links', () => {
    expect(isAppLinkUrl('openchamber://connect?host=x')).toBe(false);
    expect(isAppLinkUrl('openchamber-ui://app/index.html')).toBe(false);
    expect(isAppLinkUrl('capacitor://localhost/index.html')).toBe(false);
  });

  test('rejects malformed input', () => {
    expect(isAppLinkUrl('')).toBe(false);
    expect(isAppLinkUrl('random text')).toBe(false);
  });
});
