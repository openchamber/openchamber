import { describe, expect, test } from 'bun:test';

import { canMountBinaryCanvas, FileCanvasTooLargeError, readCanvasResponseBytes, resolveFileCanvasSave, shouldShowFileCanvas, type FileCanvasHandle } from './fileCanvas';

describe('shouldShowFileCanvas', () => {
  const shown = (overrides: Partial<Parameters<typeof shouldShowFileCanvas>[0]>) =>
    shouldShowFileCanvas({ hasCanvas: true, viewMode: 'preview', previewReady: true, mountable: true, ...overrides });

  test('mounts a canvas that can open the draft, in preview, once the file loaded', () => {
    expect(shown({})).toBe(true);
  });

  test('never mounts over a draft the canvas cannot take, so a blank document cannot be saved over it', () => {
    expect(shown({ mountable: false })).toBe(false);
  });

  test('stays off in source mode, before the file finished loading, and for files without a canvas', () => {
    expect(shown({ viewMode: 'edit' })).toBe(false);
    expect(shown({ previewReady: false })).toBe(false);
    expect(shown({ hasCanvas: false })).toBe(false);
  });
});

describe('readCanvasResponseBytes', () => {
  const streamOf = (chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
    new ReadableStream({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    });

  test('refuses a declared Content-Length over the cap before buffering the body', async () => {
    const response = new Response(streamOf([new Uint8Array(64)]), {
      headers: { 'content-length': '64' },
    });
    await expect(readCanvasResponseBytes(response, 16)).rejects.toBeInstanceOf(FileCanvasTooLargeError);
  });

  test('cuts off a streamed body that grows past the cap with no declared length', async () => {
    const response = new Response(streamOf([new Uint8Array(10), new Uint8Array(10), new Uint8Array(10)]));
    await expect(readCanvasResponseBytes(response, 16)).rejects.toBeInstanceOf(FileCanvasTooLargeError);
  });

  test('refuses a body over the cap when the response has no stream', async () => {
    const response = new Response(null, { headers: { 'content-length': '4' } });
    Object.defineProperty(response, 'body', { value: null });
    Object.defineProperty(response, 'arrayBuffer', { value: async () => new Uint8Array(32).buffer });
    await expect(readCanvasResponseBytes(response, 16)).rejects.toBeInstanceOf(FileCanvasTooLargeError);
  });

  test('loads an at-cap file byte-identically', async () => {
    const payload = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255, 9, 8, 7, 6, 5, 4]);
    const response = new Response(streamOf([payload.slice(0, 6), payload.slice(6)]), {
      headers: { 'content-length': String(payload.byteLength) },
    });
    const bytes = await readCanvasResponseBytes(response, 16);
    expect(bytes).toEqual(payload);
  });
});

describe('canMountBinaryCanvas', () => {
  test('judges a known size against the cap', () => {
    expect(canMountBinaryCanvas(16, false, 16)).toBe(true);
    expect(canMountBinaryCanvas(17, true, 16)).toBe(false);
  });

  test('waits while the stat is in flight, and mounts on a settled stat with no size', () => {
    expect(canMountBinaryCanvas(null, false, 16)).toBe(false);
    expect(canMountBinaryCanvas(null, true, 16)).toBe(true);
  });
});

describe('resolveFileCanvasSave', () => {
  const handle = (content: string): FileCanvasHandle => ({
    getContent: () => ({ ok: true, snapshot: { signature: 'sig', content } }),
    markSaved: () => {},
  });

  test('dirty canvas with a live editor resolves to a snapshot of that editor', () => {
    const canvas = handle('guest edits');
    const resolution = resolveFileCanvasSave({ canvasDirty: true, canvas });
    expect(resolution.kind).toBe('snapshot');
    if (resolution.kind === 'snapshot') {
      expect(resolution.canvas).toBe(canvas);
    }
  });

  test('dirty canvas whose editor disappeared is blocked instead of falling back to the draft', () => {
    // Regression: a guest editor edited the file, then was paused/removed
    // before save, leaving canvasDirty set with no handle. The save must
    // fail closed; resolving to the text draft would silently replace the
    // guest edits with the old content and report success.
    const resolution = resolveFileCanvasSave({ canvasDirty: true, canvas: null });
    expect(resolution.kind).toBe('blocked-missing-editor');
  });

  test('clean canvas with no editor resolves to the plain draft save', () => {
    // Pausing/removing an editor with no unsaved edits keeps working:
    // nothing is dirty, so the save proceeds from the text draft.
    expect(resolveFileCanvasSave({ canvasDirty: false, canvas: null }).kind).toBe('no-canvas');
  });

  test('clean canvas does not consult a mounted editor handle', () => {
    expect(resolveFileCanvasSave({ canvasDirty: false, canvas: handle('x') }).kind).toBe('no-canvas');
  });
});
