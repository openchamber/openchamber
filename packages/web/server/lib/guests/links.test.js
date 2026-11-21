import { describe, expect, test } from 'bun:test';

import { toPublicLinks } from './links.js';

describe('toPublicLinks', () => {
  test('serves literal keys and compiled link patterns, never a template it cannot fill', () => {
    const row = toPublicLinks({
      action: 'open',
      identifier: { keys: ['DEMO'] },
      urls: { origin: 'https://tasks.example.com', identifier: 'key-number', item: ['/{segments+}/c/{id}', '/tasks/{id}', '/browse?selectedIssue={id}'] },
    });
    expect(row.action).toBe('open');
    expect(row.keys).toEqual(['DEMO']);
    expect(row.urls.origin).toBe('https://tasks.example.com');
    expect(row.urls.identifierPattern).toBe('^[A-Za-z][A-Za-z0-9_]{0,31}-\\d{1,16}$');
    expect(row.urls.patterns).toEqual([
      { path: '^/[^/]{1,256}(?:/[^/]{1,256}){0,19}/c/([A-Za-z][A-Za-z0-9_]{0,31}-\\d{1,16})(?:/|$)' },
      { path: '^/tasks/([A-Za-z][A-Za-z0-9_]{0,31}-\\d{1,16})(?:/|$)' },
      { path: '^/browse(?:/|$)', query: { name: 'selectedIssue' } },
    ]);
    expect(row.urls.itemTemplate).toBe('/tasks/{id}');
  });

  test('a package with keys only has no urls, and one with segment templates only has no item template', () => {
    expect(toPublicLinks({ action: 'open', identifier: { keys: ['DEMO'] } })).toEqual({ action: 'open', keys: ['DEMO'], urls: null });
    expect(toPublicLinks({ action: 'open', urls: { origin: 'https://x.example.com', identifier: 'number', item: ['/{segment}/{id}'] } }).urls.itemTemplate).toBeNull();
  });

  test('throws on a template the compiler refuses, which the catalog turns into no links for that row', () => {
    expect(() => toPublicLinks({ action: 'open', urls: { origin: 'https://x.example.com', identifier: 'number', item: ['/(.*)'] } })).toThrow();
  });
});
