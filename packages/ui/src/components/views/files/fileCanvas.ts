
type FileCanvasSnapshot = { signature: string } & ({ content: string } | { bytes: Uint8Array<ArrayBuffer> });

export type FileCanvasSnapshotPurpose = 'save' | 'handoff';

export type FileCanvasRead =
  | { ok: true; snapshot: FileCanvasSnapshot | null }
  | { ok: false; message: string };

export const EMPTY_CANVAS_READ: FileCanvasRead = { ok: true, snapshot: null };

export type FileCanvasHandle = {
  getContent: (purpose: FileCanvasSnapshotPurpose) => FileCanvasRead | Promise<FileCanvasRead>;
  markSaved: (signature: string) => void;
};

export const shouldShowFileCanvas = (input: {
  hasCanvas: boolean;
  viewMode: 'preview' | 'edit';
  previewReady: boolean;
  mountable: boolean;
}): boolean => input.hasCanvas && input.viewMode === 'preview' && input.previewReady && input.mountable;
