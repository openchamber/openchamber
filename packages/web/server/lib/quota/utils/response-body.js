import { readBoundedResponseBytes, readBoundedResponseText } from '../../shared/response-body.js';

/**
 * The most a quota provider answer may weigh, on either surface (the VS Code
 * twin in packages/vscode/src/quotaProviders.ts uses the same value). Every
 * quota payload is a small per-account usage/balance/credits JSON document
 * (xAI reads a small protobuf usage body), so 1 MiB — the changelog-index
 * precedent in lib/changelog/update-notes.js — is orders of magnitude above
 * any legitimate response. Provider endpoints are third-party and sometimes
 * user-configured, and quota polling runs continuously with the user's
 * credentials, so a fast hostile or misconfigured endpoint must not be able
 * to grow server memory arbitrarily inside the 15 s deadline (#1282): a
 * deadline bounds time, not memory.
 */
export const QUOTA_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;

const tooLargeError = () =>
  new Error(`Quota response exceeded ${QUOTA_RESPONSE_MAX_BYTES} bytes`);

/**
 * Reads a quota provider answer as JSON through the shared bounded reader,
 * preserving the old bare response.json() semantics for in-cap bodies: a
 * malformed body throws from JSON.parse exactly as response.json() did, and
 * an over-cap body throws instead of being buffered whole, so the caller's
 * existing failure path produces the provider's normal failure result.
 */
export const readQuotaJson = async (response) => {
  // Test doubles pass a plain { ok, json } without a body; real responses go
  // through the bounded reader (the package-manager / changelog precedent).
  if (!response.body) {
    return response.json();
  }
  const bounded = await readBoundedResponseText(response, QUOTA_RESPONSE_MAX_BYTES);
  if (bounded.tooLarge) throw tooLargeError();
  // Response.json() strips a leading UTF-8 BOM; the bounded reader does not.
  return JSON.parse(bounded.text.replace(/^\uFEFF/, ''));
};

/**
 * The same bounded read for the one binary quota answer (xAI's protobuf
 * usage body): the cap is enforced while the body streams in.
 */
export const readQuotaBytes = async (response) => {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > QUOTA_RESPONSE_MAX_BYTES) throw tooLargeError();
    return bytes;
  }
  const bounded = await readBoundedResponseBytes(response, QUOTA_RESPONSE_MAX_BYTES);
  if (bounded.tooLarge) throw tooLargeError();
  return bounded.bytes;
};
