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
import { isString } from '../shared/guards.js';
import { isProviderUsername } from './provider-id.js';


const HANDLE_BYTES = 32;

const refuse = (status, code, message) => ({ status, body: { error: { message, code } } });

const tokenHeaderValue = ({ token, scheme, login }) => {
  if (scheme === 'bearer') return `Bearer ${token}`;
  if (scheme === 'token') return `token ${token}`;
  if (scheme === 'basic') return `Basic ${Buffer.from(`${login}:${token}`, 'utf8').toString('base64')}`;
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
  /** @type {Map<string, { guestId: string, providerId: string, origin: string, credential: { token: string, header: string, scheme: string, login?: string } | null, deadline: number, methods: readonly string[], outbound: Array<{ method: string, status: number | null }> }>} */
  const grants = new Map();

  const mint = ({ guestId, providerId, origin, credential = null, deadline, methods }) => {
    if (credential?.scheme === 'basic' && !isProviderUsername(credential.login)) {
      throw Object.assign(new Error('This Git host signs in with a username, and the account has none OpenChamber can send'), {
        status: 400, code: 'SOURCE_CONTROL_USERNAME_REQUIRED',
      });
    }
    const handle = crypto.randomBytes(HANDLE_BYTES).toString('base64url');
    const grant = { guestId, providerId, origin, credential, deadline, methods: Object.freeze([...methods]), outbound: [] };
    grants.set(handle, grant);
    return Object.freeze({
      handle,
      outbound: grant.outbound,
      revoke: () => { grants.delete(handle); },
    });
  };

  const revokeGuest = (guestId) => {
    for (const [handle, grant] of grants) {
      if (grant.guestId === guestId) grants.delete(handle);
    }
  };

  const refusal = (bearer) => {
    const grant = grants.get(bearer);
    if (!grant) return refuse(403, 'HANDLE_UNKNOWN', 'This handle is not valid; it ends with the call it was given for');
    if (grant.deadline - now() <= 0) {
      grants.delete(bearer);
      return refuse(403, 'HANDLE_EXPIRED', 'The call this handle was given for has ended');
    }
    return null;
  };

  const serve = async ({ bearer, body }) => {
    const refused = refusal(bearer);
    if (refused) return refused;
    const grant = grants.get(bearer);
    const remaining = grant.deadline - now();
    const parsed = sourceControlProviderSchemasV1.outboundRequest.safeParse(body);
    if (!parsed.success) return refuse(400, 'BAD_REQUEST', 'The forge request is malformed');
    const request = parsed.data;
    if (!grant.methods.includes(request.method)) {
      return refuse(403, 'METHOD_NOT_ALLOWED', `This call may not send ${request.method} to the forge`);
    }
    const url = joinGuestRequestUrl(grant.origin, request.path, request.query);
    if (!url) return refuse(403, 'OFF_ORIGIN', 'Forge requests must stay on the instance');

    const headers = { ...request.headers };
    if (grant.credential) {
      headers[grant.credential.header] = tokenHeaderValue(grant.credential);
    }
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
