/**
 * The Files view's "canvas": an editor that owns its own document model and
 * is not the text editor. Today that is the built-in Excalidraw editor or an
 * extension's file editor (`contributes.fileEditors`). Both expose the same
 * handle, so saving, autosave, the unsaved-changes prompt, fullscreen, and the
 * source toggle run one path for either.
 */

/**
 * One read of the canvas: the document to write (text, or bytes for a binary
 * editor) and the state it came from.
 */
type FileCanvasSnapshot = { signature: string } & ({ content: string } | { bytes: Uint8Array<ArrayBuffer> });

/** `save` writes the snapshot; `handoff` moves it into the text draft. */
export type FileCanvasSnapshotPurpose = 'save' | 'handoff';

/**
 * A read of the canvas. `snapshot: null` means it has nothing to give yet; a
 * failure carries the message to show, and the caller must not fall back to a
 * stale draft then.
 */
export type FileCanvasRead =
  | { ok: true; snapshot: FileCanvasSnapshot | null }
  | { ok: false; message: string };

export const EMPTY_CANVAS_READ: FileCanvasRead = { ok: true, snapshot: null };

export type FileCanvasHandle = {
  getContent: (purpose: FileCanvasSnapshotPurpose) => FileCanvasRead | Promise<FileCanvasRead>;
  /**
   * Records `signature` (from the snapshot that was written) as saved. Edits
   * made while the write ran differ from it, so the canvas stays dirty.
   */
  markSaved: (signature: string) => void;
};

/**
 * Whether the Files view mounts the canvas. This is the guard that keeps a
 * blank canvas from being serialized over a real document: a draft the canvas
 * cannot open stays in the source editor. `previewReady` covers the frame the
 * view waits for before remounting on a source-to-canvas toggle.
 */
export const shouldShowFileCanvas = (input: {
  hasCanvas: boolean;
  viewMode: 'preview' | 'edit';
  previewReady: boolean;
  mountable: boolean;
}): boolean => input.hasCanvas && input.viewMode === 'preview' && input.previewReady && input.mountable;
