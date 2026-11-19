import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { isString } from './input-guards.js';

type CallbackAnswer = { status: number; body: unknown; close?: true };
export type HostCallbackRoute = {
  refusal: (bearer: string) => CallbackAnswer | null;
  serve: (request: { bearer: string; body: unknown }) => Promise<CallbackAnswer>;
};
type CallbackListener = { server: http.Server; url: string };
const isTcpAddress = (address: ReturnType<http.Server['address']>): address is AddressInfo => address !== null && !isString(address);

const REQUEST_BODY_MAX = 6_200_000;
const REQUEST_TIMEOUT_MS = 30_000;

const routes = new Map<string, HostCallbackRoute>();
let listening: Promise<CallbackListener> | null = null;

const refuse = (status: number, code: string, message: string) => ({ status, body: { error: { message, code } } });

const send = (response: http.ServerResponse, { status, body }: CallbackAnswer, done?: () => void) => {
  const text = JSON.stringify(body);
  const headers: http.OutgoingHttpHeaders = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  if (done) headers.connection = 'close';
  response.writeHead(status, headers);
  response.end(text, done);
};

const readBody = (request: http.IncomingMessage) => new Promise<string | null>((resolve, reject) => {
  const chunks: Buffer[] = [];
  let size = 0;
  const onData = (chunk: Buffer) => {
    size += chunk.length;
    if (size <= REQUEST_BODY_MAX) {
      chunks.push(chunk);
      return;
    }
    request.off('data', onData);
    request.pause();
    resolve(null);
  };
  request.on('data', onData);
  request.on('end', () => resolve(Buffer.concat(chunks, size).toString('utf8')));
  request.on('error', reject);
});

const answer = async (request: http.IncomingMessage): Promise<CallbackAnswer> => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const route = routes.get(path);
  if (!route) return refuse(404, 'NOT_FOUND', 'Unknown callback route');
  if (request.method !== 'POST') return refuse(405, 'BAD_METHOD', 'Callback routes take POST');
  if (request.headers.origin !== undefined) return refuse(403, 'BAD_ORIGIN', 'Browsers cannot call this listener');
  const authorization = request.headers.authorization ?? '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
  if (!bearer) return refuse(401, 'HANDLE_UNKNOWN', 'A bearer is required');
  const refused = route.refusal(bearer);
  if (refused) return { ...refused, close: true };
  const text = await readBody(request);
  if (text === null) return { ...refuse(413, 'BODY_TOO_LARGE', 'The request body is too large'), close: true };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse(400, 'BAD_REQUEST', 'The request body is not JSON');
  }
  return route.serve({ bearer, body });
};

const startListener = () => new Promise<CallbackListener>((resolve, reject) => {
  const server = http.createServer((request, response) => {
    answer(request).then(
      (result) => send(response, result, result.close ? () => request.destroy() : undefined),
      () => send(response, refuse(500, 'HOST_FAILED', 'OpenChamber could not handle the request')),
    );
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    server.off('error', reject);
    server.unref();
    const address = server.address();
    if (!isTcpAddress(address)) {
      reject(new Error('Callback listener has no TCP address'));
      return;
    }
    resolve({ server, url: `http://127.0.0.1:${address.port}` });
  });
});

export const setHostCallbackRoute = (path: string, route: HostCallbackRoute) => {
  routes.set(path, route);
  return () => {
    if (routes.get(path) === route) routes.delete(path);
  };
};

export const hostCallbackUrl = async () => {
  listening ??= startListener().catch((error) => {
    listening = null;
    throw error;
  });
  return (await listening).url;
};

export const stopHostCallbackListener = async () => {
  const current = listening;
  listening = null;
  if (!current) return;
  const { server } = await current.catch(() => ({ server: null }));
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
};
