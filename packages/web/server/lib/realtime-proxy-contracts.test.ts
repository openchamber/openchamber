import { once } from 'node:events';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from './shared/websocket-contracts.js';

const isTcpAddress = (value: unknown): value is { port: number } => value !== null
  && typeof value === 'object' && 'port' in value && typeof value.port === 'number';

describe('realtime forwarding contracts', () => {
  it('accepts the raw Buffer array with the installed ws conversion unchanged', async () => {
    const server = createServer();
    const sockets = new WebSocketServer({ server });
    const frame: RawData = [Buffer.from('65'), Buffer.from('66')];
    sockets.on('connection', (socket) => socket.send(frame, { binary: true }));
    server.listen(0, '127.0.0.1');
    let client: WebSocket | undefined;
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!isTcpAddress(address)) throw new Error('Expected a TCP address');
      client = new WebSocket(`ws://127.0.0.1:${address.port}`);
      const received = await new Promise<RawData>((resolve, reject) => {
        client?.once('message', resolve);
        client?.once('error', reject);
      });
      expect(received).toEqual(Buffer.from([65, 66]));
    } finally {
      client?.terminate();
      for (const socket of sockets.clients ?? []) socket.terminate();
      await new Promise<void>((resolve, reject) => sockets.close((error) => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
