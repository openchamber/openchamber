
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

export type FileCanvasSaveResolution =
  | { kind: 'snapshot'; canvas: FileCanvasHandle }
  | { kind: 'no-canvas' }
  | { kind: 'blocked-missing-editor' };

/**
 * Decides where a save gets its canvas content from. A canvas that is dirty
 * but whose editor handle is gone (a guest editor paused or removed before
 * its content could be handed to the text draft) must fail closed: the draft
 * does not hold the canvas edits, so writing it would silently discard them
 * while reporting success. A clean canvas resolves to the plain draft save
 * whether or not an editor is still mounted, so removing an editor with no
 * unsaved edits keeps working normally.
 */
export const resolveFileCanvasSave = (input: {
  canvasDirty: boolean;
  canvas: FileCanvasHandle | null;
}): FileCanvasSaveResolution => {
  if (!input.canvasDirty) return { kind: 'no-canvas' };
  if (!input.canvas) return { kind: 'blocked-missing-editor' };
  return { kind: 'snapshot', canvas: input.canvas };
};

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
