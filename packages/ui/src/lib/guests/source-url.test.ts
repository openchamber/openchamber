import { describe, expect, test } from 'bun:test';
import type { InstalledGuest } from './types';
import { getGuestSourceUrl } from './source-url';

const guest: InstalledGuest = {
  id: 'demo', name: 'Demo', icon: 'apps', source: 'git',
  capabilities: { requested: [], granted: [] },
};

describe('extension source links', () => {
  test('opens HTTPS and SSH clone URLs as web repositories', () => {
    for (const [url, expected] of [
    ['https://github.com/acme/demo.git', 'https://github.com/acme/demo'],
    ['https://gitlab.com/acme/group/demo.git/#main', 'https://gitlab.com/acme/group/demo'],
    ['git@github.com:acme/demo.git', 'https://github.com/acme/demo'],
    ['github.com:acme/demo.git#main', 'https://github.com/acme/demo'],
    ['ssh://git@gitlab.com:2222/acme/group/demo.git', 'https://gitlab.com/acme/group/demo'],
    ['https://user:password@example.com:8443/demo.git?token=secret#main', 'https://example.com:8443/demo'],
    ]) {
      expect(getGuestSourceUrl({ ...guest, origin: { url, ref: 'main' } })).toBe(expected);
    }
  });

  test('rejects invalid or non-web origins', () => {
    for (const url of ['javascript:alert(1)', 'file:///tmp/demo.git', '/tmp/demo', 'https://github.com', 'not a url']) {
      expect(getGuestSourceUrl({ ...guest, origin: { url } })).toBeNull();
    }
  });

  test('requires a Git install and a recorded origin', () => {
    expect(getGuestSourceUrl(guest)).toBeNull();
    for (const source of ['path', 'zip', 'bundled'] as const) {
      expect(getGuestSourceUrl({ ...guest, source, origin: { url: 'https://github.com/acme/demo.git' } })).toBeNull();
    }
  });
});
