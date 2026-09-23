import http from 'node:http';
import type { DiagnosticsResponse } from '../shared.js';
import { readDiagnostics } from './diagnostics.js';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';

type ServiceResponseBody = DiagnosticsResponse | { ok: true } | {
  error: 'unauthorized' | 'not-found' | 'invalid-session' | 'diagnostics-unavailable';
};

const reply = (response: http.ServerResponse, status: number, body: ServiceResponseBody): void => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
};

if (!Number.isInteger(port) || port < 1 || port > 65_535 || !token) {
  throw new Error('OpenChamber service port and token are required');
}

const server = http.createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    reply(response, 401, { error: 'unauthorized' });
    return;
  }

  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/health') {
    reply(response, 200, { ok: true });
    return;
  }
  if (request.method !== 'GET' || url.pathname !== '/diagnostics') {
    reply(response, 404, { error: 'not-found' });
    return;
  }

  const requestedSession = url.searchParams.get('sessionId');
  if (requestedSession !== null && (requestedSession.length > 128 || requestedSession.includes('\0'))) {
    reply(response, 400, { error: 'invalid-session' });
    return;
  }

  void readDiagnostics({
    sessionId: requestedSession,
    includeDatabase: url.searchParams.get('includeDatabase') === '1',
  }).then((snapshot) => reply(response, 200, snapshot)).catch(() => {
    reply(response, 500, { error: 'diagnostics-unavailable' });
  });
});

server.listen(port, '127.0.0.1');
