import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createFsSearchRuntime } from './search.js';

const file = (name) => ({
  name,
  isDirectory: () => false,
  isFile: () => true,
});

describe('filesystem search Git ignore ownership', () => {
  it('filters candidates through the classified Git service dependency', async () => {
    const getIgnoredPaths = vi.fn(async () => ['ignored.txt']);
    const runtime = createFsSearchRuntime({
      fsPromises: {
        readdir: vi.fn(async () => [file('ignored.txt'), file('kept.txt')]),
      },
      path: path.posix,
      getIgnoredPaths,
    });

    const result = await runtime.searchFilesystemFiles('/repo', {
      limit: 10,
      query: '',
      includeHidden: false,
      respectGitignore: true,
    });

    expect(getIgnoredPaths).toHaveBeenCalledWith('/repo', ['ignored.txt', 'kept.txt']);
    expect(result.map((entry) => entry.name)).toEqual(['kept.txt']);
  });

  it('preserves display-only search results when ignore lookup fails', async () => {
    const runtime = createFsSearchRuntime({
      fsPromises: {
        readdir: vi.fn(async () => [file('kept.txt')]),
      },
      path: path.posix,
      getIgnoredPaths: vi.fn(async () => { throw new Error('git unavailable'); }),
    });

    const result = await runtime.searchFilesystemFiles('/repo', {
      limit: 10,
      query: '',
      includeHidden: false,
      respectGitignore: true,
    });

    expect(result.map((entry) => entry.name)).toEqual(['kept.txt']);
  });
});
