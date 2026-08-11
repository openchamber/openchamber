import * as vscode from 'vscode';
import { normalizeWindowsDriveLetter } from './pathUtils';
import {
  isSameActiveEditorFilePayload,
  type ActiveEditorFilePayload,
} from './activeEditorFileTypes';

export type { ActiveEditorFilePayload } from './activeEditorFileTypes';

export type ActiveEditorFileBroadcasterOptions = {
  hasTargets: () => boolean;
  postPayload: (payload: ActiveEditorFilePayload | null) => void;
  selectionDebounceMs?: number;
  clearDelayMs?: number;
};

/**
 * Debounced active-editor file + selection broadcast shared by chat sidebar
 * and session editor panels.
 */
export class ActiveEditorFileBroadcaster {
  private broadcastSelectionDebounce: ReturnType<typeof setTimeout> | undefined;
  private clearActiveEditorFileTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPayload: ActiveEditorFilePayload | null = null;
  private readonly selectionDebounceMs: number;
  private readonly clearDelayMs: number;

  constructor(private readonly options: ActiveEditorFileBroadcasterOptions) {
    this.selectionDebounceMs = options.selectionDebounceMs ?? 150;
    this.clearDelayMs = options.clearDelayMs ?? 200;
  }

  public reset(): void {
    this.clearTimers();
    this.lastPayload = null;
  }

  public dispose(): void {
    this.clearTimers();
    this.lastPayload = null;
  }

  public scheduleSelectionBroadcast(): void {
    if (this.broadcastSelectionDebounce !== undefined) {
      clearTimeout(this.broadcastSelectionDebounce);
    }
    this.broadcastSelectionDebounce = setTimeout(() => {
      this.broadcastSelectionDebounce = undefined;
      void this.broadcast();
    }, this.selectionDebounceMs);
  }

  public async broadcast(): Promise<void> {
    if (!this.options.hasTargets()) {
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      this.scheduleClear();
      return;
    }

    const editorUri = editor.document.uri;
    const editorUriKey = editorUri.toString();

    if (this.clearActiveEditorFileTimer !== undefined) {
      clearTimeout(this.clearActiveEditorFileTimer);
      this.clearActiveEditorFileTimer = undefined;
    }

    const filePath = normalizeWindowsDriveLetter(editorUri.fsPath);
    const fileName = editorUri.fsPath.replace(/\\/g, '/').split('/').pop() || '';
    const relativePath = vscode.workspace.asRelativePath(editorUri, false);

    let fileSize: number | null = null;
    try {
      const stat = await vscode.workspace.fs.stat(editorUri);
      fileSize = stat.size;
    } catch {
      // File may not be saved yet or inaccessible.
    }

    if (!this.options.hasTargets()) {
      return;
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
    this.options.postPayload(payload);
  }

  private scheduleClear(): void {
    if (this.clearActiveEditorFileTimer !== undefined) {
      clearTimeout(this.clearActiveEditorFileTimer);
    }
    this.clearActiveEditorFileTimer = setTimeout(() => {
      this.clearActiveEditorFileTimer = undefined;
      if (!this.options.hasTargets() || this.lastPayload === null) {
        return;
      }
      this.lastPayload = null;
      this.options.postPayload(null);
    }, this.clearDelayMs);
  }

  private clearTimers(): void {
    if (this.broadcastSelectionDebounce !== undefined) {
      clearTimeout(this.broadcastSelectionDebounce);
      this.broadcastSelectionDebounce = undefined;
    }
    if (this.clearActiveEditorFileTimer !== undefined) {
      clearTimeout(this.clearActiveEditorFileTimer);
      this.clearActiveEditorFileTimer = undefined;
    }
  }
}
