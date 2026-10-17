import { z } from 'zod';

import type {
  DirectoryListResult,
  FileContentSearchOutcome,
  FileContentSearchQuery,
  FileSearchQuery,
  FileSearchResult,
  FilesAPI,
} from '@openchamber/ui/lib/api/types';
import { opencodeClient } from '@openchamber/ui/lib/opencode/client';
import {
  FilesystemError,
  parseFilesystemErrorReason,
  type FilesystemErrorReason,
} from '@openchamber/ui/lib/api/files-errors';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';
import { spaceIdOfDirectory, spaceRootDirectory } from '@openchamber/ui/lib/spaces/space-route';
import { shareFileFromNativeApp } from '@openchamber/ui/lib/nativeFileShare';

const normalizePath = (path: string): string => path.replace(/\\/g, '/');

type SearchFiles = typeof opencodeClient.searchFiles;

interface WebFilesAPIOptions {
  urls?: unknown;
  getDirectory?: () => string | undefined;
  /** File search; defaults to OpenCode's `file.find` through the shared client. */
  searchFiles?: SearchFiles;
}

const defaultSearchFiles: SearchFiles = (query, options) => opencodeClient.searchFiles(query, options);

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

type WebFileMutationResponse = {
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

/**
 * The directory a request names: the caller's, else the folder open in the app. A path inside an
 * isolated space is served by that space only, so a request for one names the space when the open
 * folder is elsewhere: a draft waiting for a space shows the space's files from the project's.
 */
const directoryHeaders = (getDirectory?: () => string | undefined, override?: string, path?: string): Record<string, string> | undefined => {
  const current = getDirectory?.();
  const pathSpace = spaceIdOfDirectory(path);
  const directory = override
    || (pathSpace !== null && spaceIdOfDirectory(current) !== pathSpace ? spaceRootDirectory(pathSpace) : current);
  return directory ? { 'x-opencode-directory': directory } : undefined;
};

const contentSearchResponseSchema = z.object({
  matches: z.array(z.object({
    path: z.string(),
    relativePath: z.string(),
    line: z.number().int().positive(),
    column: z.number().int().positive(),
    text: z.string(),
    ranges: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])),
    cutStart: z.boolean(),
  })),
  stopped: z.enum(['limit', 'deadline']).nullable(),
});

const contentSearchErrorSchema = z.object({
  error: z.string().optional(),
  reason: z.string().optional(),
});

export const createWebFilesAPI = ({ getDirectory, searchFiles = defaultSearchFiles }: WebFilesAPIOptions): FilesAPI => ({
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
      headers: directoryHeaders(getDirectory, undefined, target),
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

  async search(payload: FileSearchQuery): Promise<FileSearchResult[]> {
    // file.find answers file search on OpenCode 2.x; /api/find/file has no
    // route there and falls through the generic proxy to a 404.
    const directory = normalizePath(payload.directory);
    const hits = await searchFiles(payload.query, {
      directory,
      limit: typeof payload.maxResults === 'number' && Number.isFinite(payload.maxResults)
        ? payload.maxResults
        : undefined,
      type: 'file',
    });

    return hits.map((hit) => ({
      path: normalizePath(hit.path),
      preview: [normalizePath(hit.relativePath)],
    }));
  },

  async searchContents(payload: FileContentSearchQuery): Promise<FileContentSearchOutcome> {
    const directory = normalizePath(payload.directory);
    const params = new URLSearchParams({ query: payload.query, regex: payload.regex ? 'true' : 'false' });
    if (payload.limit !== undefined) {
      params.set('limit', String(payload.limit));
    }
    if (payload.includeHidden) {
      params.set('includeHidden', 'true');
    }
    if (payload.respectGitignore === false) {
      params.set('respectGitignore', 'false');
    }

    const response = await runtimeFetch('/api/fs/find-in-files', {
      query: params,
      cache: 'no-store',
      signal: payload.signal,
      headers: directoryHeaders(getDirectory, directory),
    });

    if (response.ok) {
      const parsed = contentSearchResponseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) {
        throw new FilesystemError('Content search returned an invalid response', { reason: 'invalid-response' });
      }
      return {
        status: 'ok',
        matches: parsed.data.matches.map((match) => ({ ...match, path: normalizePath(match.path) })),
        stopped: parsed.data.stopped,
      };
    }

    const failure = contentSearchErrorSchema.safeParse(await response.json().catch(() => null));
    const reason = failure.success ? failure.data.reason : undefined;
    if (response.status === 501 && reason === 'search-unavailable') {
      return { status: 'unavailable' };
    }
    if (response.status === 400 && reason === 'invalid-pattern') {
      return { status: 'invalid-pattern', message: failure.success && failure.data.error ? failure.data.error : 'Invalid regular expression' };
    }
    throw new FilesystemError(
      (failure.success && failure.data.error) || response.statusText || 'Failed to search file contents',
      { status: response.status },
    );
  },

  async createDirectory(path: string): Promise<{ success: boolean; path: string }> {
    const target = normalizePath(path);
    const response = await runtimeFetch('/api/fs/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...directoryHeaders(getDirectory, undefined, target) },
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
      signal: AbortSignal.timeout(30_000),
      headers: directoryHeaders(getDirectory, options?.directory, target),
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
      signal: AbortSignal.timeout(30_000),
      cache: options?.optional || options?.fresh ? 'no-store' : 'default',
      headers: directoryHeaders(getDirectory, options?.directory, target),
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
      headers: { 'Content-Type': 'application/json', ...directoryHeaders(getDirectory, undefined, target) },
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
        ...directoryHeaders(getDirectory, options?.directory, target),
      },
      body: file,
    });

    if (!response.ok) {
      const error: WebFileMutationResponse = await response.json().catch(() => ({ error: response.statusText }));
      throw new FilesystemError(error.error || 'Failed to upload file', {
        reason: parseFilesystemErrorReason(error.reason),
        status: response.status,
      });
    }

    const result: WebFileMutationResponse = await response.json().catch(() => ({}));
    return {
      success: Boolean(result.success),
      path: result.path ? normalizePath(result.path) : target,
    };
  },

  async delete(path: string): Promise<{ success: boolean }> {
    const target = normalizePath(path);
    const response = await runtimeFetch('/api/fs/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...directoryHeaders(getDirectory, undefined, target) },
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
      headers: { 'Content-Type': 'application/json', ...directoryHeaders(getDirectory, undefined, oldPath) },
      body: JSON.stringify({ oldPath, newPath }),
    });

    if (!response.ok) {
      const error: WebFileMutationResponse = await response.json().catch(() => ({ error: response.statusText }));
      throw new FilesystemError(error.error || 'Failed to rename file', {
        reason: parseFilesystemErrorReason(error.reason),
        status: response.status,
      });
    }

    const result: WebFileMutationResponse = await response.json().catch(() => ({}));
    return {
      success: Boolean(result.success),
      path: result.path ? normalizePath(result.path) : newPath,
    };
  },

  async revealPath(targetPath: string): Promise<{ success: boolean }> {
    const response = await runtimeFetch('/api/fs/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...directoryHeaders(getDirectory, undefined, targetPath) },
      body: JSON.stringify({ path: normalizePath(targetPath) }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to reveal path');
    }

    const result = await response.json().catch(() => ({}));
    return { success: Boolean((result as { success?: boolean }).success) };
  },

  async downloadFile(path: string, options): Promise<void> {
    const target = normalizePath(path);
    const params = new URLSearchParams({ path: target, download: 'true' });
    if (options?.allowOutsideWorkspace) {
      params.set('allowOutsideWorkspace', 'true');
    }
    if (options?.outsideFileGrant) {
      params.set('outsideFileGrant', options.outsideFileGrant);
    }
    const response = await runtimeFetch('/api/fs/raw', {
      query: params,
      headers: directoryHeaders(getDirectory, options?.directory, target),
    });
    if (!response.ok) {
      throw new Error(`Download failed (${response.status})`);
    }

    const blob = await response.blob();
    const filename = target.split('/').pop() || 'file';
    const capacitor = (window as typeof window & {
      Capacitor?: { isNativePlatform?: () => boolean };
    }).Capacitor;
    if (capacitor?.isNativePlatform?.() === true) {
      await shareFileFromNativeApp(new File([blob], filename, { type: blob.type || 'application/octet-stream' }));
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
