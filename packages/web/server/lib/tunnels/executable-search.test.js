import { describe, expect, it } from 'bun:test';

import {
  createExecutableSearchEnv,
  findExecutableOnPath,
  getExecutableSearchDirectories,
  resolveExecutableLaunchTarget,
} from './executable-search.js';

describe('getExecutableSearchDirectories', () => {
  it('adds the WindowsApps app-alias directory on Windows', () => {
    const directories = getExecutableSearchDirectories({
      platform: 'win32',
      env: {
        PATH: 'C:\\Tools',
        LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
      },
    });

    expect(directories).toContain('C:\\Users\\Ada\\AppData\\Local\\Microsoft\\WindowsApps');
  });

  it('reads Windows Path casing when PATH is not present', () => {
    const directories = getExecutableSearchDirectories({
      platform: 'win32',
      env: {
        Path: 'C:\\Tools;C:\\MoreTools',
        LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
      },
    });

    expect(directories[0]).toBe('C:\\Tools');
    expect(directories[1]).toBe('C:\\MoreTools');
  });
});

describe('findExecutableOnPath', () => {
  it('finds Windows Store app execution aliases even when PATH omits WindowsApps', () => {
    const aliasPath = 'C:\\Users\\Ada\\AppData\\Local\\Microsoft\\WindowsApps\\ngrok.exe';
    const fsLike = {
      statSync: (candidate) => {
        if (candidate === aliasPath) {
          return { isFile: () => true };
        }
        throw new Error('not found');
      },
      accessSync: () => {},
    };

    const resolved = findExecutableOnPath('ngrok', {
      platform: 'win32',
      env: {
        PATH: 'C:\\Tools',
        LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
        PATHEXT: '.EXE;.CMD',
      },
      fsLike,
    });

    expect(resolved).toBe(aliasPath);
  });
});

describe('resolveExecutableLaunchTarget', () => {
  it('returns a Windows launch target with WindowsApps on PATH when stat lookup fails', () => {
    const target = resolveExecutableLaunchTarget('ngrok', {
      platform: 'win32',
      env: {
        PATH: 'C:\\Windows\\System32',
        LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
      },
      fsLike: {
        statSync: () => { throw new Error('EACCES'); },
        accessSync: () => {},
      },
    });

    expect(target?.command).toBe('ngrok');
    expect(target?.env.Path).toContain('C:\\Users\\Ada\\AppData\\Local\\Microsoft\\WindowsApps');
  });
});

describe('createExecutableSearchEnv', () => {
  it('keeps Windows PATH variants in sync', () => {
    const env = createExecutableSearchEnv({
      platform: 'win32',
      env: {
        PATH: 'C:\\Windows\\System32',
        LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
      },
    });

    expect(env.PATH).toBe(env.Path);
    expect(env.path).toBe(env.Path);
  });
});
