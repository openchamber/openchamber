import { parseBoundedIntWithDefault } from '../shared/parse-int.js';

/**
 * Body handling for `POST /api/guests/upload`: a raw zip sent as
 * `application/octet-stream`. The archive is collected into memory (the
 * install path works on a buffer) under a configurable cap, so a remote or
 * web user can add an extension without a path on the server. Nothing from
 * the archive is ever logged.
 */

const DEFAULT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

// A whole number from the environment, else null. The strict plain-decimal
// judgement lives in shared/parse-int.js (design #802 phase 2, #804): a bare
// Number(...) would silently honour '' and ' ' as 0, '1e3' as 1000, '0x10' as
// 16, and '5.9' as a fractional value.
const parsePlainDecimalInt = (raw) => parseBoundedIntWithDefault(raw, null, 0, Number.MAX_SAFE_INTEGER);

export const guestUploadMaxBytes = () => {
  const raw = parsePlainDecimalInt(process.env.OPENCHAMBER_GUEST_UPLOAD_MAX_BYTES);
  if (raw !== null && raw > 0) return raw;
  return DEFAULT_UPLOAD_MAX_BYTES;
};

const isOctetStream = (contentType) => (
  String(contentType || '').toLowerCase().startsWith('application/octet-stream')
);

/**
 * Reads the upload body. `req` is the Express request (headers plus an
 * async-iterable body). Answers `{ ok: true, buffer }`, or `{ ok: false,
 * status, error }` with 415 for a wrong content type and 413 when either the
 * declared `Content-Length` or the bytes actually received pass `maxBytes`.
 * The declared-size refusal drains the request so the socket stays reusable.
 */
export const readGuestUploadBody = async (req, maxBytes) => {
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
