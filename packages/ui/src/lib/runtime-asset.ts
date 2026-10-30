import { isCapacitorApp } from './platform';
import { getRuntimeExtraHeadersSync } from './runtime-auth';

export const runtimeAssetsNeedHeaders = (): boolean =>
  isCapacitorApp() && Object.keys(getRuntimeExtraHeadersSync()).length > 0;

/** Bounds retained bytes even when Content-Length is absent or inaccurate. */
export const readAssetBlob = async (response: Response, maxBytes: number, signal: AbortSignal): Promise<Blob> => {
  const reader = response.body?.getReader();
  if (!reader) return new Blob([], { type: response.headers.get('content-type') || '' });
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Asset exceeds preview limit');
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Asset exceeds preview limit');
      chunks.push(new Uint8Array(value));
    }
    return new Blob(chunks, { type: response.headers.get('content-type') || '' });
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
};
