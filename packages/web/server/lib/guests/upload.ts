import type { IncomingHttpHeaders } from 'node:http';

type UploadRequest = AsyncIterable<Buffer | Uint8Array | string> & {
  headers?: IncomingHttpHeaders;
  resume?: () => void;
};
export type UploadResult = { ok: true; buffer: Buffer } | { ok: false; status: number; error: string };
const DEFAULT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

export const guestUploadMaxBytes = () => {
  const raw = Number(process.env.OPENCHAMBER_GUEST_UPLOAD_MAX_BYTES);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return DEFAULT_UPLOAD_MAX_BYTES;
};

const isOctetStream = (contentType: IncomingHttpHeaders[string]) => (
  String(contentType || '').toLowerCase().startsWith('application/octet-stream')
);

export const readGuestUploadBody = async (req: UploadRequest, maxBytes: number): Promise<UploadResult> => {
  if (!isOctetStream(req.headers?.['content-type'])) {
    req.resume?.();
    return { ok: false, status: 415, error: 'unsupported-media-type' };
  }
  const declaredSize = Number(req.headers?.['content-length']);
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    req.resume?.();
    return { ok: false, status: 413, error: 'too-large' };
  }
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.length;
    if (received > maxBytes) {
      req.resume?.();
      return { ok: false, status: 413, error: 'too-large' };
    }
    chunks.push(buffer);
  }
  return { ok: true, buffer: Buffer.concat(chunks, received) };
};
