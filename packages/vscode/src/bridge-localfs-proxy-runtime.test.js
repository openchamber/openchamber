import { describe, expect, it, mock } from 'bun:test';

const existingFiles = new Set();
const fileSizes = new Map();
const handleSizes = new Map();
const nonRegularFiles = new Set();
let readFileCalls = 0;
const fsPromises = {
  realpath: mock(async (filePath) => {
    if (existingFiles.has(filePath)) return filePath;
    const error = new Error('missing');
    error.code = 'ENOENT';
    throw error;
  }),
  stat: mock(async (filePath) => {
    if (existingFiles.has(filePath)) return { isFile: () => true, size: fileSizes.get(filePath) ?? 4, mtimeMs: 1 };
    const error = new Error('missing');
    error.code = 'ENOENT';
    throw error;
  }),
  readFile: mock(async () => { readFileCalls += 1; return Buffer.from('test'); }),
  open: mock(async (filePath) => {
    if (!existingFiles.has(filePath)) {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
    const bytes = Buffer.from('test');
    return {
      stat: async () => ({
        isFile: () => !nonRegularFiles.has(filePath),
        size: handleSizes.get(filePath) ?? fileSizes.get(filePath) ?? bytes.length,
      }),
      read: async (buffer, offset, length, position) => {
        const chunk = bytes.subarray(position, position + length);
        chunk.copy(buffer, offset);
        return { bytesRead: chunk.length, buffer };
      },
      close: async () => {},
    };
  }),
};

mock.module('fs', () => ({
  promises: fsPromises,
  constants: { O_RDONLY: 0, O_NONBLOCK: 0 },
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

const { tryHandleLocalFsProxy, LOCAL_FS_READ_MAX_BYTES, LOCAL_FS_RAW_MAX_BYTES } = await import('./bridge-localfs-proxy-runtime');

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

  it('rejects over-cap files with 413 before reading, on both read routes (#1027)', async () => {
    existingFiles.add('/workspace/big.log');
    fileSizes.set('/workspace/big.log', LOCAL_FS_READ_MAX_BYTES + 1);
    readFileCalls = 0;
    const read = await tryHandleLocalFsProxy('GET', '/api/fs/read?path=%2Fworkspace%2Fbig.log');
    expect(read?.status).toBe(413);
    expect(Buffer.from(read?.bodyBase64 ?? '', 'base64').toString('utf8'))
      .toContain(`File exceeds maximum size of ${LOCAL_FS_READ_MAX_BYTES} bytes`);
    expect(readFileCalls).toBe(0);

    existingFiles.add('/workspace/big.bin');
    fileSizes.set('/workspace/big.bin', LOCAL_FS_RAW_MAX_BYTES + 1);
    const raw = await tryHandleLocalFsProxy('GET', '/api/fs/raw?path=%2Fworkspace%2Fbig.bin');
    expect(raw?.status).toBe(413);
    expect(Buffer.from(raw?.bodyBase64 ?? '', 'base64').toString('utf8'))
      .toContain(`File exceeds maximum size of ${LOCAL_FS_RAW_MAX_BYTES} bytes`);
    expect(readFileCalls).toBe(0);
  });

  it('serves files at exactly the cap on both read routes (#1027)', async () => {
    existingFiles.add('/workspace/at-cap.txt');
    fileSizes.set('/workspace/at-cap.txt', LOCAL_FS_READ_MAX_BYTES);
    const read = await tryHandleLocalFsProxy('GET', '/api/fs/read?path=%2Fworkspace%2Fat-cap.txt');
    expect(read?.status).toBe(200);
    expect(read?.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(Buffer.from(read?.bodyBase64 ?? '', 'base64').toString('utf8')).toBe('test');

    existingFiles.add('/workspace/at-cap.bin');
    fileSizes.set('/workspace/at-cap.bin', LOCAL_FS_RAW_MAX_BYTES);
    const raw = await tryHandleLocalFsProxy('GET', '/api/fs/raw?path=%2Fworkspace%2Fat-cap.bin');
    expect(raw?.status).toBe(200);
    expect(Buffer.from(raw?.bodyBase64 ?? '', 'base64').toString()).toBe('test');
  });

  it('rejects a file that grows past the cap after the stat, judged by the read itself (#1605)', async () => {
    existingFiles.add('/workspace/grown.log');
    fileSizes.set('/workspace/grown.log', 4);
    handleSizes.set('/workspace/grown.log', LOCAL_FS_READ_MAX_BYTES + 1);
    const read = await tryHandleLocalFsProxy('GET', '/api/fs/read?path=%2Fworkspace%2Fgrown.log');
    expect(read?.status).toBe(413);
    expect(Buffer.from(read?.bodyBase64 ?? '', 'base64').toString('utf8'))
      .toContain('File exceeds maximum size of ' + LOCAL_FS_READ_MAX_BYTES + ' bytes');

    existingFiles.add('/workspace/grown.bin');
    fileSizes.set('/workspace/grown.bin', 4);
    handleSizes.set('/workspace/grown.bin', LOCAL_FS_RAW_MAX_BYTES + 1);
    const raw = await tryHandleLocalFsProxy('GET', '/api/fs/raw?path=%2Fworkspace%2Fgrown.bin');
    expect(raw?.status).toBe(413);
    expect(Buffer.from(raw?.bodyBase64 ?? '', 'base64').toString('utf8'))
      .toContain('File exceeds maximum size of ' + LOCAL_FS_RAW_MAX_BYTES + ' bytes');
  });

  it('rejects a file swapped for a non-regular file after the stat (#1605)', async () => {
    existingFiles.add('/workspace/swapped.txt');
    fileSizes.set('/workspace/swapped.txt', 4);
    nonRegularFiles.add('/workspace/swapped.txt');
    const read = await tryHandleLocalFsProxy('GET', '/api/fs/read?path=%2Fworkspace%2Fswapped.txt');
    expect(read?.status).toBe(400);
    expect(Buffer.from(read?.bodyBase64 ?? '', 'base64').toString('utf8')).toContain('Specified path is not a file');
  });
});
