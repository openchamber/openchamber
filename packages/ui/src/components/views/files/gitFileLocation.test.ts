import { describe, expect, test } from 'bun:test';

import { resolveGitFileLocation } from './gitFileLocation';

const withPrefix = (prefix: string) => async () => prefix;

describe('resolveGitFileLocation', () => {
  test('resolves a file at its repository root', async () => {
    expect(await resolveGitFileLocation('/workspace/app.ts', withPrefix(''))).toEqual({
      directory: '/workspace',
      path: 'app.ts',
    });
  });

  test('derives the repository root and relative path from a nested directory prefix', async () => {
    expect(await resolveGitFileLocation('/workspace/backend/src/server.ts', withPrefix('src'))).toEqual({
      directory: '/workspace/backend',
      path: 'src/server.ts',
    });
  });

  test('uses the innermost repository reported for a deeply nested file', async () => {
    expect(await resolveGitFileLocation(
      '/workspace/app/vendor/lib/src/index.ts',
      withPrefix('src'),
    )).toEqual({
      directory: '/workspace/app/vendor/lib',
      path: 'src/index.ts',
    });
  });

  test('supports a repository located at the filesystem root', async () => {
    expect(await resolveGitFileLocation('/src/app.ts', withPrefix('src'))).toEqual({
      directory: '/',
      path: 'src/app.ts',
    });
  });

  test('supports a repository located at a Windows drive root', async () => {
    expect(await resolveGitFileLocation('C:\\src\\app.ts', withPrefix('src'))).toEqual({
      directory: 'C:/',
      path: 'src/app.ts',
    });
  });

  test('normalizes Windows separators and compares paths without case sensitivity', async () => {
    expect(await resolveGitFileLocation(
      'c:\\Work\\Backend\\src\\server.ts',
      withPrefix('SRC'),
    )).toEqual({
      directory: 'c:/Work/Backend',
      path: 'SRC/server.ts',
    });
  });

  test('rejects a prefix that does not describe the file directory', async () => {
    expect(await resolveGitFileLocation('/workspace/app.ts', withPrefix('other'))).toBeNull();
  });
});
