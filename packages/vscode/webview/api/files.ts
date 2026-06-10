import type {
  CommandExecResult,
  DirectoryListResult,
  FileSearchQuery,
  FileSearchResult,
  FilesAPI,
} from '@openchamber/ui/lib/api/types';

import { sendBridgeMessage, sendBridgeMessageWithOptions } from './bridge';

const normalizePath = (value: string): string => value.replace(/\\/g, '/');

export const createVSCodeFilesAPI = (): FilesAPI => ({
  async listDirectory(path: string, options?: { respectGitignore?: boolean }): Promise<DirectoryListResult> {
    const target = normalizePath(path);
    const data = await sendBridgeMessage<{
      directory?: string;
      path?: string;
      entries: Array<{ name: string; path: string; isDirectory: boolean }>;
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
      })),
    };
  },

  async search(payload: FileSearchQuery): Promise<FileSearchResult[]> {
    const directory = normalizePath(payload.directory);
    const data = await sendBridgeMessage<{
      files?: Array<{ path?: string; relativePath?: string }>;
    }>('api:fs:search', {
      directory,
      query: payload.query,
      limit: payload.maxResults,
      includeHidden: false,
      respectGitignore: true,
    });

    const files = Array.isArray(data?.files) ? data.files : [];

    return files.map((file) => {
      const relativePath = typeof file.relativePath === 'string'
        ? normalizePath(file.relativePath)
        : normalizePath(file.path || '');
      const absolutePath = typeof file.path === 'string'
        ? normalizePath(file.path)
        : normalizePath(`${directory}/${relativePath}`);
      return {
        path: absolutePath,
        preview: [relativePath || absolutePath],
      };
    });
  },

  async createDirectory(path: string): Promise<{ success: boolean; path: string }> {
    const target = normalizePath(path);
    const data = await sendBridgeMessage<{ success: boolean; path: string }>('api:fs:mkdir', { path: target });
    return {
      success: Boolean(data?.success),
      path: typeof data?.path === 'string' ? normalizePath(data.path) : target,
    };
  },

  async statFile(path: string): Promise<{ path: string; isFile: boolean; size: number; mtimeMs?: number }> {
    const target = normalizePath(path);
    const data = await sendBridgeMessage<{ path?: string; isFile?: boolean; size?: number; mtimeMs?: number }>('api:fs:stat', { path: target });
    return {
      path: typeof data?.path === 'string' ? normalizePath(data.path) : target,
      isFile: Boolean(data?.isFile),
      size: typeof data?.size === 'number' ? data.size : 0,
      mtimeMs: typeof data?.mtimeMs === 'number' ? data.mtimeMs : undefined,
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

  async writeFile(path: string, content: string): Promise<{ success: boolean; path: string }> {
    const target = normalizePath(path);
    const data = await sendBridgeMessage<{ success: boolean; path: string }>('api:fs:write', { path: target, content });
    return {
      success: Boolean(data?.success),
      path: typeof data?.path === 'string' ? normalizePath(data.path) : target,
    };
  },

  async revealPath(path: string): Promise<{ success: boolean }> {
    const target = normalizePath(path);
    const data = await sendBridgeMessage<{ success?: boolean }>('api:fs:reveal', { path: target });
    return { success: Boolean(data?.success) };
  },

  async execCommands(commands: string[], cwd: string): Promise<{ success: boolean; results: CommandExecResult[] }> {
    const targetCwd = normalizePath(cwd);
    const data = await sendBridgeMessageWithOptions<{ success: boolean; results?: CommandExecResult[] }>('api:fs:exec', {
      commands,
      cwd: targetCwd,
    }, { timeoutMs: 300000 });

    return {
      success: Boolean(data?.success),
      results: Array.isArray(data?.results) ? data.results : [],
    };
  },

  async downloadFile(path: string): Promise<void> {
    const target = normalizePath(path);
    const url = `/api/fs/raw?path=${encodeURIComponent(target)}&download=true`;
    const a = document.createElement('a');
    a.href = url;
    a.download = target.split('/').pop() || 'file';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  },
});
