import crypto from 'node:crypto';

import {
  SOURCE_CONTROL_OUTBOUND_RESPONSE_HEADERS,
  SOURCE_CONTROL_OUTBOUND_RESPONSE_HEADER_PREFIX,
  SOURCE_CONTROL_OUTBOUND_RESPONSE_MAX,
  SOURCE_CONTROL_OUTBOUND_TIMEOUT_MS,
} from '@openchamber/sdk';
import { sourceControlProviderSchemasV1 } from '@openchamber/sdk/schemas';

import { joinGuestRequestUrl } from '../guests/request.js';
import { readBoundedResponseText } from '../guests/response-body.js';

/**
 * Outbound handles and the proxy behind them: how an extension's Git host
 * service reaches its forge without ever holding a token.
 *
 * For each call OpenChamber forwards to the service it mints a handle, 32
 * random bytes bound to `{ guestId, providerId, origin, token | null,
 * deadline }`, and revokes it when the call ends. The service sends forge
 * requests to the callback listener (`guests/host-callback.js`) with the
 * handle as its bearer; `serve` checks the handle, keeps the request on the
 * bound origin, adds the token in the header the extension declared, and
 * relays the answer. Every request a handle carried is recorded as
 * `{ method, status }` (status `null` until an answer arrives, `0` when none
 * did), which is what the adapter trusts about the forge, never the service's
 * own account of it.
 *
 * Nothing here logs: not the handle, the token, a body or a query.
 */

const HANDLE_BYTES = 32;

const refuse = (status, code, message) => ({ status, body: { error: { message, code } } });

/** The header value for a stored token, per `contributes.sourceControl.token`. */
const tokenHeaderValue = (token, scheme) => {
  if (scheme === 'bearer') return `Bearer ${token}`;
  if (scheme === 'token') return `token ${token}`;
  return token;
};

const relayedHeaders = (headers) => {
  const relayed = {};
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (SOURCE_CONTROL_OUTBOUND_RESPONSE_HEADERS.includes(lower) || lower.startsWith(SOURCE_CONTROL_OUTBOUND_RESPONSE_HEADER_PREFIX)) {
      relayed[lower] = value;
    }
  }
  return relayed;
};

/**
 * @param {{ fetch?: typeof fetch, now?: () => number }} [options]
 */
export function createOutboundHandles({ fetch: fetchImpl = (input, init) => fetch(input, init), now = Date.now } = {}) {
  /** @type {Map<string, { guestId: string, providerId: string, origin: string, credential: { token: string, header: string, scheme: string } | null, deadline: number, methods: readonly string[], outbound: Array<{ method: string, status: number | null }> }>} */
  const grants = new Map();

  /**
   * A handle for one forwarded call. `credential` is `{ token, header, scheme }`,
   * or null for a call that must not carry a token (`auth.probe`). `methods`
   * are the forge methods the call may send: a read gets `['GET']`, so only
   * the mutation step the executor records can write. The returned
   * `outbound` list fills as the service uses the handle; `revoke` ends it.
   */
  const mint = ({ guestId, providerId, origin, credential = null, deadline, methods }) => {
    const handle = crypto.randomBytes(HANDLE_BYTES).toString('base64url');
    const grant = { guestId, providerId, origin, credential, deadline, methods: Object.freeze([...methods]), outbound: [] };
    grants.set(handle, grant);
    return Object.freeze({
      handle,
      outbound: grant.outbound,
      revoke: () => { grants.delete(handle); },
    });
  };

  /** Ends every handle of a guest, as when its provider is unregistered. */
  const revokeGuest = (guestId) => {
    for (const [handle, grant] of grants) {
      if (grant.guestId === guestId) grants.delete(handle);
    }
  };

  /**
   * The refusal for a bearer that is not a live handle, or null for one that
   * is. The callback listener asks before it reads a body.
   */
  const refusal = (bearer) => {
    const grant = grants.get(bearer);
    if (!grant) return refuse(403, 'HANDLE_UNKNOWN', 'This handle is not valid; it ends with the call it was given for');
    if (grant.deadline - now() <= 0) {
      grants.delete(bearer);
      return refuse(403, 'HANDLE_EXPIRED', 'The call this handle was given for has ended');
    }
    return null;
  };

  /** One forge request, as the callback listener received it. */
  const serve = async ({ bearer, body }) => {
    const refused = refusal(bearer);
    if (refused) return refused;
    const grant = grants.get(bearer);
    const remaining = grant.deadline - now();
    const parsed = sourceControlProviderSchemasV1.outboundRequest.safeParse(body);
    if (!parsed.success) return refuse(400, 'BAD_REQUEST', 'The forge request is malformed');
    const request = parsed.data;
    // Refused before it is recorded: it never went out.
    if (!grant.methods.includes(request.method)) {
      return refuse(403, 'METHOD_NOT_ALLOWED', `This call may not send ${request.method} to the forge`);
    }
    const url = joinGuestRequestUrl(grant.origin, request.path, request.query);
    if (!url) return refuse(403, 'OFF_ORIGIN', 'Forge requests must stay on the instance');

    const headers = { ...request.headers };
    if (grant.credential) {
      headers[grant.credential.header] = tokenHeaderValue(grant.credential.token, grant.credential.scheme);
    }
    // Recorded before it is sent: a write still in flight when the call ends
    // may land, so it must never count as one that was refused.
    const record = { method: request.method, status: null };
    grant.outbound.push(record);
    let response;
    try {
      response = await fetchImpl(url, {
        method: request.method,
        headers,
        body: request.method === 'GET' ? undefined : request.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.min(SOURCE_CONTROL_OUTBOUND_TIMEOUT_MS, remaining)),
      });
    } catch {
      record.status = 0;
      return refuse(502, 'FORGE_UNREACHABLE', 'The forge did not answer');
    }
    record.status = response.status;
    let text;
    try {
      text = await readBoundedResponseText(response, SOURCE_CONTROL_OUTBOUND_RESPONSE_MAX);
    } catch {
      return refuse(502, 'FORGE_UNREACHABLE', 'The forge answer could not be read');
    }
    if (text.tooLarge) return refuse(502, 'RESPONSE_TOO_LARGE', `The forge answered with more than ${SOURCE_CONTROL_OUTBOUND_RESPONSE_MAX} bytes`);
    return { status: 200, body: { status: response.status, headers: relayedHeaders(response.headers), body: text.text } };
  };

  return Object.freeze({ mint, revokeGuest, refusal, serve });
}
