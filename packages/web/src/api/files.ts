import type {
  DirectoryListResult,
  FileChangeEvent,
  FileWatchHandlers,
  FileSearchQuery,
  FileSearchResult,
  FilesAPI,
} from '@openchamber/ui/lib/api/types';
import type { RuntimeUrlResolver } from '@openchamber/ui/lib/runtime-url';
import {
  FilesystemError,
  parseFilesystemErrorReason,
  type FilesystemErrorReason,
} from '@openchamber/ui/lib/api/files-errors';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';
import { getRuntimeUrlResolver } from '@openchamber/ui/lib/runtime-url';
import { subscribeRuntimeEndpointChanged } from '@openchamber/ui/lib/runtime-switch';
import {
  acquireRuntimeUrlAuthToken,
  subscribeRuntimeUrlAuthToken,
} from '@openchamber/ui/lib/runtime-auth';
import {
  getFileTreePathIdentity,
  isFileTreePathWithinRoot,
  normalizeFileTreePath,
} from '@openchamber/ui/lib/fileTreePath';
import { z } from 'zod';

const normalizePath = (path: string): string => path.replace(/\\/g, '/');
const MAX_WATCHED_DIRECTORIES = 64;
const MAX_WATCH_URL_LENGTH = 12_000;
const WATCH_RECONNECT_BASE_MS = 1_000;
const WATCH_RECONNECT_MAX_MS = 30_000;
const WATCH_RECONNECT_INACTIVE_MS = 60_000;

const collectWatchedDirectories = (workspaceDirectory: string, directories: string[]): string[] => {
  const workspace = normalizeFileTreePath(workspaceDirectory);
  const seen = new Set<string>();
  const watched: string[] = [];

  for (const value of directories) {
    const directory = normalizeFileTreePath(value);
    const key = getFileTreePathIdentity(directory);
    if (!directory || seen.has(key)) continue;
    if (!isFileTreePathWithinRoot(directory, workspace)) continue;
    seen.add(key);
    watched.push(directory);
  }

  return watched;
};

const fileChangeEnvelopeSchema = z.object({
  type: z.literal('openchamber:files-changed'),
  properties: z.object({
    directory: z.string().min(1),
  }),
});
const fileWatchReadyEnvelopeSchema = z.object({
  type: z.literal('openchamber:files-watch-ready'),
});

const isFileWatchReadyEvent = (raw: string): boolean => {
  try {
    return fileWatchReadyEnvelopeSchema.safeParse(JSON.parse(raw)).success;
  } catch {
    return false;
  }
};

const parseFileChangeEvent = (raw: string, watchedDirectoryKeys: Set<string>): FileChangeEvent | null => {
  try {
    const parsed = fileChangeEnvelopeSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const directory = normalizeFileTreePath(parsed.data.properties.directory);
    if (!directory || !watchedDirectoryKeys.has(getFileTreePathIdentity(directory))) return null;
    return { directory };
  } catch {
    return null;
  }
};

interface FileWatchUrlAuth {
  acquire: () => () => void;
  subscribe: (listener: () => void) => () => void;
}

interface WebFilesAPIOptions {
  urls?: RuntimeUrlResolver;
  getDirectory?: () => string | undefined;
  watchUrlAuth?: FileWatchUrlAuth;
}

const defaultWatchUrlAuth: FileWatchUrlAuth = {
  acquire: () => acquireRuntimeUrlAuthToken(),
  subscribe: (listener: () => void) => subscribeRuntimeUrlAuthToken(listener),
};

type WebDirectoryEntry = {
  name?: string;
  path?: string;
  isDirectory?: boolean;
  isFile?: boolean;
  isSymbolicLink?: boolean;
};

type WebDirectoryListResponse = {
  directory?: string;
  path?: string;
  entries?: WebDirectoryEntry[];
};

type WebFileUploadResponse = {
  success?: boolean;
  path?: string;
  error?: string;
  reason?: FilesystemErrorReason;
};

const toDirectoryListResult = (fallbackDirectory: string, payload: WebDirectoryListResponse): DirectoryListResult => {
  if (!payload || !Array.isArray(payload.entries)) {
    throw new FilesystemError('Directory listing returned an invalid response', {
      reason: 'invalid-response',
    });
  }
  const directory = normalizePath(payload?.directory || payload?.path || fallbackDirectory);

  return {
    directory,
    entries: payload.entries
      .filter((entry): entry is Required<Pick<WebDirectoryEntry, 'name' | 'path'>> & { isDirectory?: boolean } =>
        Boolean(entry && typeof entry.name === 'string' && typeof entry.path === 'string')
      )
      .map((entry) => ({
        name: entry.name,
        path: normalizePath(entry.path),
        isDirectory: Boolean(entry.isDirectory),
      })),
  };
};

const directoryHeaders = (getDirectory?: () => string | undefined, override?: string): Record<string, string> | undefined => {
  const directory = override || getDirectory?.();
  return directory ? { 'x-opencode-directory': directory } : undefined;
};

export const createWebFilesAPI = ({
  urls,
  getDirectory,
  watchUrlAuth = defaultWatchUrlAuth,
}: WebFilesAPIOptions): FilesAPI => ({
  async listDirectory(path: string, options): Promise<DirectoryListResult> {
    const target = normalizePath(path);
    const params = new URLSearchParams();
    if (target) {
      params.set('path', target);
    }
    if (options?.respectGitignore) {
      params.set('respectGitignore', 'true');
    }

    const response = await runtimeFetch('/api/fs/list', {
      query: params,
      headers: directoryHeaders(getDirectory),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText })) as {
        error?: string;
        reason?: unknown;
      };
      throw new FilesystemError(
        error.error || 'Failed to list directory',
        {
          reason: parseFilesystemErrorReason(error.reason),
          status: response.status,
        },
      );
    }

    const result = (await response.json()) as WebDirectoryListResponse;
    return toDirectoryListResult(target, result);
  },

  watchDirectories(workspaceDirectory, directories, handlers: FileWatchHandlers) {
    const EventSourceConstructor = globalThis.EventSource;
    if (!EventSourceConstructor) return null;
    const workspace = normalizeFileTreePath(workspaceDirectory);
    const watched = collectWatchedDirectories(workspace, directories);
    if (!workspace || watched.length === 0 || watched.length > MAX_WATCHED_DIRECTORIES) return null;

    const query = new URLSearchParams({
      directory: workspace,
      directories: JSON.stringify(watched),
    });
    const watchedDirectoryKeys = new Set(watched.map(getFileTreePathIdentity));
    const resolveWatchUrl = () => (urls ?? getRuntimeUrlResolver()).sse('/api/fs/watch', query);
    if (resolveWatchUrl().length > MAX_WATCH_URL_LENGTH) return null;
    const releaseUrlAuth = watchUrlAuth.acquire();

    let closed = false;
    let failures = 0;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const clearReconnectTimer = () => {
      if (!reconnectTimer) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };
    const closeSource = () => {
      source?.close();
      source = null;
    };
    const isInactive = () => (
      globalThis.document?.hidden === true
      || globalThis.navigator?.onLine === false
    );
    const scheduleReconnect = () => {
      if (closed || reconnectTimer) return;
      const exponentialDelay = Math.min(
        WATCH_RECONNECT_BASE_MS * (2 ** Math.min(failures, 5)),
        WATCH_RECONNECT_MAX_MS,
      );
      const delay = isInactive()
        ? Math.max(exponentialDelay, WATCH_RECONNECT_INACTIVE_MS)
        : exponentialDelay;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };
    const connect = () => {
      if (closed || source) return;
      let watchUrl = '';
      try {
        watchUrl = resolveWatchUrl();
      } catch {
        failures += 1;
        handlers.onError?.();
        scheduleReconnect();
        return;
      }
      if (watchUrl.length > MAX_WATCH_URL_LENGTH) {
        failures += 1;
        handlers.onError?.();
        scheduleReconnect();
        return;
      }
      let nextSource: EventSource;
      try {
        nextSource = new EventSourceConstructor(watchUrl);
      } catch {
        failures += 1;
        handlers.onError?.();
        scheduleReconnect();
        return;
      }
      source = nextSource;
      nextSource.onmessage = (message) => {
        if (source !== nextSource || closed) return;
        if (isFileWatchReadyEvent(message.data)) {
          failures = 0;
          handlers.onReady?.();
          return;
        }
        const event = parseFileChangeEvent(message.data, watchedDirectoryKeys);
        if (event) handlers.onChange(event);
      };
      nextSource.onerror = () => {
        if (source !== nextSource || closed) return;
        closeSource();
        handlers.onError?.();
        scheduleReconnect();
        failures += 1;
      };
    };
    const retryWhenActive = () => {
      if (!reconnectTimer || isInactive()) return;
      clearReconnectTimer();
      connect();
    };

    globalThis.window?.addEventListener('online', retryWhenActive);
    globalThis.document?.addEventListener('visibilitychange', retryWhenActive);
    const unsubscribeRuntimeChange = subscribeRuntimeEndpointChanged(() => {
      if (closed) return;
      clearReconnectTimer();
      closeSource();
      failures = 0;
      connect();
    });
    const unsubscribeUrlAuth = watchUrlAuth.subscribe(() => {
      if (closed) return;
      clearReconnectTimer();
      closeSource();
      failures = 0;
      connect();
    });
    connect();

    return {
      close() {
        if (closed) return;
        closed = true;
        clearReconnectTimer();
        closeSource();
        globalThis.window?.removeEventListener('online', retryWhenActive);
        globalThis.document?.removeEventListener('visibilitychange', retryWhenActive);
        unsubscribeRuntimeChange();
        unsubscribeUrlAuth();
        releaseUrlAuth();
      },
    };
  },

  async search(payload: FileSearchQuery): Promise<FileSearchResult[]> {
    const params = new URLSearchParams();

    const directory = normalizePath(payload.directory);
    if (directory) {
      params.set('directory', directory);
    }

    params.set('query', payload.query);
    params.set('dirs', 'false');
    params.set('type', 'file');

    if (typeof payload.maxResults === 'number' && Number.isFinite(payload.maxResults)) {
      params.set('limit', String(payload.maxResults));
    }

    const response = await runtimeFetch('/api/find/file', {
      query: params,
      headers: directoryHeaders(getDirectory),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to search files');
    }

    const result = (await response.json()) as string[];
    const files = Array.isArray(result) ? result : [];

    return files.map((relativePath) => ({
      path: normalizePath(`${directory}/${relativePath}`),
      preview: [normalizePath(relativePath)],
    }));
  },

  async createDirectory(path: string): Promise<{ success: boolean; path: string }> {
    const target = normalizePath(path);
    const response = await runtimeFetch('/api/fs/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...directoryHeaders(getDirectory) },
      body: JSON.stringify({ path: target }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to create directory');
    }

    const result = await response.json();
    return {
      success: Boolean(result?.success),
      path: typeof result?.path === 'string' ? normalizePath(result.path) : target,
    };
  },

  async statFile(path: string, options): Promise<{ path: string; isFile: boolean; size: number; mtimeMs?: number }> {
    const target = normalizePath(path);
    const params = new URLSearchParams({ path: target });
    if (options?.allowOutsideWorkspace) {
      params.set('allowOutsideWorkspace', 'true');
    }
    if (options?.outsideFileGrant) {
      params.set('outsideFileGrant', options.outsideFileGrant);
    }
    const response = await runtimeFetch('/api/fs/stat', {
      query: params,
      headers: directoryHeaders(getDirectory, options?.directory),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to stat file');
    }

    const result = await response.json().catch(() => ({}));
    return {
      path: typeof (result as { path?: string }).path === 'string' ? normalizePath((result as { path: string }).path) : target,
      isFile: Boolean((result as { isFile?: boolean }).isFile),
      size: typeof (result as { size?: number }).size === 'number' ? (result as { size: number }).size : 0,
      mtimeMs: typeof (result as { mtimeMs?: number }).mtimeMs === 'number' ? (result as { mtimeMs: number }).mtimeMs : undefined,
    };
  },

  async readFile(path: string, options): Promise<{ content: string; path: string }> {
    const target = normalizePath(path);
    const params = new URLSearchParams({ path: target });
    if (options?.allowOutsideWorkspace) {
      params.set('allowOutsideWorkspace', 'true');
    }
    if (options?.outsideFileGrant) {
      params.set('outsideFileGrant', options.outsideFileGrant);
    }
    if (options?.optional) {
      params.set('optional', 'true');
    }
    const response = await runtimeFetch('/api/fs/read', {
      query: params,
      cache: options?.optional ? 'no-store' : 'default',
      headers: directoryHeaders(getDirectory, options?.directory),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to read file');
    }

    const content = await response.text();
    return { content, path: target };
  },

  async writeFile(path: string, content: string): Promise<{ success: boolean; path: string }> {
    const target = normalizePath(path);
    const response = await runtimeFetch('/api/fs/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...directoryHeaders(getDirectory) },
      body: JSON.stringify({ path: target, content }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to write file');
    }

    const result = await response.json().catch(() => ({}));
    return {
      success: Boolean((result as { success?: boolean }).success),
      path: typeof (result as { path?: string }).path === 'string' ? normalizePath((result as { path: string }).path) : target,
    };
  },

  async uploadFile(path: string, file: Blob, options): Promise<{ success: boolean; path: string }> {
    const target = normalizePath(path);
    const response = await runtimeFetch('/api/fs/upload', {
      method: 'POST',
      query: {
        path: target,
        overwrite: options?.overwrite ? 'true' : undefined,
      },
      headers: {
        'Content-Type': 'application/octet-stream',
        ...directoryHeaders(getDirectory, options?.directory),
      },
      body: file,
    });

    if (!response.ok) {
      const error: WebFileUploadResponse = await response.json().catch(() => ({ error: response.statusText }));
      throw new FilesystemError(error.error || 'Failed to upload file', {
        reason: parseFilesystemErrorReason(error.reason),
        status: response.status,
      });
    }

    const result: WebFileUploadResponse = await response.json().catch(() => ({}));
    return {
      success: Boolean(result.success),
      path: result.path ? normalizePath(result.path) : target,
    };
  },

  async delete(path: string): Promise<{ success: boolean }> {
    const target = normalizePath(path);
    const response = await runtimeFetch('/api/fs/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...directoryHeaders(getDirectory) },
      body: JSON.stringify({ path: target }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to delete file');
    }

    const result = await response.json().catch(() => ({}));
    return { success: Boolean((result as { success?: boolean }).success) };
  },

  async rename(oldPath: string, newPath: string): Promise<{ success: boolean; path: string }> {
    const response = await runtimeFetch('/api/fs/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...directoryHeaders(getDirectory) },
      body: JSON.stringify({ oldPath, newPath }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to rename file');
    }

    const result = await response.json().catch(() => ({}));
    return {
      success: Boolean((result as { success?: boolean }).success),
      path: typeof (result as { path?: string }).path === 'string' ? normalizePath((result as { path: string }).path) : newPath,
    };
  },

  async revealPath(targetPath: string): Promise<{ success: boolean }> {
    const response = await runtimeFetch('/api/fs/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...directoryHeaders(getDirectory) },
      body: JSON.stringify({ path: normalizePath(targetPath) }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to reveal path');
    }

    const result = await response.json().catch(() => ({}));
    return { success: Boolean((result as { success?: boolean }).success) };
  },

  async downloadFile(path: string): Promise<void> {
    const target = normalizePath(path);
    const response = await runtimeFetch('/api/fs/raw', {
      query: { path: target, download: true },
      headers: directoryHeaders(getDirectory),
    });
    if (!response.ok) {
      throw new Error(`Download failed (${response.status})`);
    }

    const blob = await response.blob();
    const filename = target.split('/').pop() || 'file';
    const capacitor = (window as typeof window & {
      Capacitor?: { isNativePlatform?: () => boolean };
    }).Capacitor;
    const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
    if (capacitor?.isNativePlatform?.() === true && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
  },
});
