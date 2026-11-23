import { once } from 'node:events';
import { createServer } from 'node:http';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { describe, expect, it } from 'vitest';
import { isBoolean, isPlainObject, isRecord } from './guards.js';
import type { Application, Request, Response } from './http-contracts.js';
import type { RawData } from './websocket-contracts.js';
import type { ProviderDescriptor, ProbeInstance } from '../source-control/provider-contract.js';
import { githubDescriptor } from '../github/descriptor.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';

interface OptionalValue {
  value?: string;
}

const isTcpAddress = (value: unknown): value is { port: number } => value !== null
  && typeof value === 'object' && 'port' in value && typeof value.port === 'number';

describe('shared boundary contracts', () => {
  it('narrows unknown records and booleans without claiming field types', () => {
    const input: unknown = JSON.parse('{"enabled":false}');
    if (!isPlainObject(input)) throw new Error('Expected a plain record');
    const enabled: unknown = input.enabled;
    expect(isBoolean(enabled) ? enabled : null).toBe(false);
    const object: unknown = JSON.parse('{"other":17}');
    if (!isRecord(object)) throw new Error('Expected an object record');
    expect(object.missing).toBeUndefined();
  });

  it('retains already typed optional fields when checking an object', () => {
    const input: OptionalValue = { value: 'kept' };
    if (!isPlainObject(input)) throw new Error('Expected a plain record');
    const value: string | undefined = input.value;
    expect(value).toBe('kept');
  });

  it('accepts omitted activity signals and nullable provider versions and identity ids', async () => {
    const probe = createSessionActivityProbe({
      buildOpenCodeUrl: (route) => `http://localhost${route}`,
      getOpenCodeAuthHeaders: () => ({}),
    });
    expect(probe.fetchRunningShells).toBeInstanceOf(Function);
    const version: ProbeInstance = async () => ({ supported: true, version: null });
    expect(await version('https://example.com')).toEqual({ supported: true, version: null });
    const identity: ProviderDescriptor['identity'] = githubDescriptor.identity;
    expect(identity.noReplyEmail?.({ login: 'alice', id: undefined })).toBeNull();
  });

  it('runs the typed Express request, response and JSON middleware over HTTP', async () => {
    const app: Application = express();
    app.use(express.json());
    app.use((request, response, next) => {
      response.set('x-boundary', request.get('x-request') ?? 'seen');
      next();
    });
    app.post('/echo/:id', (request: Request, response: Response) => {
      if (!isPlainObject(request.body)) return response.status(400).json({ error: 'Expected an object' });
      response.set('Set-Cookie', ['a=1', 'b=2']);
      const cookies = response.get('Set-Cookie');
      return response.json({
        id: request.params.id, value: request.body.value, query: request.query.q,
        cookies, requestCookies: request.get('SeT-CoOkIe'),
      });
    });
    const server = createServer(app);
    server.listen(0, 'localhost');
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!isTcpAddress(address)) throw new Error('Expected a TCP address');
      const response = await fetch(`http://localhost:${address.port}/echo/a?q=search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Set-Cookie': 'incoming=1' },
        body: JSON.stringify({ value: 17 }),
      });
      expect(await response.json()).toEqual({
        id: 'a', value: 17, query: 'search', cookies: ['a=1', 'b=2'],
        requestCookies: ['incoming=1'],
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('runs the typed WebSocket constructor, frames and upgrade boundary', async () => {
    const server = createServer();
    const sockets = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      sockets.handleUpgrade(request, socket, head, (connection) => sockets.emit('connection', connection, request));
    });
    sockets.on('connection', (connection) => {
      connection.on('message', (data: RawData, binary) => {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
        connection.send(bytes, { binary });
      });
    });
    server.listen(0, 'localhost');
    let client: WebSocket | undefined;
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!isTcpAddress(address)) throw new Error('Expected a TCP address');
      client = new WebSocket(`ws://localhost:${address.port}`);
      await once(client, 'open');
      const message = once(client, 'message');
      client.send('frame');
      const [data, binary] = await message;
      expect(Buffer.from(data).toString()).toBe('frame');
      expect(binary).toBe(false);
    } finally {
      client?.terminate();
      for (const connection of sockets.clients ?? []) connection.terminate();
      await new Promise<void>((resolve, reject) => sockets.close((error) => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('leaves the client set absent when WebSocket tracking is disabled', async () => {
    const sockets = new WebSocketServer({ noServer: true, clientTracking: false });
    expect(sockets.clients).toBeUndefined();
    await new Promise<void>((resolve, reject) => sockets.close((error) => error ? reject(error) : resolve()));
  });
});
