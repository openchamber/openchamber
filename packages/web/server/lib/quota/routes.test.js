import { afterAll, describe, expect, it, mock } from 'bun:test';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerQuotaRoutes } from './routes.js';

const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-go-routes-'));
process.env.OPENCHAMBER_DATA_DIR = temporaryDirectory;

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('OpenCode Go credential routes', () => {
  it('parses a JSON credential payload before validation', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response('rollingUsage:$R[1]={usagePercent:25,resetInSec:60}'));
    const app = express();
    registerQuotaRoutes(app, { getQuotaProviders: async () => ({}) });
    const server = app.listen(0);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server did not start');
      const response = await originalFetch(`http://127.0.0.1:${address.port}/api/quota/credentials/opencode-go`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'wrk_test', authCookie: 'auth=secret' }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ configured: true, workspaceId: 'wrk_test', secretMasked: '••••••••' });
    } finally {
      globalThis.fetch = originalFetch;
      server.close();
    }
  });
});
