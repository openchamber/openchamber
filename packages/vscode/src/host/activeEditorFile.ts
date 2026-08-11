export type ActiveEditorFilePayload = {
  filePath: string;
  fileName: string;
  relativePath: string;
  fileSize: number | null;
  selection: { startLine: number; endLine: number; text: string } | null;
};

export const isSameActiveEditorFilePayload = (
  a: ActiveEditorFilePayload | null,
  b: ActiveEditorFilePayload | null,
): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.filePath === b.filePath
    && a.fileName === b.fileName
    && a.relativePath === b.relativePath
    && a.fileSize === b.fileSize
    && a.selection?.startLine === b.selection?.startLine
    && a.selection?.endLine === b.selection?.endLine
    && a.selection?.text === b.selection?.text;
};

export const fileNameFromFsPath = (fsPath: string): string =>
  fsPath.replace(/\\/g, '/').split('/').pop() || '';
