import * as vscode from 'vscode';
import { normalizeWindowsDriveLetter } from '../pathUtils';
import {
  fileNameFromFsPath,
  isSameActiveEditorFilePayload,
  type ActiveEditorFilePayload,
} from './activeEditorFile';
import { postHostCommand } from './webviewMessaging';

type BroadcastTarget = {
  post: (command: string, payload: unknown) => void;
  isLive: () => boolean;
};

/**
 * Debounced active-editor + selection broadcast shared by chat and session editor hosts.
 */
export class ActiveEditorBroadcaster {
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private clearTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPayload: ActiveEditorFilePayload | null = null;

  constructor(private readonly getTargets: () => BroadcastTarget[]) {}

  clearTimers(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.clearTimer !== undefined) {
      clearTimeout(this.clearTimer);
      this.clearTimer = undefined;
    }
  }

  dispose(): void {
    this.clearTimers();
    this.lastPayload = null;
  }

  resetLastPayload(): void {
    this.lastPayload = null;
  }

  schedule(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.broadcast();
    }, 150);
  }

  async broadcast(): Promise<void> {
    const targets = this.getTargets().filter((target) => target.isLive());
    if (targets.length === 0) {
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      this.scheduleClear();
      return;
    }

    const editorUri = editor.document.uri;
    const editorUriKey = editorUri.toString();

    if (this.clearTimer !== undefined) {
      clearTimeout(this.clearTimer);
      this.clearTimer = undefined;
    }

    const filePath = normalizeWindowsDriveLetter(editorUri.fsPath);
    const fileName = fileNameFromFsPath(editorUri.fsPath);
    const relativePath = vscode.workspace.asRelativePath(editorUri, false);

    let fileSize: number | null = null;
    try {
      const stat = await vscode.workspace.fs.stat(editorUri);
      fileSize = stat.size;
    } catch {
      // File may not be saved yet or inaccessible
    }

    if (vscode.window.activeTextEditor?.document.uri.toString() !== editorUriKey) {
      return;
    }

    let selection: ActiveEditorFilePayload['selection'] = null;
    if (!editor.selection.isEmpty) {
      selection = {
        startLine: editor.selection.start.line + 1,
        endLine: editor.selection.end.line + 1,
        text: editor.document.getText(editor.selection),
      };
    }

    const payload: ActiveEditorFilePayload = { filePath, fileName, relativePath, fileSize, selection };
    if (isSameActiveEditorFilePayload(this.lastPayload, payload)) {
      return;
    }
    this.lastPayload = payload;

    for (const target of this.getTargets()) {
      if (!target.isLive()) continue;
      target.post('activeEditorFile', payload);
    }
  }

  private scheduleClear(): void {
    if (this.clearTimer !== undefined) {
      clearTimeout(this.clearTimer);
    }
    this.clearTimer = setTimeout(() => {
      this.clearTimer = undefined;
      if (this.lastPayload === null) {
        return;
      }
      this.lastPayload = null;
      for (const target of this.getTargets()) {
        if (!target.isLive()) continue;
        target.post('activeEditorFile', null);
      }
    }, 200);
  }
}

export const webviewCommandPoster = (webview: vscode.Webview) => (command: string, payload?: unknown) => {
  postHostCommand(webview, command, payload);
};
