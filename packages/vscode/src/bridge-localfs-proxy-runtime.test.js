import { describe, expect, it, mock } from 'bun:test';

mock.module('vscode', () => ({
  Uri: {
    file: (fsPath) => ({ fsPath }),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
  },
}));

const { tryHandleLocalFsProxy } = await import('./bridge-localfs-proxy-runtime');

const missingPathDeps = {
  resolveFileReadPath: mock(async () => ({ ok: false, status: 404, error: 'File not found' })),
};

describe('bridge local fs proxy', () => {
  it('returns a quiet optional stat miss for missing files', async () => {
    const response = await tryHandleLocalFsProxy(
      'GET',
      '/api/fs/stat?path=%2Fmissing.ts&optional=true',
      missingPathDeps,
    );

    expect(response?.status).toBe(200);
    expect(JSON.parse(Buffer.from(response?.bodyBase64 ?? '', 'base64').toString('utf8'))).toEqual({
      path: '/missing.ts',
      exists: false,
    });
  });

  it('keeps regular stat miss behavior without optional flag', async () => {
    const response = await tryHandleLocalFsProxy('GET', '/api/fs/stat?path=%2Fmissing.ts', missingPathDeps);

    expect(response?.status).toBe(404);
  });
});
