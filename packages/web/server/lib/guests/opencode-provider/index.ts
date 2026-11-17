import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { GUEST_REQUEST_RESPONSE_MAX, GUEST_REQUEST_TIMEOUT_MS, requestedGuestCapabilities, serviceProvides } from '@openchamber/sdk';
import type { GuestCapability } from '@openchamber/sdk';

import { shouldForwardProxyResponseHeader } from '../../../proxy-headers.js';

export type OpenCodeGuest = Parameters<typeof requestedGuestCapabilities>[0] & {
  enabled?: boolean;
  capabilityGrants?: GuestCapability[];
};

export interface GuestOpenCodeProviderOptions {
  currentGuest: (guestId: string) => Promise<OpenCodeGuest | null>;
  buildOpenCodeUrl: (route: string, query: string) => string | URL;
  getOpenCodeAuthHeaders: () => http.OutgoingHttpHeaders;
}

interface Lease {
  guestId: string;
  calls: Set<AbortController>;
}

interface ListeningProvider {
  server: http.Server;
  url: string;
}

const isTcpAddress = (address: ReturnType<http.Server['address']>): address is AddressInfo =>
  address !== null && typeof address !== 'string';

const READS = [
  /^\/api\/project$/,
  /^\/api\/session$/,
  /^\/api\/session\/active$/,
  /^\/api\/session\/ses_[\w-]+$/,
  /^\/api\/session\/ses_[\w-]+\/message$/,
  /^\/api\/session\/ses_[\w-]+\/message\/msg_[\w-]+$/,
  /^\/api\/event$/,
];

const isListedRead = (method: string | undefined, url: string) => {
  const [pathname = ''] = url.split('?', 1);
  return method === 'GET' && READS.some((read) => read.test(pathname));
};

const approved = (guest: OpenCodeGuest | null) => {
  const grants = guest?.capabilityGrants;
  return Boolean(guest?.enabled !== false
    && serviceProvides(guest?.service, 'opencode')
    && guest && grants?.includes('opencode')
    && requestedGuestCapabilities(guest).every((capability) => grants.includes(capability)));
};

const answer = (response: http.ServerResponse, status: number, code: string, message: string) => {
  if (response.destroyed) return;
  if (response.headersSent) return response.destroy();
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: { code, message } }));
};

const relay = (mayDeliver: () => Promise<boolean>) => {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
      bytes += chunk.length;
      if (bytes > GUEST_REQUEST_RESPONSE_MAX) return done(new Error('OpenCode transfer exceeds the limit.'));
      mayDeliver().then((allowed) => done(allowed ? null : new Error('This transfer may no longer deliver.'), chunk), done);
    },
  });
};

export const createGuestOpenCodeProvider = ({ currentGuest, buildOpenCodeUrl, getOpenCodeAuthHeaders }: GuestOpenCodeProviderOptions) => {
  const leases = new Map<string, Lease>();
  let listening: Promise<ListeningProvider> | null = null;
  let stopped = false;

  const revokeGuest = (guestId: string) => {
    for (const [token, lease] of leases) {
      if (lease.guestId !== guestId) continue;
      leases.delete(token);
      for (const controller of lease.calls) controller.abort();
    }
  };
  const revokeAll = () => {
    for (const lease of leases.values()) revokeGuest(lease.guestId);
  };

  const serve = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    const authorization = request.headers.authorization ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
    const lease = token === null ? undefined : leases.get(token);
    if (!lease || token === null || request.headers.origin !== undefined) {
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
      await new Promise<void>((resolve, reject) => {
        const upstream = transport.request(target, { method: 'GET', headers, signal: controller.signal }, (incoming) => {
          const status = incoming.statusCode;
          if (status === undefined) {
            reject(new Error('OpenCode response has no status.'));
            return;
          }
          if (status >= 300 && status < 400) {
            incoming.resume();
            answer(response, 502, 'UPSTREAM_REDIRECT', 'OpenCode redirected the request; redirects are not followed.');
            resolve();
            return;
          }
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (value !== undefined && name !== 'set-cookie' && (name === 'content-encoding' || shouldForwardProxyResponseHeader(name))) response.setHeader(name, value);
          }
          response.writeHead(status);
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

  const listen = () => new Promise<ListeningProvider>((resolve, reject) => {
    const server = http.createServer((request, response) => { void serve(request, response); });
    server.headersTimeout = GUEST_REQUEST_TIMEOUT_MS;
    server.requestTimeout = GUEST_REQUEST_TIMEOUT_MS;
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      server.unref();
      const address = server.address();
      if (!isTcpAddress(address)) {
        reject(new Error('OpenCode provider has no TCP address.'));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });

  return {
    environmentFor: async ({ guestId, token }: { guestId: string; token: string }) => {
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
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
