import { describe, expect, test } from 'bun:test';
import { isSpaceDirectory, spaceDirectoryHeaders, spaceIdOfDirectory, spaceRootDirectory } from './space-route';

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

describe('spaceDirectoryHeaders', () => {
  test('names a space directory in the directory header, URI-encoded and marked, and nothing else', () => {
    expect(spaceDirectoryHeaders(`/spaces/${ID}/my repo`)).toEqual({
      'x-opencode-directory': encodeURIComponent(`/spaces/${ID}/my repo`),
      'x-opencode-directory-encoding': 'uri',
    });
    expect(spaceDirectoryHeaders('/home/me/project')).toBeNull();
    expect(spaceDirectoryHeaders(`/home/spaces/${ID}`)).toBeNull();
    expect(spaceDirectoryHeaders(null)).toBeNull();
    expect(spaceRootDirectory(ID)).toBe(`/spaces/${ID}`);
  });

  test('adds nothing in VS Code, which never gets the feature', () => {
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { __VSCODE_CONFIG__: { workspaceFolder: '/home/me' } } });
    try {
      expect(spaceDirectoryHeaders(`/spaces/${ID}/repo`)).toBeNull();
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    }
  });
});
