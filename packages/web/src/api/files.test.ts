import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeUrlQuery, RuntimeUrlResolver } from '@openchamber/ui/lib/runtime-url';

const runtimeFetchMock = vi.fn();

afterEach(() => {
  vi.unstubAllGlobals();
});

vi.mock('@openchamber/ui/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

const toUrl = (path: string, query?: RuntimeUrlQuery): string => {
  const params = query instanceof URLSearchParams ? query : new URLSearchParams();
  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
};

const urls: RuntimeUrlResolver = {
  api: toUrl,
  authenticatedAsset: toUrl,
  auth: toUrl,
  health: (query?: RuntimeUrlQuery) => toUrl('/health', query),
  rawFile: (path: string) => toUrl('/api/fs/raw', new URLSearchParams({ path })),
  sse: toUrl,
  websocket: toUrl,
};

describe('createWebFilesAPI', () => {
  it('preserves the directory permission failure contract', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });
    runtimeFetchMock.mockResolvedValueOnce(Response.json(
      { error: 'Access to directory denied', reason: 'os-permission' },
      { status: 403 },
    ));

    const error = await api.listDirectory('/protected').catch((caught) => caught);

    expect(error).toMatchObject({
      name: 'FilesystemError',
      reason: 'os-permission',
      status: 403,
      message: 'Access to directory denied',
    });
  });

  it('rejects malformed successful directory listings', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ path: '/workspace' }));

    await expect(api.listDirectory('/workspace')).rejects.toMatchObject({
      reason: 'invalid-response',
    });
  });

  it('uses per-call workspace directory for stat and read requests', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/stale-workspace' });

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ path: '/worktree-b/file.txt', isFile: true, size: 12 }));
    await api.statFile?.('/worktree-b/file.txt', { directory: '/worktree-a' });

    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/stat', {
      query: new URLSearchParams({ path: '/worktree-b/file.txt' }),
      headers: { 'x-opencode-directory': '/worktree-a' },
    });

    runtimeFetchMock.mockResolvedValueOnce(new Response('content'));
    await api.readFile?.('/worktree-b/file.txt', { directory: '/worktree-a' });

    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/read', {
      query: new URLSearchParams({ path: '/worktree-b/file.txt' }),
      cache: 'default',
      headers: { 'x-opencode-directory': '/worktree-a' },
    });
  });

  it('sends the workspace directory header for downloads', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/current-workspace' });

    runtimeFetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));
    await expect(api.downloadFile?.('/current-workspace/file.txt')).rejects.toThrow('Download failed');

    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/raw', {
      query: { path: '/current-workspace/file.txt', download: true },
      headers: { 'x-opencode-directory': '/current-workspace' },
    });
  });

  it('uploads binary file contents to the active workspace', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });
    const file = new Blob([new Uint8Array([0, 1, 255])]);
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ success: true, path: '/workspace/image.bin' }));

    await api.uploadFile?.('/workspace/image.bin', file, { directory: '/workspace' });

    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/upload', {
      method: 'POST',
      query: { path: '/workspace/image.bin', overwrite: undefined },
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-opencode-directory': '/workspace',
      },
      body: file,
    });
  });

  it('preserves upload conflict details for explicit overwrite handling', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });
    runtimeFetchMock.mockResolvedValueOnce(Response.json(
      { error: 'File already exists', reason: 'already-exists' },
      { status: 409 },
    ));

    await expect(api.uploadFile?.('/workspace/file.txt', new Blob(['new']))).rejects.toMatchObject({
      reason: 'already-exists',
      status: 409,
    });
  });

  it('opens the native share sheet for downloads in the Capacitor app', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('navigator', {});
    Object.defineProperty(window, 'Capacitor', { configurable: true, value: { isNativePlatform: () => true } });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    runtimeFetchMock.mockResolvedValueOnce(new Response('hello', { headers: { 'Content-Type': 'text/plain' } }));

    await api.downloadFile?.('/workspace/hello.txt');

    expect(share).toHaveBeenCalledWith({ files: [expect.objectContaining({ name: 'hello.txt', type: 'text/plain' })] });
  });
});
