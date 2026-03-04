import type {
  CommandExecResult,
  DirectoryListResult,
  FileStatResult,
  FileSearchQuery,
  FileSearchResult,
  FilesAPI,
  WriteFileOptions,
  WriteFileResult,
} from '@openchamber/ui/lib/api/types';

import { sendBridgeMessage, sendBridgeMessageWithOptions } from './bridge';

const normalizePath = (value: string): string => value.replace(/\\/g, '/');

export const createVSCodeFilesAPI = (): FilesAPI => ({
  async listDirectory(path: string, options?: { respectGitignore?: boolean }): Promise<DirectoryListResult> {
    const target = normalizePath(path);
    const data = await sendBridgeMessage<{
      directory?: string;
      path?: string;
      entries: Array<{
        name: string;
        path: string;
        isDirectory: boolean;
        size?: number;
        modifiedTime?: number;
      }>;
    }>('api:fs:list', {
      path: target,
      respectGitignore: options?.respectGitignore,
    });

    const directory = normalizePath(data?.directory || data?.path || target);
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    return {
      directory,
      entries: entries.map((entry) => ({
        name: entry.name,
        path: normalizePath(entry.path),
        isDirectory: Boolean(entry.isDirectory),
        size: typeof entry.size === 'number' ? entry.size : undefined,
        modifiedTime: typeof entry.modifiedTime === 'number' ? entry.modifiedTime : undefined,
      })),
    };
  },

  async stat(path: string): Promise<FileStatResult> {
    const target = normalizePath(path);
    const data = await sendBridgeMessage<{
      path?: string;
      isDirectory?: boolean;
      isFile?: boolean;
      size?: number;
      modifiedTime?: number;
    }>('api:fs:stat', { path: target });

    return {
      path: typeof data?.path === 'string' ? normalizePath(data.path) : target,
      isDirectory: Boolean(data?.isDirectory),
      isFile: Boolean(data?.isFile),
      size: typeof data?.size === 'number' ? data.size : undefined,
      modifiedTime: typeof data?.modifiedTime === 'number' ? data.modifiedTime : undefined,
    };
  },

  async search(payload: FileSearchQuery): Promise<FileSearchResult[]> {
    const directory = normalizePath(payload.directory);
    const params = new URLSearchParams();
    if (directory) {
      params.set('directory', directory);
    }
    params.set('query', payload.query);
    params.set('dirs', 'false');
    params.set('type', 'file');
    if (typeof payload.maxResults === 'number' && Number.isFinite(payload.maxResults)) {
      params.set('limit', String(payload.maxResults));
    }

    const response = await fetch(`/api/find/file?${params.toString()}`);
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
    const data = await sendBridgeMessage<{ success: boolean; path: string }>('api:fs:mkdir', { path: target });
    return {
      success: Boolean(data?.success),
      path: typeof data?.path === 'string' ? normalizePath(data.path) : target,
    };
  },

  async delete(path: string): Promise<{ success: boolean }> {
    const target = normalizePath(path);
    const data = await sendBridgeMessage<{ success: boolean }>('api:fs:delete', { path: target });
    return { success: Boolean(data?.success) };
  },

  async rename(oldPath: string, newPath: string): Promise<{ success: boolean; path: string }> {
    const data = await sendBridgeMessage<{ success: boolean; path: string }>('api:fs:rename', { oldPath, newPath });
    return {
      success: Boolean(data?.success),
      path: typeof data?.path === 'string' ? normalizePath(data.path) : newPath,
    };
  },

  async readFile(path: string): Promise<{ content: string; path: string }> {
    const target = normalizePath(path);
    const data = await sendBridgeMessage<{ content: string; path: string }>('api:fs:read', { path: target });
    return {
      content: typeof data?.content === 'string' ? data.content : '',
      path: typeof data?.path === 'string' ? normalizePath(data.path) : target,
    };
  },

  async writeFile(path: string, content: string, options?: WriteFileOptions): Promise<WriteFileResult> {
    const target = normalizePath(path);
    const data = await sendBridgeMessage<{ success: boolean; path: string; sizeBytes?: number }>('api:fs:write', {
      path: target,
      content,
      encoding: options?.encoding,
      expectedSizeBytes: options?.expectedSizeBytes,
    });
    return {
      success: Boolean(data?.success),
      path: typeof data?.path === 'string' ? normalizePath(data.path) : target,
      sizeBytes: typeof data?.sizeBytes === 'number' ? data.sizeBytes : undefined,
    };
  },

  async execCommands(commands: string[], cwd: string): Promise<{ success: boolean; results: CommandExecResult[] }> {
    const targetCwd = normalizePath(cwd);
    // Use extended timeout for command execution (5 minutes)
    const data = await sendBridgeMessageWithOptions<{ success: boolean; results?: CommandExecResult[] }>('api:fs:exec', {
      commands,
      cwd: targetCwd,
    }, { timeoutMs: 300000 });

    return {
      success: Boolean(data?.success),
      results: Array.isArray(data?.results) ? data.results : [],
    };
  },
});
