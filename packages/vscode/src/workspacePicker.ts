import * as vscode from 'vscode';
import { normalizeWindowsDriveLetter } from './pathUtils';

export type WorkspaceFolderSelection = {
  directory: string | null;
  cancelled: boolean;
};

export async function selectWorkspaceFolderForNewSession(): Promise<WorkspaceFolderSelection> {
  const folders = vscode.workspace.workspaceFolders || [];

  if (folders.length === 0) {
    return { directory: null, cancelled: false };
  }

  if (folders.length === 1) {
    return { directory: normalizeWindowsDriveLetter(folders[0].uri.fsPath), cancelled: false };
  }

  const items = folders.map((folder) => ({
    label: folder.name,
    description: normalizeWindowsDriveLetter(folder.uri.fsPath),
    folder,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select the project for the new session',
    matchOnDescription: true,
  });

  return picked
    ? { directory: normalizeWindowsDriveLetter(picked.folder.uri.fsPath), cancelled: false }
    : { directory: null, cancelled: true };
}