import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export type WorkspaceFolderInfo = {
  name: string;
  path: string;
  index: number;
};

export type WorkspaceContextPayload = {
  workspaceFolder: string;
  activeWorkspaceFolder: string;
  workspaceFolders: WorkspaceFolderInfo[];
};

const normalizeWorkspacePath = (value: string): string => {
  const normalized = value.replace(/\\/g, '/');
  if (normalized === '/') {
    return '/';
  }
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

const toWorkspaceFolderInfo = (folder: vscode.WorkspaceFolder): WorkspaceFolderInfo => {
  return {
    name: folder.name,
    path: normalizeWorkspacePath(folder.uri.fsPath),
    index: vscode.workspace.workspaceFolders?.findIndex((entry) => entry.uri.toString() === folder.uri.toString()) ?? 0,
  };
};

export const getWorkspaceFolders = (): WorkspaceFolderInfo[] => {
  return (vscode.workspace.workspaceFolders || []).map(toWorkspaceFolderInfo);
};

export const getWorkspaceFolderForUri = (uri: vscode.Uri | undefined): WorkspaceFolderInfo | null => {
  if (!uri) {
    return null;
  }

  const folder = vscode.workspace.getWorkspaceFolder(uri);
  return folder ? toWorkspaceFolderInfo(folder) : null;
};

export const findWorkspaceFolderForPath = (targetPath?: string | null): WorkspaceFolderInfo | null => {
  if (!targetPath || !targetPath.trim()) {
    return null;
  }

  const normalizedTarget = normalizeWorkspacePath(path.resolve(targetPath));
  const folders = getWorkspaceFolders();
  let matched: WorkspaceFolderInfo | null = null;

  for (const folder of folders) {
    const folderPath = normalizeWorkspacePath(path.resolve(folder.path));
    if (
      normalizedTarget === folderPath
      || normalizedTarget.startsWith(`${folderPath}/`)
    ) {
      if (!matched || folderPath.length > matched.path.length) {
        matched = folder;
      }
    }
  }

  return matched;
};

export const getActiveWorkspaceFolder = (): WorkspaceFolderInfo | null => {
  const activeEditorFolder = getWorkspaceFolderForUri(vscode.window.activeTextEditor?.document.uri);
  if (activeEditorFolder) {
    return activeEditorFolder;
  }

  const folders = getWorkspaceFolders();
  return folders[0] ?? null;
};

export const getActiveWorkspaceFolderPath = (): string => {
  return getActiveWorkspaceFolder()?.path || '';
};

export const getWorkspaceContextPayload = (): WorkspaceContextPayload => {
  const workspaceFolders = getWorkspaceFolders();
  const activeWorkspaceFolder = getActiveWorkspaceFolder()?.path || workspaceFolders[0]?.path || '';

  return {
    workspaceFolder: activeWorkspaceFolder,
    activeWorkspaceFolder,
    workspaceFolders,
  };
};

export const getWorkspaceFallbackPath = (): string => {
  return getActiveWorkspaceFolderPath() || getWorkspaceFolders()[0]?.path || normalizeWorkspacePath(os.homedir());
};
