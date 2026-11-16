/**
 * Provenance for a rejected read of OpenCode's own credential store.
 *
 * The running OpenCode answers a rejected credential read with a 401 whose
 * body is the bare string `Authentication required`, and every consumer that
 * reads credentials through `./auth.js` sees that one failure (#894). Quota
 * reports it as the shared OpenCode upstream-auth failure instead of N
 * provider errors — but only this read can say the failure came from the
 * shared credential path. A provider's own API can answer the same words
 * (#1129: z.ai's `payload.msg`), so the classification must key on where the
 * failure came from, never on what it says.
 *
 * The marker is applied at the one boundary where the peer is known to be
 * OpenCode — the credential source read in `./auth.js` — and travels on the
 * error object. Consumers ask `isOpenCodeUpstreamAuthRejection`.
 */

const OPENCODE_UPSTREAM_AUTH_ORIGIN = 'opencode-credential-source';

export class OpenCodeUpstreamAuthError extends Error {
  constructor(message = 'Authentication required', options = undefined) {
    super(message, options);
    this.name = 'OpenCodeUpstreamAuthError';
    this.origin = OPENCODE_UPSTREAM_AUTH_ORIGIN;
  }
}

/**
 * True when the failure came from the shared OpenCode credential read. Walks
 * `cause` because a consumer may re-wrap the error while keeping its origin.
 */
export const isOpenCodeUpstreamAuthRejection = (error) => {
  if (!error || typeof error !== 'object') return false;
  if (error.origin === OPENCODE_UPSTREAM_AUTH_ORIGIN) return true;
  return isOpenCodeUpstreamAuthRejection(error.cause);
};
