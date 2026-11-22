import type { ZodType } from 'zod';

export const API_PROXY_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
export const OPENCODE_SKILLS_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
export const OPENCODE_INFO_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;
export const OPENCODE_DIAGNOSTICS_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;

// Quota payloads are small JSON documents, so the quota surface caps its
// response bodies far below the API-proxy cap (see #1298 / #1282).
export const QUOTA_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;

const formatLimit = (maxBytes: number) =>
  maxBytes % (1024 * 1024) === 0 ? `${maxBytes / (1024 * 1024)} MiB` : `${maxBytes} bytes`;

export class ResponseBodyTooLargeError extends Error {
  constructor(maxBytes: number = API_PROXY_RESPONSE_MAX_BYTES) {
    super(`OpenCode API response exceeded the ${formatLimit(maxBytes)} limit`);
    this.name = 'ResponseBodyTooLargeError';
  }
}

const cancelBody = (body: ReadableStream<Uint8Array> | null): void => {
  if (!body) return;
  try {
    void body.cancel().catch(() => {});
  } catch {
    // Cancellation is best-effort when the upstream has already disturbed its body.
  }
};

export const readBoundedResponseBody = async (
  response: Response,
  maxBytes: number = API_PROXY_RESPONSE_MAX_BYTES,
): Promise<Uint8Array> => {
  const declaredLength = response.headers.get('content-length')?.trim();
  const declaredByteLength = declaredLength && /^\d+$/.test(declaredLength) ? Number(declaredLength) : null;
  if (declaredByteLength !== null && declaredByteLength > maxBytes) {
    cancelBody(response.body);
    throw new ResponseBodyTooLargeError(maxBytes);
  }

  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  let body = declaredByteLength === null ? new Uint8Array() : new Uint8Array(declaredByteLength);
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const requiredBytes = totalBytes + value.byteLength;
      if (requiredBytes > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new ResponseBodyTooLargeError(maxBytes);
      }
      if (requiredBytes > body.byteLength) {
        const capacity = Math.min(
          maxBytes,
          Math.max(requiredBytes, body.byteLength === 0 ? 64 * 1024 : body.byteLength * 2),
        );
        const expanded = new Uint8Array(capacity);
        expanded.set(body.subarray(0, totalBytes));
        body = expanded;
      }
      body.set(value, totalBytes);
      totalBytes = requiredBytes;
    }
  } finally {
    reader.releaseLock();
  }

  return body.subarray(0, totalBytes);
};

// Reads a response body as JSON under a byte cap. Without a schema this
// mirrors the `response.json().catch(() => null)` shape the quota modules
// already use: an over-cap body, a non-JSON body, and a parse failure all
// yield null, so each caller's existing failure path produces its normal
// failure result instead of a buffered whole-body parse. A leading UTF-8
// BOM is stripped, matching what `response.json()` accepts. With a schema,
// the parsed value is schema-validated and errors (including
// ResponseBodyTooLargeError) propagate to the caller.
export function readBoundedResponseJson(response: Response, maxBytes: number): Promise<unknown>;
export function readBoundedResponseJson<T>(response: Response, maxBytes: number, schema: ZodType<T>): Promise<T>;
export async function readBoundedResponseJson<T>(
  response: Response,
  maxBytes: number,
  schema?: ZodType<T>,
): Promise<unknown> {
  if (schema) {
    const body = await readBoundedResponseBody(response, maxBytes);
    return schema.parse(JSON.parse(new TextDecoder().decode(body)));
  }
  try {
    const bytes = await readBoundedResponseBody(response, maxBytes);
    const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
