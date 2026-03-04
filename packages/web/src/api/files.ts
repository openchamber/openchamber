import type {
  DirectoryListResult,
  FileStatResult,
  FileSearchQuery,
  FileSearchResult,
  FilesAPI,
  UploadFileOptions,
  UploadFileResult,
  WriteFileOptions,
  WriteFileResult,
} from '@openchamber/ui/lib/api/types';

const normalizePath = (path: string): string => path.replace(/\\/g, '/');

type WebDirectoryEntry = {
  name?: string;
  path?: string;
  isDirectory?: boolean;
  isFile?: boolean;
  isSymbolicLink?: boolean;
  size?: number;
  modifiedTime?: number;
};

type WebDirectoryListResponse = {
  directory?: string;
  path?: string;
  entries?: WebDirectoryEntry[];
};

const toDirectoryListResult = (fallbackDirectory: string, payload: WebDirectoryListResponse): DirectoryListResult => {
  const directory = normalizePath(payload?.directory || payload?.path || fallbackDirectory);
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];

  return {
    directory,
    entries: entries
      .filter((entry): entry is WebDirectoryEntry & { name: string; path: string } =>
        Boolean(entry && typeof entry.name === 'string' && typeof entry.path === 'string')
      )
      .map((entry) => ({
        name: entry.name,
        path: normalizePath(entry.path),
        isDirectory: Boolean(entry.isDirectory),
        size: typeof entry.size === 'number' ? entry.size : undefined,
        modifiedTime: typeof entry.modifiedTime === 'number' ? entry.modifiedTime : undefined,
      })),
  };
};

type WebFileStatResponse = {
  path?: string;
  isDirectory?: boolean;
  isFile?: boolean;
  size?: number;
  modifiedTime?: number;
};

export const createWebFilesAPI = (): FilesAPI => ({
  async listDirectory(path: string): Promise<DirectoryListResult> {
    const target = normalizePath(path);
    const params = new URLSearchParams();
    if (target) {
      params.set('path', target);
    }

    const response = await fetch(`/api/fs/list${params.toString() ? `?${params.toString()}` : ''}`);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to list directory');
    }

    const result = (await response.json()) as WebDirectoryListResponse;
    return toDirectoryListResult(target, result);
  },

  async stat(path: string): Promise<FileStatResult> {
    const target = normalizePath(path);
    const response = await fetch(`/api/fs/stat?path=${encodeURIComponent(target)}`);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to stat file');
    }

    const result = (await response.json()) as WebFileStatResponse;
    return {
      path: typeof result.path === 'string' ? normalizePath(result.path) : target,
      isDirectory: Boolean(result.isDirectory),
      isFile: Boolean(result.isFile),
      size: typeof result.size === 'number' ? result.size : undefined,
      modifiedTime: typeof result.modifiedTime === 'number' ? result.modifiedTime : undefined,
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
    const response = await fetch('/api/fs/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

  async readFile(path: string): Promise<{ content: string; path: string }> {
    const target = normalizePath(path);
    const response = await fetch(`/api/fs/read?path=${encodeURIComponent(target)}`);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to read file');
    }

    const content = await response.text();
    return { content, path: target };
  },

  async uploadFile(path: string, file: Blob, options?: UploadFileOptions): Promise<UploadFileResult> {
    const target = normalizePath(path);

    const expectedSize = Number.isFinite(options?.expectedSizeBytes)
      ? Number(options?.expectedSizeBytes)
      : Number.isFinite(file.size)
        ? file.size
        : undefined;

    const result = await new Promise<UploadFileResult>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('PUT', `/api/fs/upload?path=${encodeURIComponent(target)}`);
      request.setRequestHeader('x-openchamber-upload-encoding', 'binary');
      if (typeof expectedSize === 'number') {
        request.setRequestHeader('x-openchamber-expected-size', String(expectedSize));
      }

      request.upload.onprogress = (event) => {
        const totalBytes = event.lengthComputable ? event.total : (typeof expectedSize === 'number' ? expectedSize : 0);
        options?.onProgress?.({
          loadedBytes: event.loaded,
          totalBytes,
        });
      };

      request.onerror = () => {
        reject(new Error('Failed to upload file'));
      };

      request.onload = () => {
        const status = request.status;
        const rawResponse = typeof request.responseText === 'string' ? request.responseText : '';
        const payload = (() => {
          try {
            return JSON.parse(rawResponse) as { success?: boolean; path?: string; sizeBytes?: number; error?: string };
          } catch {
            return null;
          }
        })();

        if (status >= 200 && status < 300) {
          resolve({
            success: Boolean(payload?.success),
            path: typeof payload?.path === 'string' ? normalizePath(payload.path) : target,
            sizeBytes: typeof payload?.sizeBytes === 'number' ? payload.sizeBytes : undefined,
          });
          return;
        }

        const fallbackError = status === 413
          ? 'Upload payload is too large for current server or proxy limits'
          : 'Failed to upload file';

        reject(new Error(payload?.error || rawResponse.trim() || fallbackError));
      };

      request.send(file);
    });

    return result;
  },

  async writeFile(path: string, content: string, options?: WriteFileOptions): Promise<WriteFileResult> {
    const target = normalizePath(path);
    const response = await fetch('/api/fs/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: target,
        content,
        encoding: options?.encoding,
        expectedSizeBytes: options?.expectedSizeBytes,
      }),
    });

    if (!response.ok) {
      const error = await response
        .json()
        .catch(async () => ({ error: (await response.text().catch(() => response.statusText)) || response.statusText }));

      if (response.status === 413) {
        throw new Error((error as { error?: string }).error || 'Upload payload is too large for current server limits');
      }

      throw new Error((error as { error?: string }).error || 'Failed to write file');
    }

    const result = await response.json().catch(() => ({}));
    return {
      success: Boolean((result as { success?: boolean }).success),
      path: typeof (result as { path?: string }).path === 'string' ? normalizePath((result as { path: string }).path) : target,
      sizeBytes: typeof (result as { sizeBytes?: number }).sizeBytes === 'number'
        ? (result as { sizeBytes: number }).sizeBytes
        : undefined,
    };
  },

  async delete(path: string): Promise<{ success: boolean }> {
    const target = normalizePath(path);
    const response = await fetch('/api/fs/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    const response = await fetch('/api/fs/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    const response = await fetch('/api/fs/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: normalizePath(targetPath) }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to reveal path');
    }

    const result = await response.json().catch(() => ({}));
    return { success: Boolean((result as { success?: boolean }).success) };
  },
});
