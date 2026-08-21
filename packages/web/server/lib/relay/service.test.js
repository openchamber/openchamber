// Route-level tests for the relay service config surface: POST
// /api/openchamber/relay/url (persist a custom relay endpoint) plus the
// status shape it feeds. The relay host lifecycle is exercised only through
// the public routes — the host client itself dials an unreachable loopback
// port so no real relay is needed; what matters here is the config write,
// validation, env-pinning, and the restart-onto-new-endpoint behavior.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import express from 'express';

import { createRelayService, DEFAULT_RELAY_URL } from './service.js';

const makeSettingsStore = () => {
  let store = {};
  return {
    readSettingsFromDiskMigrated: async () => store,
    writeSettingsToDisk: async (settings) => {
      store = settings;
    },
    readSettingsStrict: async () => store,
    peek: () => store,
  };
};

const makeTestServer = async () => {
  const settings = makeSettingsStore();
  const service = createRelayService({
    crypto,
    readSettingsFromDiskMigrated: settings.readSettingsFromDiskMigrated,
    writeSettingsToDisk: settings.writeSettingsToDisk,
    readSettingsStrict: settings.readSettingsStrict,
    getLocalPort: () => 4096,
    // No host lock: tests exercise single-instance behavior (pre-lock mode).
    hostLock: null,
    logger: { warn: () => {} },
  });
  const app = express();
  service.registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    settings,
    service,
    post: async (path, body) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      return { status: response.status, json: await response.json().catch(() => null) };
    },
    close: async () => {
      service.stop();
      await new Promise((resolve) => server.close(resolve));
    },
  };
};

let env;

describe('POST /api/openchamber/relay/url', () => {
  beforeEach(() => {
    env = process.env.OPENCHAMBER_RELAY_URL;
    delete process.env.OPENCHAMBER_RELAY_URL;
  });

  afterEach(() => {
    if (env === undefined) delete process.env.OPENCHAMBER_RELAY_URL;
    else process.env.OPENCHAMBER_RELAY_URL = env;
  });

  it('persists a valid custom URL and preserves the enabled flag', async () => {
    const test = await makeTestServer();
    try {
      const { status, json } = await test.post('/api/openchamber/relay/url', { relayUrl: 'wss://relay.example.com/ws?token=1' });
      expect(status).toBe(200);
      expect(json.relayUrl).toBe('wss://relay.example.com/ws?token=1');
      expect(json.relayUrlLocked).toBe(false);
      // Pure config write: the relay is NOT enabled by saving a URL.
      expect(json.enabled).toBe(false);
      expect(test.settings.peek().privateRelay).toEqual({
        enabled: false,
        relayUrl: 'wss://relay.example.com/ws?token=1',
      });
    } finally {
      await test.close();
    }
  });

  it('rejects non-WebSocket URLs, garbage, and a missing field without writing', async () => {
    const test = await makeTestServer();
    try {
      for (const body of [{ relayUrl: 'https://relay.example.com/ws' }, { relayUrl: 'not a url' }, { relayUrl: '  ' }, {}]) {
        const { status } = await test.post('/api/openchamber/relay/url', body);
        expect(status).toBe(400);
      }
      // No write happened: privateRelay stays absent from settings.
      expect(test.settings.peek().privateRelay).toBeUndefined();
    } finally {
      await test.close();
    }
  });

  it('returns 409 while OPENCHAMBER_RELAY_URL pins the endpoint', async () => {
    const test = await makeTestServer();
    process.env.OPENCHAMBER_RELAY_URL = 'wss://pinned.example.com/ws';
    try {
      const { status, json } = await test.post('/api/openchamber/relay/url', { relayUrl: 'wss://other.example.com/ws' });
      expect(status).toBe(409);
      expect(json.error).toContain('OPENCHAMBER_RELAY_URL');
      expect(test.settings.peek().privateRelay).toBeUndefined();
    } finally {
      await test.close();
    }
  });

  it('restarts a running host onto the new endpoint', async () => {
    const test = await makeTestServer();
    try {
      // Bring the host up (unreachable endpoint — the dial fails in the
      // background, but the host client exists and keeps retrying).
      const enabled = await test.post('/api/openchamber/relay/enable', { relayUrl: 'ws://127.0.0.1:9/first' });
      expect(enabled.status).toBe(200);
      expect(enabled.json.enabled).toBe(true);

      const saved = await test.post('/api/openchamber/relay/url', { relayUrl: 'ws://127.0.0.1:9/second' });
      expect(saved.status).toBe(200);
      expect(saved.json.relayUrl).toBe('ws://127.0.0.1:9/second');
      // The host client was restarted onto the new URL (still enabled and
      // live, not torn down to `disabled`).
      expect(saved.json.enabled).toBe(true);
      expect(saved.json.state).not.toBe('disabled');
      expect(test.settings.peek().privateRelay).toEqual({ enabled: true, relayUrl: 'ws://127.0.0.1:9/second' });
    } finally {
      await test.close();
    }
  });
});

describe('GET /api/openchamber/relay/status shape', () => {
  beforeEach(() => {
    env = process.env.OPENCHAMBER_RELAY_URL;
    delete process.env.OPENCHAMBER_RELAY_URL;
  });

  afterEach(() => {
    if (env === undefined) delete process.env.OPENCHAMBER_RELAY_URL;
    else process.env.OPENCHAMBER_RELAY_URL = env;
  });

  it('reports relayUrl, defaultRelayUrl, and lock state', async () => {
    const test = await makeTestServer();
    try {
      const { service } = test;
      const status = await service.getStatus();
      expect(status.relayUrl).toBe(DEFAULT_RELAY_URL);
      expect(status.defaultRelayUrl).toBe(DEFAULT_RELAY_URL);
      expect(status.relayUrlLocked).toBe(false);
    } finally {
      await test.close();
    }
  });

  it('reports the lock when OPENCHAMBER_RELAY_URL is set', async () => {
    const test = await makeTestServer();
    process.env.OPENCHAMBER_RELAY_URL = 'wss://pinned.example.com/ws';
    try {
      const status = await test.service.getStatus();
      expect(status.relayUrl).toBe('wss://pinned.example.com/ws');
      expect(status.relayUrlLocked).toBe(true);
    } finally {
      await test.close();
    }
  });
});
