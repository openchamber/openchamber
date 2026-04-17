import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { BridgeResponse } from './bridge';
import { getActiveWorkspaceFolderPath, getWorkspaceContextPayload } from './workspaceRoots';

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

type FsDeps = {
  resolveUserPath: (value: string, baseDirectory: string) => string;
  resolveWorkspacePath: (value: string, baseDirectory?: string | null) =>
    | { ok: true; resolvedPath: string; workspaceRoot: string | null }
    | { ok: false; status: number; error: string };
  listDirectoryEntries: (directoryPath: string) => Promise<DirectoryEntry[]>;
  normalizeFsPath: (value: string) => string;
  execGit: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  searchDirectory: (
    directory: string,
    query: string,
    limit: number | undefined,
    includeHidden: boolean,
    respectGitignore: boolean,
  ) => Promise<Array<{ name: string; path: string; relativePath: string; extension: string | undefined }>>;
  resolveFileReadPath: (inputPath: string) => Promise<
    | { ok: true; resolvedPath: string }
    | { ok: false; status: number; error: string }
  >;
  parseDroppedFileReference: (rawReference: string) => DroppedReferenceParse;
  readUriAsAttachment: (uri: vscode.Uri, name: string) => Promise<ReadUriAsAttachmentResult>;
};

export async function handleFsBridgeMessage(
  message: BridgeMessageInput,
  deps: FsDeps,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;
  const getDefaultWorkspaceRoot = () => getActiveWorkspaceFolderPath() || os.homedir();

  switch (type) {
    case 'files:list': {
      const { path: dirPath } = payload as { path: string };
      const workspaceRoot = getDefaultWorkspaceRoot();
      const target = typeof dirPath === 'string' && dirPath.trim() ? dirPath : workspaceRoot;
      const resolution = deps.resolveWorkspacePath(target, workspaceRoot);
      if (!resolution.ok) {
        return { id, type, success: false, error: resolution.error };
      }
      const resolvedPath = resolution.resolvedPath;
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
      const workspaceRoot = getActiveWorkspaceFolderPath();
      if (!workspaceRoot) {
        return { id, type, success: true, data: [] };
      }
      const pattern = `**/*${query}*`;
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(vscode.Uri.file(workspaceRoot), pattern),
        '**/node_modules/**',
        maxResults,
      );
      const results = files.map((file) => ({
        path: file.fsPath,
      }));
      return { id, type, success: true, data: results };
    }

    case 'workspace:folder': {
      const context = getWorkspaceContextPayload();
      return {
        id,
        type,
        success: true,
        data: {
          folder: context.workspaceFolder,
          activeFolder: context.activeWorkspaceFolder,
          folders: context.workspaceFolders,
        },
      };
    }

    case 'config:get': {
      const { key } = payload as { key: string };
      const config = vscode.workspace.getConfiguration('openchamber');
      const value = config.get(key);
      return { id, type, success: true, data: { value } };
    }

    case 'api:fs:list': {
      const workspaceRoot = getDefaultWorkspaceRoot();
      const { path: targetPath, respectGitignore } = (payload || {}) as { path?: string; respectGitignore?: boolean };
      const target = targetPath || workspaceRoot;
      const resolution = deps.resolveWorkspacePath(target, workspaceRoot);
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
        const result = await deps.execGit(['check-ignore', '--', ...pathsToCheck], normalized);
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
      const files = await deps.searchDirectory(directory, query, limit, Boolean(includeHidden), respectGitignore !== false);
      return { id, type, success: true, data: { files } };
    }

    case 'api:fs:mkdir': {
      const target = (payload as { path: string })?.path;
      if (!target) {
        return { id, type, success: false, error: 'Path is required' };
      }
      const workspaceRoot = getDefaultWorkspaceRoot();
      const resolution = deps.resolveWorkspacePath(target, workspaceRoot);
      if (!resolution.ok) {
        return { id, type, success: false, error: resolution.error };
      }
      const resolvedPath = resolution.resolvedPath;
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(resolvedPath));
      return { id, type, success: true, data: { success: true, path: deps.normalizeFsPath(resolvedPath) } };
    }

    case 'api:fs/home': {
      return { id, type, success: true, data: { home: deps.normalizeFsPath(os.homedir()) } };
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
        const content = await fs.promises.readFile(resolution.resolvedPath, 'utf8');
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
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to stat file';
        return { id, type, success: false, error: message };
      }
    }

    case 'api:fs:write': {
      const { path: targetPath, content } = (payload as { path: string; content: string }) || {};
      if (!targetPath) {
        return { id, type, success: false, error: 'Path is required' };
      }
      if (typeof content !== 'string') {
        return { id, type, success: false, error: 'Content is required' };
      }
      try {
        const workspaceRoot = getDefaultWorkspaceRoot();
        const resolution = deps.resolveWorkspacePath(targetPath, workspaceRoot);
        if (!resolution.ok) {
          return { id, type, success: false, error: resolution.error };
        }
        const resolvedPath = resolution.resolvedPath;
        const uri = vscode.Uri.file(resolvedPath);
        const parentUri = vscode.Uri.file(path.dirname(resolvedPath));
        try {
          await vscode.workspace.fs.createDirectory(parentUri);
        } catch {
          // Directory may already exist
        }
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        return { id, type, success: true, data: { success: true, path: deps.normalizeFsPath(resolvedPath) } };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to write file';
        return { id, type, success: false, error: message };
      }
    }

    case 'api:fs:delete': {
      const targetPath = (payload as { path: string })?.path;
      if (!targetPath) {
        return { id, type, success: false, error: 'Path is required' };
      }
      try {
        const workspaceRoot = getDefaultWorkspaceRoot();
        const resolution = deps.resolveWorkspacePath(targetPath, workspaceRoot);
        if (!resolution.ok) {
          return { id, type, success: false, error: resolution.error };
        }
        const resolvedPath = resolution.resolvedPath;
        const uri = vscode.Uri.file(resolvedPath);
        await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
        return { id, type, success: true, data: { success: true } };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete file';
        return { id, type, success: false, error: message };
      }
    }

    case 'api:fs:rename': {
      const { oldPath, newPath } = (payload as { oldPath: string; newPath: string }) || {};
      if (!oldPath) {
        return { id, type, success: false, error: 'oldPath is required' };
      }
      if (!newPath) {
        return { id, type, success: false, error: 'newPath is required' };
      }
      try {
        const workspaceRoot = getDefaultWorkspaceRoot();
        const oldResolution = deps.resolveWorkspacePath(oldPath, workspaceRoot);
        if (!oldResolution.ok) {
          return { id, type, success: false, error: oldResolution.error };
        }
        const newResolution = deps.resolveWorkspacePath(newPath, workspaceRoot);
        if (!newResolution.ok) {
          return { id, type, success: false, error: newResolution.error };
        }
        const resolvedOld = oldResolution.resolvedPath;
        const resolvedNew = newResolution.resolvedPath;
        const oldUri = vscode.Uri.file(resolvedOld);
        const newUri = vscode.Uri.file(resolvedNew);
        await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: false });
        return { id, type, success: true, data: { success: true, path: deps.normalizeFsPath(resolvedNew) } };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to rename file';
        return { id, type, success: false, error: message };
      }
    }

    case 'api:fs:exec': {
      const { commands, cwd } = (payload as { commands: string[]; cwd: string }) || {};
      if (!Array.isArray(commands) || commands.length === 0) {
        return { id, type, success: false, error: 'Commands array is required' };
      }
      if (!cwd) {
        return { id, type, success: false, error: 'Working directory (cwd) is required' };
      }
      try {
        const workspaceRoot = getDefaultWorkspaceRoot();
        const resolution = deps.resolveWorkspacePath(cwd, workspaceRoot);
        if (!resolution.ok) {
          return { id, type, success: false, error: resolution.error };
        }
        const resolvedCwd = resolution.resolvedPath;
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        const shell = process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
        const shellFlag = process.platform === 'win32' ? '/c' : '-c';

        const augmentedEnv = {
          ...process.env,
          PATH: process.env.PATH,
        };

        const results: Array<{
          command: string;
          success: boolean;
          exitCode?: number;
          stdout?: string;
          stderr?: string;
          error?: string;
        }> = [];

        for (const cmd of commands) {
          if (typeof cmd !== 'string' || !cmd.trim()) {
            results.push({ command: cmd, success: false, error: 'Invalid command' });
            continue;
          }
          try {
            const { stdout, stderr } = await execAsync(`${shell} ${shellFlag} "${cmd.replace(/"/g, '\\"')}"`, {
              cwd: resolvedCwd,
              env: augmentedEnv,
              timeout: 300000,
            });
            results.push({
              command: cmd,
              success: true,
              exitCode: 0,
              stdout: (stdout || '').trim(),
              stderr: (stderr || '').trim(),
            });
          } catch (execError) {
            const err = execError as { code?: number; stdout?: string; stderr?: string; message?: string };
            results.push({
              command: cmd,
              success: false,
              exitCode: typeof err.code === 'number' ? err.code : 1,
              stdout: (err.stdout || '').trim(),
              stderr: (err.stderr || '').trim(),
              error: err.message,
            });
          }
        }

        const allSucceeded = results.every((r) => r.success);
        return { id, type, success: true, data: { success: allSucceeded, results } };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to execute commands';
        return { id, type, success: false, error: message };
      }
    }

    case 'api:files/pick': {
      const allowMany = (payload as { allowMany?: boolean })?.allowMany !== false;
      const defaultFolder = getActiveWorkspaceFolderPath();
      const defaultUri = defaultFolder ? vscode.Uri.file(defaultFolder) : undefined;

      const picks = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: allowMany,
        defaultUri,
        openLabel: 'Attach',
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
      const defaultFolder = getActiveWorkspaceFolderPath();

      const saveUri = await vscode.window.showSaveDialog({
        saveLabel: 'Save image',
        defaultUri: defaultFolder
          ? vscode.Uri.joinPath(vscode.Uri.file(defaultFolder), defaultFileName)
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

    default:
      return null;
  }
}
