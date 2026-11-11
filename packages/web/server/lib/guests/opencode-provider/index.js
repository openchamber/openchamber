import http from 'node:http';
import https from 'node:https';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { GUEST_REQUEST_RESPONSE_MAX, GUEST_REQUEST_TIMEOUT_MS, requestedGuestCapabilities, serviceProvides } from '@openchamber/sdk';

import { shouldForwardProxyResponseHeader } from '../../../proxy-headers.js';

/**
 * Everything an approved service may ask OpenCode, each one a GET. A route
 * joins this list only when it changes nothing and starts nothing: a read that
 * names a directory (agents, models, files) starts that location's MCP servers,
 * and `/api/info` hands out the server's address. Anything unlisted is refused,
 * so a route OpenCode adds later stays out until someone lists it here.
 */
const READS = [
  /^\/api\/project$/,
  /^\/api\/session$/,
  /^\/api\/session\/active$/,
  /^\/api\/session\/ses_[\w-]+$/,
  /^\/api\/session\/ses_[\w-]+\/message$/,
  /^\/api\/session\/ses_[\w-]+\/message\/msg_[\w-]+$/,
  /^\/api\/event$/,
];

const isListedRead = (method, url) => {
  const [pathname] = url.split('?', 1);
  return method === 'GET' && READS.some((read) => read.test(pathname));
};

const approved = (guest) => guest?.enabled !== false
  && serviceProvides(guest?.service, 'opencode')
  && guest.capabilityGrants?.includes('opencode')
  && requestedGuestCapabilities(guest).every((capability) => guest.capabilityGrants.includes(capability));

const answer = (response, status, code, message) => {
  if (response.destroyed) return;
  if (response.headersSent) return response.destroy();
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: { code, message } }));
};

/** Stops a transfer at the size limit, and holds each chunk until `mayDeliver` says it can still reach the service. */
const relay = (mayDeliver) => {
  let bytes = 0;
  return new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > GUEST_REQUEST_RESPONSE_MAX) return done(new Error('OpenCode transfer exceeds the limit.'));
      mayDeliver().then((allowed) => done(allowed ? null : new Error('This transfer may no longer deliver.'), chunk), done);
    },
  });
};

/** Owns the loopback read transport, service leases, authorization and upstream selection. */
export const createGuestOpenCodeProvider = ({ currentGuest, buildOpenCodeUrl, getOpenCodeAuthHeaders }) => {
  const leases = new Map();
  let listening = null;
  let stopped = false;

  const revokeGuest = (guestId) => {
    for (const [token, lease] of leases) {
      if (lease.guestId !== guestId) continue;
      leases.delete(token);
      for (const controller of lease.calls) controller.abort();
    }
  };
  const revokeAll = () => {
    for (const lease of leases.values()) revokeGuest(lease.guestId);
  };

  const serve = async (request, response) => {
    const authorization = request.headers.authorization ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
    const lease = leases.get(token);
    if (!lease || request.headers.origin !== undefined) {
      answer(response, 403, 'NOT_GRANTED', 'This service has no OpenCode access.');
      return;
    }
    const controller = new AbortController();
    lease.calls.add(controller);
    const abort = () => controller.abort();
    request.once('aborted', abort);
    response.once('close', abort);
    const isApproved = async () => approved(await currentGuest(lease.guestId)) && leases.get(token) === lease && !controller.signal.aborted;
    try {
      if (!await isApproved()) {
        answer(response, 403, 'NOT_GRANTED', 'OpenCode access is no longer approved.');
        return;
      }
      const url = request.url ?? '';
      if (!isListedRead(request.method, url)) {
        answer(response, 403, 'NOT_A_LISTED_READ', 'OpenCode access covers the listed reads only.');
        return;
      }
      const target = new URL(buildOpenCodeUrl(url, ''));
      const mayDeliver = async () => new URL(buildOpenCodeUrl(url, '')).origin === target.origin && isApproved();
      const headers = { accept: request.headers.accept ?? '*/*', ...getOpenCodeAuthHeaders() };
      const transport = target.protocol === 'https:' ? https : http;
      await new Promise((resolve, reject) => {
        const upstream = transport.request(target, { method: 'GET', headers, signal: controller.signal }, (incoming) => {
          if (incoming.statusCode >= 300 && incoming.statusCode < 400) {
            incoming.resume();
            answer(response, 502, 'UPSTREAM_REDIRECT', 'OpenCode redirected the request; redirects are not followed.');
            resolve();
            return;
          }
          for (const [name, value] of Object.entries(incoming.headers)) {
            // Native HTTP leaves compressed bytes intact, unlike fetch-based proxies.
            if (value !== undefined && name !== 'set-cookie' && (name === 'content-encoding' || shouldForwardProxyResponseHeader(name))) response.setHeader(name, value);
          }
          response.writeHead(incoming.statusCode);
          pipeline(incoming, relay(mayDeliver), response).then(resolve, reject);
        });
        upstream.setTimeout(GUEST_REQUEST_TIMEOUT_MS, () => upstream.destroy(new Error('OpenCode request stalled.')));
        upstream.once('error', reject);
        upstream.end();
      });
    } catch {
      answer(response, 502, 'OPENCODE_UNAVAILABLE', 'The host-selected OpenCode request failed.');
    } finally {
      controller.abort();
      lease.calls.delete(controller);
      request.off('aborted', abort);
      response.off('close', abort);
    }
  };

  const listen = () => new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => { void serve(request, response); });
    server.headersTimeout = GUEST_REQUEST_TIMEOUT_MS;
    server.requestTimeout = GUEST_REQUEST_TIMEOUT_MS;
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      server.unref();
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });

  return {
    environmentFor: async ({ guestId, token }) => {
      const guest = await currentGuest(guestId);
      if (stopped || !approved(guest)) throw new Error('OpenCode access is not approved.');
      listening ??= listen();
      const { url } = await listening;
      if (stopped) throw new Error('The OpenCode provider stopped.');
      leases.set(token, { guestId, calls: new Set() });
      return { OPENCHAMBER_OPENCODE_URL: url };
    },
    revokeGuest,
    revokeAll,
    stop: async () => {
      stopped = true;
      revokeAll();
      if (!listening) return;
      const { server } = await listening;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
};
