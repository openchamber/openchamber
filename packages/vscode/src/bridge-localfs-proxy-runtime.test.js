import { describe, expect, it, mock } from 'bun:test';

mock.module('fs', () => ({
  promises: {
    realpath: mock(async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }),
    stat: mock(async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }),
  },
  default: {
    promises: {
      realpath: mock(async () => {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }),
      stat: mock(async () => {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }),
    },
  },
}));

mock.module('vscode', () => ({
  Uri: {
    file: (fsPath) => ({ fsPath }),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
  },
}));

const { tryHandleLocalFsProxy } = await import('./bridge-localfs-proxy-runtime');

describe('bridge local fs proxy', () => {
  it('returns a quiet optional stat miss for missing files', async () => {
    const response = await tryHandleLocalFsProxy('GET', '/api/fs/stat?path=%2Fmissing.ts&optional=true');

    expect(response?.status).toBe(200);
    expect(JSON.parse(Buffer.from(response?.bodyBase64 ?? '', 'base64').toString('utf8'))).toEqual({
      path: '/missing.ts',
      exists: false,
    });
  });

  it('keeps regular stat miss behavior without optional flag', async () => {
    const response = await tryHandleLocalFsProxy('GET', '/api/fs/stat?path=%2Fmissing.ts');

    expect(response?.status).toBe(404);
  });
});
