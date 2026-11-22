import type { JsonValue } from './json-values.js';

export type BoundedResponseText = { tooLarge: false; text: string } | { tooLarge: true };

export type BoundedResponseBytes = { tooLarge: false; bytes: Buffer } | { tooLarge: true };

export type BoundedReadable = Pick<Response, 'headers' | 'body'>;

/**
 * Reads a proxied answer for a guest, refusing anything over `maxBytes`.
 *
 * A cut-off body would reach the guest as a complete answer that fails to
 * parse, so an oversized one is reported instead and the stream is cancelled
 * as soon as it crosses the limit. UTF-8 never decodes to more UTF-16 units
 * than it has bytes, so the text also fits a `maxBytes` character limit.
 */
export const readBoundedResponseText = async (response: BoundedReadable, maxBytes: number): Promise<BoundedResponseText> => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return { tooLarge: true };
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return { tooLarge: false, text: '' };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  return { tooLarge: false, text: Buffer.concat(chunks, size).toString('utf8') };
};

/**
 * Reads and parses a complete JSON body under `maxBytes`. A body that is too
 * large, unreadable, or invalid JSON returns null, matching the callers'
 * existing response.json().catch(() => null) behavior.
 */
export const readBoundedResponseJson = async (response: BoundedReadable, maxBytes: number): Promise<JsonValue> => {
  const bounded: BoundedResponseText = await readBoundedResponseText(response, maxBytes).catch(() => ({ tooLarge: true }));
  if (bounded.tooLarge) return null;
  const text = bounded.text.charCodeAt(0) === 0xfeff ? bounded.text.slice(1) : bounded.text;
  try {
    const parsed: JsonValue = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
};

/**
 * The same bounded read for a binary answer (a surface frame): the cap is
 * enforced while the body streams in, and the stream is cancelled as soon
 * as it crosses the limit, so a body with no declared length cannot grow
 * memory past the cap before a post-read length check would see it.
 */
export const readBoundedResponseBytes = async (response: BoundedReadable, maxBytes: number): Promise<BoundedResponseBytes> => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return { tooLarge: true };
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return { tooLarge: false, bytes: Buffer.alloc(0) };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  return { tooLarge: false, bytes: Buffer.concat(chunks, size) };
};

/**
 * Drops a response body nobody reads (a control/input acknowledgement, a
 * pump answer that is not a frame) without buffering it: the stream is
 * cancelled instead of drained whole into memory just to be thrown away.
 */
export const discardResponseBody = async (response: BoundedReadable) => {
  await response.body?.cancel().catch(() => {});
};
