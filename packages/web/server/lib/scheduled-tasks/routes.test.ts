import { once } from 'node:events';
import { createServer } from 'node:http';
import express from 'express';
import { expect, it } from 'vitest';

const isTcpAddress = (value: unknown): value is { port: number } => value !== null
  && typeof value === 'object' && 'port' in value && typeof value.port === 'number';

it('lets Express validate unchecked status values without coercion', async () => {
  const app = express();
  app.use(express.json({ strict: false }));
  app.post('/status', (request, response) => {
    try {
      return response.status(request.body).json({ accepted: true });
    } catch (error) {
      return response.json({ accepted: false, error: error instanceof Error ? error.name : null });
    }
  });
  const server = createServer(app);
  server.listen(0, 'localhost');
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!isTcpAddress(address)) throw new Error('Expected a TCP address');
    for (const [code, status, body] of [
      [201, 201, { accepted: true }],
      ['201', 200, { accepted: false, error: 'TypeError' }],
      [true, 200, { accepted: false, error: 'TypeError' }],
      [null, 200, { accepted: false, error: 'TypeError' }],
      [{}, 200, { accepted: false, error: 'TypeError' }],
      [99, 200, { accepted: false, error: 'RangeError' }],
      [1000, 200, { accepted: false, error: 'RangeError' }],
    ] as const) {
      const response = await fetch(`http://localhost:${address.port}/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(code),
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(body);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
