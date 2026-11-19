import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerSessionGoalRoutes } from './routes.js';

let dataDir;
let handlers;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-goal-routes-'));
  vi.stubEnv('OPENCHAMBER_DATA_DIR', dataDir);
  handlers = {};
  registerSessionGoalRoutes(Object.fromEntries(['put', 'get', 'delete'].map((method) => [
    method,
    (route, handler) => { handlers[method] = handler; },
  ])));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const request = async (method, body, sessionId = 'ses_routes') => {
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; },
  };
  await handlers[method]({ params: { sessionId }, body }, response);
  return { status: response.statusCode, body: response.body };
};

describe('goal objective routes', () => {
  it.each([
    ['  finish  ', 'finish'],
    [42, '42'],
    [false, 'false'],
    [['a', 'b'], 'a,b'],
    [{ task: 'finish' }, '[object Object]'],
  ])('preserves JSON content coercion for %j', async (content, expected) => {
    expect(await request('put', { content })).toEqual({ status: 200, body: { ok: true } });
    expect(await request('get')).toEqual({ status: 200, body: { content: expected } });
    expect(await request('delete')).toEqual({ status: 200, body: { ok: true } });
    expect(await request('get')).toEqual({ status: 404, body: { error: 'objective not found' } });
  });

  it.each([undefined, null, false, 42, 'text', [], {}, { content: null }])(
    'rejects a body without objective content: %j',
    async (body) => {
      expect(await request('put', body)).toEqual({
        status: 400,
        body: { error: 'objective content is required' },
      });
    },
  );

  it('rejects invalid session ids before writing', async () => {
    expect(await request('put', { content: 'finish' }, 'abc')).toEqual({
      status: 400,
      body: { error: 'invalid session id' },
    });
    expect(await fs.readdir(dataDir)).toEqual([]);
  });
});
