/**
 * Reads a response body as text with a byte cap enforced while the body
 * streams in. The stream is cancelled as soon as it crosses the cap, so a
 * body with no declared length cannot grow memory past the cap before a
 * post-read length check would see it. An over-cap body throws, which
 * callers treat the same as a fetch failure.
 *
 * The web server has the same read for its own fetches in
 * packages/web/server/lib/shared/response-body.js; that module is
 * server-side and is not importable from the UI bundle, so the UI keeps
 * this copy. Keep the cap semantics in sync: declared length first,
 * then a streamed count, cancel on exceed.
 */
export const readBoundedResponseText = async (response: Response, maxBytes: number): Promise<string> => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Response exceeded size limit of ${maxBytes} bytes`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error(`Response exceeded size limit of ${maxBytes} bytes`);
    }
    return text;
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Response exceeded size limit of ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  }

  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
};
