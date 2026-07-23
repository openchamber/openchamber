import { afterEach, beforeEach, expect, test } from 'bun:test';
import net from 'node:net';

import { createProbeServer, parseProbeServerArgs } from './sprint0-probe-server.mjs';

let probeServer;

beforeEach(() => {
  probeServer = createProbeServer({
    hostname: '127.0.0.1',
    log: () => {},
    port: 0,
  });
});

afterEach(() => {
  probeServer.stop();
});

function probeUrl(pathname) {
  return `http://127.0.0.1:${probeServer.port}${pathname}`;
}

function webSocketHandshake(origin) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: probeServer.port });
    const timeout = setTimeout(() => finish(new Error('Timed out waiting for the WebSocket handshake.')), 1000);
    const chunks = [];
    let settled = false;

    function finish(error, result) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      socket.destroy();

      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    }

    socket.on('connect', () => {
      socket.write([
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${probeServer.port}`,
        `Origin: ${origin}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'));
    });

    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const response = Buffer.concat(chunks).toString('utf8');

      if (response.includes('\r\n\r\n')) {
        finish(undefined, response);
      }
    });
    socket.on('error', (error) => finish(error));
  });
}

test('accepts only the configured exact Origin for CORS responses', async () => {
  const accepted = await fetch(probeUrl('/health'), {
    headers: { Origin: 'https://localhost' },
  });
  const nullOrigin = await fetch(probeUrl('/health'), {
    headers: { Origin: 'null' },
  });
  const rejected = await fetch(probeUrl('/health'), {
    headers: { Origin: 'https://untrusted.example' },
  });

  expect(accepted.status).toBe(200);
  expect(accepted.headers.get('access-control-allow-origin')).toBe('https://localhost');
  expect(await accepted.json()).toEqual({ ok: true, probe: 'health' });
  expect(nullOrigin.status).toBe(403);
  expect(nullOrigin.headers.get('access-control-allow-origin')).toBeNull();
  expect(rejected.status).toBe(403);
  expect(rejected.headers.get('access-control-allow-origin')).toBeNull();
});

test('returns an exact-origin preflight response and an SSE readiness event', async () => {
  const preflight = await fetch(probeUrl('/echo'), {
    headers: {
      'Access-Control-Request-Headers': 'content-type, x-openchamber-probe',
      'Access-Control-Request-Method': 'POST',
      Origin: 'https://localhost',
    },
    method: 'OPTIONS',
  });
  const stream = await fetch(probeUrl('/sse'), {
    headers: { Origin: 'https://localhost' },
  });
  const reader = stream.body.getReader();
  const firstChunk = await reader.read();

  await reader.cancel();

  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-origin')).toBe('https://localhost');
  expect(stream.status).toBe(200);
  expect(new TextDecoder().decode(firstChunk.value)).toContain('data: {"type":"ready"}');
});

test('applies the same exact Origin rule before a WebSocket upgrade', async () => {
  const accepted = await webSocketHandshake('https://localhost');
  const rejected = await webSocketHandshake('https://untrusted.example');

  expect(accepted).toContain('101 Switching Protocols');
  expect(rejected).toContain('403 Forbidden');
});

test('parses only explicit, valid probe-server options', () => {
  expect(parseProbeServerArgs([])).toMatchObject({
    allowedOrigin: 'https://localhost',
    hostname: '127.0.0.1',
    port: 8788,
  });
  expect(() => parseProbeServerArgs(['--origin', '*'])).toThrow('exact scheme://host');
  expect(() => parseProbeServerArgs(['--port', '0'])).toThrow('integer from 1 to 65535');
  expect(() => parseProbeServerArgs(['--port', '8788invalid'])).toThrow('integer from 1 to 65535');
  expect(() => parseProbeServerArgs(['--unexpected'])).toThrow('Unknown option');
});
