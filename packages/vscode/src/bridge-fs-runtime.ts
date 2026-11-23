import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { BridgeResponse } from './bridge';

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

type FsAttachment = {
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
};

type SkippedAttachment = {
  name: string;
  reason: string;
};

type DroppedReferenceParse =
  | { uri: vscode.Uri }
  | { skipped: SkippedAttachment };

type ReadUriAsAttachmentResult =
  | { file: FsAttachment }
  | { skipped: SkippedAttachment };

type DirectoryEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
};

// An env value is judged by its whole text, not by what `Number(...)` can
// reinterpret: '' or ' ' must not read as 0, and '1e3', '0x10' or '5.9' must
// not become a number the user never wrote. The web copies of these readers
// judge the same variables this way (`packages/web/server/lib/fs/routes.js`).
const parsePlainDecimalInt = (raw: string | undefined): number | null => {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
};

const createGitCheckIgnoreTimeoutMs = () => {
  const raw = parsePlainDecimalInt(process.env.OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS);
  // A delay above Node's timer maximum (2^31 - 1 ms) fires after ~1 ms
  // instead, so a larger configured timeout falls back to the default
  // rather than killing every check-ignore child immediately.
  if (raw !== null && raw >= 0 && raw <= 2_147_483_647) return raw;
  return 2500;
};

// Byte cap for the api:fs:read handler, matching the web twin
// (MAX_READ_BYTES in packages/web/server/lib/fs/routes.js) and the local-fs
// proxy twin (LOCAL_FS_READ_MAX_BYTES in bridge-localfs-proxy-runtime.ts).
const FS_READ_MAX_BYTES = 16 * 1024 * 1024;

const GIT_CHECK_IGNORE_TIMEOUT_MS = createGitCheckIgnoreTimeoutMs();

const searchAbortControllers = new Map<string, AbortController>();

type FsDeps = {
  resolveUserPath: (value: string, baseDirectory: string) => string;
  listDirectoryEntries: (directoryPath: string) => Promise<DirectoryEntry[]>;
  normalizeFsPath: (value: string) => string;
  execGit: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  searchDirectory: (
    directory: string,
    query: string,
    limit: number | undefined,
    includeHidden: boolean,
    respectGitignore: boolean,
    signal?: AbortSignal,
  ) => Promise<Array<{ name: string; path: string; relativePath: string; extension: string | undefined }>>;
  resolveFileReadPath: (inputPath: string) => Promise<
    | { ok: true; resolvedPath: string }
    | { ok: false; status: number; error: string }
  >;
  resolveDirectoryListPath: (inputPath: string, workspaceRoot: string) => Promise<
    | { ok: true; resolvedPath: string }
    | { ok: false; status: number; error: string }
  >;
  resolveDirectoryCreatePath: (inputPath: string, workspaceRoot: string, additionalRoots?: string[]) => Promise<
    | { ok: true; resolvedPath: string }
    | { ok: false; status: number; error: string }
  >;
  resolveRevealPath: (inputPath: string, workspaceRoot: string, additionalRoots?: string[]) => Promise<
    | { ok: true; resolvedPath: string }
    | { ok: false; status: number; error: string }
  >;
  parseDroppedFileReference: (rawReference: string) => DroppedReferenceParse;
  readUriAsAttachment: (uri: vscode.Uri, name: string) => Promise<ReadUriAsAttachmentResult>;
};

const runGitCheckIgnore = async (
  execGit: FsDeps['execGit'],
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number } | null> => {
  if (GIT_CHECK_IGNORE_TIMEOUT_MS <= 0) {
    return execGit(args, cwd);
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      execGit(args, cwd),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), GIT_CHECK_IGNORE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

export async function handleFsBridgeMessage(
  message: BridgeMessageInput,
  deps: FsDeps,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;

  switch (type) {
    case 'files:list': {
      const { path: dirPath } = payload as { path: string };
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
      const resolvedPath = deps.resolveUserPath(dirPath, workspaceRoot);
      const uri = vscode.Uri.file(resolvedPath);
      const entries = await vscode.workspace.fs.readDirectory(uri);
      const result = entries.map(([name, fileType]) => ({
        name,
        path: vscode.Uri.joinPath(uri, name).fsPath,
        isDirectory: fileType === vscode.FileType.Directory,
      }));
      return { id, type, success: true, data: { directory: deps.normalizeFsPath(resolvedPath), entries: result } };
    }

    case 'files:search': {
      const { query, maxResults = 50 } = payload as { query: string; maxResults?: number };
      const pattern = `**/*${query}*`;
      const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', maxResults);
      const results = files.map((file) => ({
        path: file.fsPath,
      }));
      return { id, type, success: true, data: results };
    }

    case 'workspace:folder': {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
      return { id, type, success: true, data: { folder } };
    }

    case 'config:get': {
      const { key } = payload as { key: string };
      const config = vscode.workspace.getConfiguration('openchamber');
      const value = config.get(key);
      return { id, type, success: true, data: { value } };
    }

    case 'api:fs:list': {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
      const { path: targetPath, respectGitignore } = (payload || {}) as { path?: string; respectGitignore?: boolean };
      const target = targetPath || workspaceRoot;

      const resolution = await deps.resolveDirectoryListPath(target, workspaceRoot);
      if (!resolution.ok) {
        return { id, type, success: false, error: resolution.error };
      }
      const resolvedPath = resolution.resolvedPath;

      const entries = await deps.listDirectoryEntries(resolvedPath);
      const normalized = deps.normalizeFsPath(resolvedPath);

      if (!respectGitignore) {
        return { id, type, success: true, data: { entries, directory: normalized, path: normalized } };
      }

      const pathsToCheck = entries.map((entry) => entry.name).filter(Boolean);
      if (pathsToCheck.length === 0) {
        return { id, type, success: true, data: { entries, directory: normalized, path: normalized } };
      }

      try {
        const result = await runGitCheckIgnore(deps.execGit, ['check-ignore', '--', ...pathsToCheck], normalized);
        if (!result) {
          return { id, type, success: true, data: { entries, directory: normalized, path: normalized } };
        }
        const ignoredNames = new Set(
          result.stdout
            .split('\n')
            .map((name) => name.trim())
            .filter(Boolean)
        );

        const filteredEntries = entries.filter((entry) => !ignoredNames.has(entry.name));
        return { id, type, success: true, data: { entries: filteredEntries, directory: normalized, path: normalized } };
      } catch {
        return { id, type, success: true, data: { entries, directory: normalized, path: normalized } };
      }
    }

    case 'api:fs:search': {
      const { directory = '', query = '', limit, includeHidden, respectGitignore } = (payload || {}) as {
        directory?: string;
        query?: string;
        limit?: number;
        includeHidden?: boolean;
        respectGitignore?: boolean;
      };
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
      // Contain the search root to the active workspace before either search
      // path (RelativePattern or the recursive fallback) consumes it. The
      // shared directory resolver canonicalizes both sides, so a root that
      // escapes through an in-workspace symlink is refused, while a symlink
      // whose canonical target stays inside the workspace is allowed and is
      // searched at that target.
      const resolution = await deps.resolveDirectoryListPath(directory || workspaceRoot, workspaceRoot);
      if (!resolution.ok) {
        return { id, type, success: false, error: resolution.error };
      }
      const abort = new AbortController();
      searchAbortControllers.set(id, abort);
      try {
        const files = await deps.searchDirectory(resolution.resolvedPath, query, limit, Boolean(includeHidden), respectGitignore !== false, abort.signal);
        return { id, type, success: true, data: { files } };
      } finally {
        searchAbortControllers.delete(id);
      }
    }

    case 'api:fs:search:abort': {
      // SAFETY: the payload comes from the webview's own searchFilesRequest; an unknown id stops nothing.
      const { requestID = '' } = (payload || {}) as { requestID?: string };
      searchAbortControllers.get(requestID)?.abort();
      return { id, type, success: true };
    }

    case 'api:fs:mkdir': {
      const { path: target, allowOutsideWorkspace } = (payload || {}) as { path?: string; allowOutsideWorkspace?: unknown };
      if (!target) {
        return { id, type, success: false, error: 'Path is required' };
      }
      // The bridge holds no trusted directory grant, so a caller asking to
      // create outside the workspace is refused outright — the same
      // no-grant behaviour as the web route (POST /api/fs/mkdir in
      // packages/web/server/lib/fs/routes.ts).
      if (allowOutsideWorkspace) {
        return { id, type, success: false, error: 'Outside workspace directory creation requires a grant' };
      }
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
      const chatsRoot = path.join(os.homedir(), '.config', 'openchamber', 'chats');
      const resolution = await deps.resolveDirectoryCreatePath(target, workspaceRoot, [chatsRoot]);
      if (!resolution.ok) {
        return { id, type, success: false, error: resolution.error };
      }
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(resolution.resolvedPath));
      return { id, type, success: true, data: { success: true, path: deps.normalizeFsPath(resolution.resolvedPath) } };
    }

    case 'api:fs/home': {
      const home = os.homedir();
      const chatsRoot = path.join(home, '.config', 'openchamber', 'chats');
      const canonicalChatsRoot = await fs.promises.realpath(chatsRoot).catch(() => undefined);
      return { id, type, success: true, data: {
        home: deps.normalizeFsPath(home),
        chatsRoot: deps.normalizeFsPath(chatsRoot),
        ...(canonicalChatsRoot ? { canonicalChatsRoot: deps.normalizeFsPath(canonicalChatsRoot) } : {}),
      } };
    }

    case 'api:fs:read': {
      const target = (payload as { path: string })?.path;
      if (!target) {
        return { id, type, success: false, error: 'Path is required' };
      }

      const resolution = await deps.resolveFileReadPath(target);
      if (!resolution.ok) {
        return { id, type, success: false, error: resolution.error };
      }

      try {
        const stats = await fs.promises.stat(resolution.resolvedPath);
        if (stats.size > FS_READ_MAX_BYTES) {
          return { id, type, success: false, error: `File exceeds maximum size of ${FS_READ_MAX_BYTES} bytes` };
        }
        // Read at most one byte past the cap, so a file that grows between
        // the stat and the read is refused from a bounded buffer instead of
        // being buffered whole.
        const handle = await fs.promises.open(resolution.resolvedPath, 'r');
        let content: string;
        try {
          const buffer = Buffer.alloc(FS_READ_MAX_BYTES + 1);
          let bytesRead = 0;
          while (bytesRead < buffer.length) {
            const { bytesRead: chunk } = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null);
            if (chunk === 0) break;
            bytesRead += chunk;
          }
          if (bytesRead > FS_READ_MAX_BYTES) {
            return { id, type, success: false, error: `File exceeds maximum size of ${FS_READ_MAX_BYTES} bytes` };
          }
          content = buffer.toString('utf8', 0, bytesRead);
        } finally {
          await handle.close();
        }
        return { id, type, success: true, data: { content, path: deps.normalizeFsPath(resolution.resolvedPath) } };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to read file';
        return { id, type, success: false, error: message };
      }
    }

    case 'api:fs:stat': {
      const target = (payload as { path: string })?.path;
      if (!target) {
        return { id, type, success: false, error: 'Path is required' };
      }

      const resolution = await deps.resolveFileReadPath(target);
      if (!resolution.ok) {
        return { id, type, success: false, error: resolution.error };
      }

      try {
        const stats = await fs.promises.stat(resolution.resolvedPath);
        if (!stats.isFile()) {
          return { id, type, success: false, error: 'Specified path is not a file' };
        }

        return {
          id,
          type,
          success: true,
          data: {
            path: deps.normalizeFsPath(resolution.resolvedPath),
            isFile: true,
            size: stats.size,
            mtimeMs: stats.mtimeMs,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to stat file';
        return { id, type, success: false, error: message };
      }
    }

    case 'api:files/pick': {
      const options = payload as { allowMany?: boolean; extensions?: unknown };
      const allowMany = options?.allowMany !== false;
      const extensions = Array.isArray(options?.extensions)
        ? options.extensions.filter((extension): extension is string => typeof extension === 'string' && extension.length > 0)
        : [];
      const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;

      const picks = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: allowMany,
        defaultUri,
        openLabel: 'Attach',
        filters: extensions.length > 0 ? { Files: extensions } : undefined,
      });

      if (!picks || picks.length === 0) {
        return { id, type, success: true, data: { files: [], skipped: [] } };
      }

      const files: FsAttachment[] = [];
      const skipped: SkippedAttachment[] = [];
      for (const uri of picks) {
        const result = await deps.readUriAsAttachment(uri, path.basename(uri.fsPath || uri.path || uri.toString()));
        if ('file' in result) {
          files.push(result.file);
        } else {
          skipped.push(result.skipped);
        }
      }

      return { id, type, success: true, data: { files, skipped } };
    }

    case 'api:files/drop': {
      const references = (payload as { uris?: string[] })?.uris;
      const sourceUris = Array.isArray(references) ? references.filter((entry) => typeof entry === 'string') : [];
      if (sourceUris.length === 0) {
        return { id, type, success: true, data: { files: [], skipped: [] } };
      }

      const files: FsAttachment[] = [];
      const skipped: SkippedAttachment[] = [];
      const dedupedUris = Array.from(new Set(sourceUris.map((entry) => entry.trim()).filter(Boolean)));

      for (const rawUri of dedupedUris) {
        const parsed = deps.parseDroppedFileReference(rawUri);
        if ('skipped' in parsed) {
          skipped.push(parsed.skipped);
          continue;
        }

        const uri = parsed.uri;
        const name = path.basename(uri.fsPath || uri.path || rawUri);

        const result = await deps.readUriAsAttachment(uri, name);
        if ('file' in result) {
          files.push(result.file);
        } else {
          skipped.push(result.skipped);
        }
      }

      return { id, type, success: true, data: { files, skipped } };
    }

    case 'api:files/save-image': {
      const rawFileName = (payload as { fileName?: unknown })?.fileName;
      const rawDataUrl = (payload as { dataUrl?: unknown })?.dataUrl;
      const dataUrl = typeof rawDataUrl === 'string' ? rawDataUrl.trim() : '';
      if (!dataUrl.startsWith('data:image/')) {
        return { id, type, success: false, error: 'Invalid image payload' };
      }

      const defaultFileName = typeof rawFileName === 'string' && rawFileName.trim().length > 0
        ? rawFileName.trim()
        : `message-${Date.now()}.png`;

      const saveUri = await vscode.window.showSaveDialog({
        saveLabel: 'Save image',
        defaultUri: vscode.workspace.workspaceFolders?.[0]
          ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, defaultFileName)
          : undefined,
        filters: { Images: ['png'] },
      });

      if (!saveUri) {
        return { id, type, success: true, data: { saved: false, canceled: true } };
      }

      const commaIndex = dataUrl.indexOf(',');
      if (commaIndex === -1) {
        return { id, type, success: false, error: 'Invalid image data URL' };
      }

      const base64 = dataUrl.slice(commaIndex + 1);
      const bytes = Buffer.from(base64, 'base64');
      await vscode.workspace.fs.writeFile(saveUri, bytes);

      return { id, type, success: true, data: { saved: true, path: saveUri.fsPath || saveUri.toString() } };
    }

    case 'api:files/save-markdown': {
      const rawFileName = (payload as { fileName?: unknown })?.fileName;
      const rawContent = (payload as { content?: unknown })?.content;
      const content = typeof rawContent === 'string' ? rawContent : '';
      if (!content) {
        return { id, type, success: false, error: 'Invalid markdown payload' };
      }

      const defaultFileName = typeof rawFileName === 'string' && rawFileName.trim().length > 0
        ? rawFileName.trim()
        : `session-${Date.now()}.md`;

      const saveUri = await vscode.window.showSaveDialog({
        saveLabel: 'Export session',
        defaultUri: vscode.workspace.workspaceFolders?.[0]
          ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, defaultFileName)
          : undefined,
        filters: { Markdown: ['md'] },
      });

      if (!saveUri) {
        return { id, type, success: true, data: { saved: false, canceled: true } };
      }

      await vscode.workspace.fs.writeFile(saveUri, Buffer.from(content, 'utf8'));

      return { id, type, success: true, data: { saved: true, path: saveUri.fsPath || saveUri.toString() } };
    }

    case 'api:fs:reveal': {
      const targetPath = (payload as { path?: unknown })?.path;
      const value = typeof targetPath === 'string' ? targetPath.trim() : '';
      if (!value) {
        return { id, type, success: false, error: 'Path is required' };
      }

      try {
        // Reveal is a host-side capability: only a local file path inside
        // the active workspace (or the managed chats root) may be handed to
        // the OS file browser. A non-file URI names no local path to
        // contain, so it is refused rather than passed through.
        let fsPath = value;
        if (value.includes('://')) {
          const uri = vscode.Uri.parse(value);
          if (uri.scheme !== 'file') {
            return { id, type, success: false, error: 'Only local file paths can be revealed' };
          }
          fsPath = uri.fsPath;
        }
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
        const chatsRoot = path.join(os.homedir(), '.config', 'openchamber', 'chats');
        const resolution = await deps.resolveRevealPath(fsPath, workspaceRoot, [chatsRoot]);
        if (!resolution.ok) {
          return { id, type, success: false, error: resolution.error };
        }
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(resolution.resolvedPath));
        return { id, type, success: true, data: { success: true } };
      } catch {
        return { id, type, success: false, error: 'Failed to reveal path' };
      }
    }

    default:
      return null;
  }
}
