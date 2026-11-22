// Fetching a browser panel page's favicon is the one Electron fetch that
// takes its URL from page content, so it is the one that must not trust the
// responding host: a server that stalls would otherwise hold the IPC call
// (and its socket) open forever, and a server that streams an unbounded
// body would grow main-process memory until the post-read size check ran.
// This module owns that fetch: one deadline covering headers and body, a
// declared length above the cap rejected up front, and a body read that
// stops one byte past the cap instead of buffering the whole response.

export const FAVICON_FETCH_TIMEOUT_MS = 10_000;

const timeoutError = () => new Error('Favicon request timed out');

const readBoundedBody = async (response, maxBytes, signal) => {
  if (!response.body || typeof response.body.getReader !== 'function') {
    // A fetch response without a readable body has no bytes to bound; the
    // caller's empty-body check rejects it like a zero-length icon.
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  let abortReject;
  const aborted = new Promise((_, reject) => {
    abortReject = reject;
  });
  const onAbort = () => abortReject(timeoutError());
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('Favicon is not a usable size');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
};

export const fetchFaviconDataUrl = async ({ fetchImpl, url, session, maxBytes, mimeTypes, timeoutMs = FAVICON_FETCH_TIMEOUT_MS }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { session, signal: controller.signal }).catch((error) => {
      if (controller.signal.aborted) throw timeoutError();
      throw error;
    });
    // Rejecting before the body is read is not enough on its own: abort
    // the request and cancel the body so a host that stalls after sending
    // headers cannot hold the connection open past the deadline (which
    // the finally block is about to clear).
    const rejectBeforeRead = async (error) => {
      controller.abort();
      await response.body?.cancel().catch(() => {});
      throw error;
    };
    if (!response.ok) await rejectBeforeRead(new Error(`Favicon request failed (${response.status})`));

    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!mimeTypes.has(mime)) await rejectBeforeRead(new Error('Favicon is not an image'));

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await rejectBeforeRead(new Error('Favicon is not a usable size'));
    }

    let buffer;
    try {
      buffer = await readBoundedBody(response, maxBytes, controller.signal);
    } catch (error) {
      if (controller.signal.aborted && error?.message !== 'Favicon is not a usable size') throw timeoutError();
      throw error;
    }
    // A tab icon is a few kilobytes; anything of a different order is not one,
    // and is not worth holding in memory for every tab.
    if (buffer.length === 0 || buffer.length > maxBytes) {
      throw new Error('Favicon is not a usable size');
    }
    return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}` };
  } finally {
    clearTimeout(timer);
  }
};
