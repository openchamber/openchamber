import { describe, expect, it, mock } from 'bun:test';
import * as path from 'node:path';

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
  it.skipIf(process.platform !== 'win32')('accepts an existing workspace file with different drive-letter casing', async () => {
    const filePath = path.resolve('/workspace/package.json').replace(/^[A-Z]/, (drive) => drive.toLowerCase());
    existingFiles.add(filePath);
    const response = await tryHandleLocalFsProxy('GET', `/api/fs/stat?path=${encodeURIComponent(filePath)}&optional=true`);

    expect(response?.status).toBe(200);
    expect(JSON.parse(Buffer.from(response?.bodyBase64 ?? '', 'base64').toString('utf8')).isFile).toBe(true);
  });

  it('rejects existing files outside the workspace, including a sibling with the same prefix', async () => {
    for (const outside of ['/workspace-other/package.json', '/outside/package.json']) {
      const filePath = path.resolve(outside);
      existingFiles.add(filePath);
      const response = await tryHandleLocalFsProxy('GET', `/api/fs/stat?path=${encodeURIComponent(filePath)}&optional=true`);
      expect(response?.status).toBe(403);
    }
  });

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

  it('does not forward directory availability probes to OpenCode', async () => {
    const response = await tryHandleLocalFsProxy('GET', '/api/fs/directory-stat?path=%2Fmissing-dir');
    expect(response?.status).toBe(501);
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
