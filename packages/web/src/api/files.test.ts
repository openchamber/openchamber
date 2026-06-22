import { describe, expect, it, vi } from 'vitest';

import type { RuntimeUrlQuery, RuntimeUrlResolver } from '@openchamber/ui/lib/runtime-url';

const runtimeFetchMock = vi.fn();

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
  it('uses per-call workspace directory for stat and read requests', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/stale-workspace' });

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ path: '/worktree-b/file.txt', isFile: true, size: 12 }));
    await api.statFile?.('/worktree-b/file.txt', { directory: '/worktree-a' });

    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/stat?path=%2Fworktree-b%2Ffile.txt', {
      headers: { 'x-opencode-directory': encodeURIComponent('/worktree-a') },
    });

    runtimeFetchMock.mockResolvedValueOnce(new Response('content'));
    await api.readFile?.('/worktree-b/file.txt', { directory: '/worktree-a' });

    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/read?path=%2Fworktree-b%2Ffile.txt', {
      cache: 'default',
      headers: { 'x-opencode-directory': encodeURIComponent('/worktree-a') },
    });
  });

  it('encodes Unicode workspace directory for header safety', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/stale-workspace' });

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ path: '/中文/file.txt', isFile: true, size: 12 }));
    await api.statFile?.('/中文/file.txt', { directory: '/中文路径' });

    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/stat?path=%2F%E4%B8%AD%E6%96%87%2Ffile.txt', {
      headers: { 'x-opencode-directory': encodeURIComponent('/中文路径') },
    });
  });

  it('sends the workspace directory header for downloads', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/current-workspace' });

    runtimeFetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));
    await expect(api.downloadFile?.('/current-workspace/file.txt')).rejects.toThrow('Download failed');

    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/raw', {
      query: { path: '/current-workspace/file.txt', download: true },
      headers: { 'x-opencode-directory': encodeURIComponent('/current-workspace') },
    });
  });
});
