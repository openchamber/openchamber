import { describe, expect, it, mock } from 'bun:test';

const existingFiles = new Set();
const fsPromises = {
  realpath: mock(async (filePath) => {
    if (existingFiles.has(filePath)) return filePath;
    const error = new Error('missing');
    error.code = 'ENOENT';
    throw error;
  }),
  stat: mock(async (filePath) => {
    if (existingFiles.has(filePath)) return { isFile: () => true, size: 4, mtimeMs: 1 };
    const error = new Error('missing');
    error.code = 'ENOENT';
    throw error;
  }),
  readFile: mock(async () => Buffer.from('test')),
};

mock.module('fs', () => ({
  promises: fsPromises,
  default: { promises: fsPromises },
}));

mock.module('vscode', () => ({
  Uri: {
    file: (fsPath) => ({ fsPath }),
  },
  workspace: {
    workspaceFolders: [
      { uri: { fsPath: '/workspace' } },
      { uri: { fsPath: '/workspace-two' } },
    ],
  },
}));

const { tryHandleLocalFsProxy } = await import('./bridge-localfs-proxy-runtime');

describe('bridge local fs proxy', () => {
  it('does not forward server-owned Markdown image grant routes to OpenCode', async () => {
    const response = await tryHandleLocalFsProxy('POST', '/api/openchamber/sessions/ses_1/markdown-image-grants');

    expect(response?.status).toBe(501);
    expect(Buffer.from(response?.bodyBase64 ?? '', 'base64').toString('utf8'))
      .toContain('not supported in the VS Code runtime');
  });

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

  it('reads from the active directory when it is the second workspace root', async () => {
    existingFiles.add('/workspace-two/image.png');
    const response = await tryHandleLocalFsProxy(
      'GET',
      '/api/fs/raw?path=%2Fworkspace-two%2Fimage.png&directory=%2Fworkspace-two',
    );

    expect(response?.status).toBe(200);
    expect(Buffer.from(response?.bodyBase64 ?? '', 'base64').toString()).toBe('test');
  });
});
