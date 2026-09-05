import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FileChangeEvent } from '@openchamber/ui/lib/api/types';
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

const watchUrlAuth = {
  acquire: () => () => undefined,
  subscribe: () => () => undefined,
};

class MockEventSource {
  static instances: MockEventSource[] = [];

  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public readonly url: string) {
    MockEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }
}

describe('createWebFilesAPI', () => {
  it('subscribes to scoped filesystem changes and closes the stream', async () => {
    const { createWebFilesAPI } = await import('./files');
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace', watchUrlAuth });
    const events: FileChangeEvent[] = [];
    const onReady = vi.fn();
    const onError = vi.fn();

    const subscription = api.watchDirectories?.(
      '/workspace',
      ['/workspace', '/workspace/src', '/workspace/src'],
      {
        onChange: (event) => events.push(event),
        onReady,
        onError,
      },
    );

    expect(subscription).toBeDefined();
    expect(MockEventSource.instances).toHaveLength(1);
    const source = MockEventSource.instances[0];
    const url = new URL(source.url, 'http://runtime.test');
    expect(url.pathname).toBe('/api/fs/watch');
    expect(url.searchParams.get('directory')).toBe('/workspace');
    expect(JSON.parse(url.searchParams.get('directories') || '[]')).toEqual([
      '/workspace',
      '/workspace/src',
    ]);

    source.onmessage?.({
      data: JSON.stringify({ type: 'openchamber:files-watch-ready', properties: {} }),
    });
    expect(onReady).toHaveBeenCalledTimes(1);

    source.onmessage?.({
      data: JSON.stringify({
        type: 'openchamber:files-changed',
        properties: { directory: '/workspace/src' },
      }),
    });

    expect(events).toEqual([{ directory: '/workspace/src' }]);

    source.onerror?.();
    expect(onError).toHaveBeenCalledTimes(1);

    subscription?.close();
    expect(source.closed).toBe(true);
  });

  it('reconnects failed watcher streams with bounded exponential backoff', async () => {
    vi.useFakeTimers();
    try {
      const { createWebFilesAPI } = await import('./files');
      MockEventSource.instances = [];
      vi.stubGlobal('EventSource', MockEventSource);
      const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace', watchUrlAuth });
      const onError = vi.fn();
      const subscription = api.watchDirectories?.('/workspace', ['/workspace'], {
        onChange: () => undefined,
        onError,
      });

      const first = MockEventSource.instances[0];
      first.onerror?.();
      expect(first.closed).toBe(true);
      expect(onError).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(MockEventSource.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(MockEventSource.instances).toHaveLength(2);

      const second = MockEventSource.instances[1];
      second.onerror?.();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(MockEventSource.instances).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(MockEventSource.instances).toHaveLength(3);

      MockEventSource.instances[2].onmessage?.({
        data: JSON.stringify({ type: 'openchamber:files-watch-ready', properties: {} }),
      });
      MockEventSource.instances[2].onerror?.();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(MockEventSource.instances).toHaveLength(4);

      subscription?.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the long retry delay while hidden and reconnects when visible again', async () => {
    vi.useFakeTimers();
    try {
      const { createWebFilesAPI } = await import('./files');
      MockEventSource.instances = [];
      vi.stubGlobal('EventSource', MockEventSource);
      let emitVisibility: () => void = () => undefined;
      const documentStub = {
        hidden: true,
        addEventListener: vi.fn((event: string, listener: () => void) => {
          if (event === 'visibilitychange') emitVisibility = listener;
        }),
        removeEventListener: vi.fn(),
      };
      vi.stubGlobal('document', documentStub);
      vi.stubGlobal('window', {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      vi.stubGlobal('navigator', { onLine: true });
      const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace', watchUrlAuth });
      const subscription = api.watchDirectories?.('/workspace', ['/workspace'], {
        onChange: () => undefined,
      });

      MockEventSource.instances[0].onerror?.();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(MockEventSource.instances).toHaveLength(1);

      documentStub.hidden = false;
      emitVisibility();
      expect(MockEventSource.instances).toHaveLength(2);

      subscription?.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the watcher lifecycle limited to closing the subscription', async () => {
    const { createWebFilesAPI } = await import('./files');
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace', watchUrlAuth });
    const subscription = api.watchDirectories?.('/workspace', ['/workspace'], {
      onChange: () => undefined,
    });

    expect(subscription).toBeDefined();
    expect(subscription).not.toHaveProperty('restart');
    subscription?.close();
  });

  it('rebinds on URL-token replacement and releases the auth lease on close', async () => {
    const { createWebFilesAPI } = await import('./files');
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
    const release = vi.fn();
    const unsubscribe = vi.fn();
    let notifyTokenChanged: () => void = () => undefined;
    const api = createWebFilesAPI({
      urls,
      getDirectory: () => '/workspace',
      watchUrlAuth: {
        acquire: () => release,
        subscribe: (listener) => {
          notifyTokenChanged = listener;
          return unsubscribe;
        },
      },
    });
    const subscription = api.watchDirectories?.('/workspace', ['/workspace'], {
      onChange: () => undefined,
    });

    notifyTokenChanged();
    expect(MockEventSource.instances[0].closed).toBe(true);
    expect(MockEventSource.instances).toHaveLength(2);

    subscription?.close();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('falls back instead of opening an oversized watcher subscription', async () => {
    const { createWebFilesAPI } = await import('./files');
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace', watchUrlAuth });
    const directories = Array.from({ length: 65 }, (_, index) => `/workspace/dir-${index}`);

    const subscription = api.watchDirectories?.('/workspace', directories, { onChange: () => undefined });

    expect(subscription).toBeNull();
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('falls back when the watcher URL would exceed the bounded request size', async () => {
    const { createWebFilesAPI } = await import('./files');
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace', watchUrlAuth });
    const directories = Array.from(
      { length: 64 },
      (_, index) => `/workspace/${String(index).padStart(2, '0')}-${'nested'.repeat(40)}`,
    );

    const subscription = api.watchDirectories?.('/workspace', directories, { onChange: () => undefined });

    expect(subscription).toBeNull();
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('preserves a Windows drive root in watcher URLs', async () => {
    const { createWebFilesAPI } = await import('./files');
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
    const api = createWebFilesAPI({ urls, getDirectory: () => 'C:/', watchUrlAuth });

    const subscription = api.watchDirectories?.('C:/', ['C:/', 'C:/Users'], {
      onChange: () => undefined,
    });

    expect(subscription).toBeDefined();
    const url = new URL(MockEventSource.instances[0].url, 'http://runtime.test');
    expect(url.searchParams.get('directory')).toBe('C:/');
    expect(JSON.parse(url.searchParams.get('directories') || '[]')).toEqual(['C:/', 'C:/Users']);
    subscription?.close();
  });

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
