/**
 * Reads a proxied answer for a guest, refusing anything over `maxBytes`.
 *
 * A cut-off body would reach the guest as a complete answer that fails to
 * parse, so an oversized one is reported instead and the stream is cancelled
 * as soon as it crosses the limit. UTF-8 never decodes to more UTF-16 units
 * than it has bytes, so the text also fits a `maxBytes` character limit.
 *
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<{ tooLarge: false, text: string } | { tooLarge: true }>}
 */
export const readBoundedResponseText = async (response, maxBytes) => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return { tooLarge: true };
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return { tooLarge: false, text: '' };
  }
  const chunks = [];
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
