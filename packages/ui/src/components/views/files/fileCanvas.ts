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

/**
 * A canvas byte read whose size passed the editor cap before the bytes were
 * buffered: the declared length was over the cap, or the streamed body grew
 * past it. Callers route this to the too-large outcome; other read failures
 * stay read failures.
 */
export class FileCanvasTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`File exceeds the ${maxBytes}-byte editor limit.`);
    this.name = 'FileCanvasTooLargeError';
  }
}

/**
 * Reads a raw-file response into bytes, judging the size before and during
 * the read so a file over `maxBytes` is never buffered whole: a declared
 * `Content-Length` over the cap refuses before the body is touched, and a
 * streamed body (no length, or a lying one) is cut off the moment its bytes
 * pass the cap. Throws `FileCanvasTooLargeError` in both cases.
 */
export const readCanvasResponseBytes = async (response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> => {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new FileCanvasTooLargeError(maxBytes);
  }
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new FileCanvasTooLargeError(maxBytes);
    return new Uint8Array(buffer);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new FileCanvasTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/**
 * Whether the binary canvas may mount for a file of `artifactSize` bytes.
 * A known size judges directly. An unknown size mounts only once the stat
 * has settled without one (host has no stat, or it failed): the mount then
 * relies on `readCanvasResponseBytes` to judge the read itself. While the
 * stat is still in flight the size is unknown-and-unjudged, so the canvas
 * waits instead of firing an unbounded read.
 */
export const canMountBinaryCanvas = (artifactSize: number | null, statSettled: boolean, maxBytes: number): boolean =>
  artifactSize !== null ? artifactSize <= maxBytes : statSettled;
