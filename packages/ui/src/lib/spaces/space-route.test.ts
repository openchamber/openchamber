import { describe, expect, test } from 'bun:test';
import { isSpaceDirectory, spaceApiPath, spaceIdOfDirectory } from './space-route';

const ID = 'a1b2c3d4e5f6';

describe('spaceIdOfDirectory', () => {
  const cases: Array<[string | null | undefined, string | null]> = [
    [`/spaces/${ID}/repo`, ID],
    [`/spaces/${ID}`, ID],
    [`/spaces/${ID}/repo/src`, ID],
    ['/home/me/project', null],
    [`/spaces/${ID}x/repo`, null],
    [`/spaces/${ID.slice(0, 11)}/repo`, null],
    [`/home/spaces/${ID}/repo`, null],
    ['', null],
    [null, null],
    [undefined, null],
  ];

  test('names the space of a directory under /spaces/<id>, and nothing else', () => {
    for (const [directory, expected] of cases) {
      expect(spaceIdOfDirectory(directory)).toBe(expected);
      expect(isSpaceDirectory(directory)).toBe(expected !== null);
    }
  });
});

describe('spaceApiPath', () => {
  test('prefixes an /api/ path for a space directory and leaves everything else alone', () => {
    expect(spaceApiPath('/api/session', `/spaces/${ID}/repo`)).toBe(`/api/spaces/${ID}/session`);
    expect(spaceApiPath('/api/git/status?directory=x', `/spaces/${ID}/repo`)).toBe(`/api/spaces/${ID}/git/status?directory=x`);
    expect(spaceApiPath('/api/session', '/home/me/project')).toBe('/api/session');
    expect(spaceApiPath('/api/session', null)).toBe('/api/session');
    expect(spaceApiPath(`/api/spaces/${ID}/session`, `/spaces/${ID}/repo`)).toBe(`/api/spaces/${ID}/session`);
    expect(spaceApiPath('/health', `/spaces/${ID}/repo`)).toBe('/health');
    expect(spaceApiPath('/auth/session', `/spaces/${ID}/repo`)).toBe('/auth/session');
  });
});
