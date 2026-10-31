import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RETRY_NOW_COMMAND, RETRY_WAIT_MAX_MS, isRetryPolicyConfigured } from './policy.js';
import { createRetryPolicyRuntime } from './runtime.js';

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
  vi.unstubAllGlobals();
});

const createRuntime = ({ settings = { retryWaitMaxMs: 30_000 } } = {}) => {
  const broadcastUiEvent = vi.fn();
  const runtime = createRetryPolicyRuntime({
    fsPromises: fs,
    path,
    instanceDir: os.tmpdir(),
    readSettings: async () => settings,
    authorizeRequest: (req) => req.headers.authorization === 'Bearer token',
    broadcastUiEvent,
  });
  const app = express();
  runtime.registerRoutes(app, express);
  return { runtime, app, broadcastUiEvent };
};

const report = (overrides = {}) => ({
  sessionID: 'ses_1',
  attempt: 2,
  message: 'rate limited',
  delay: 900_000,
  ...overrides,
});

describe('retry policy route', () => {
  it('rejects a report without the callback token', async () => {
    const { app } = createRuntime();
    await request(app).post('/api/openchamber/retry-policy').send(report()).expect(401);
  });

  it('rejects a malformed report', async () => {
    const { app } = createRuntime();
    await request(app)
      .post('/api/openchamber/retry-policy')
      .set('authorization', 'Bearer token')
      .send({ delay: -1 })
      .expect(400);
  });

  it('caps a provider wait at the configured maximum', async () => {
    const { app, broadcastUiEvent } = createRuntime({ settings: { retryWaitMaxMs: 30_000 } });
    const response = await request(app)
      .post('/api/openchamber/retry-policy')
      .set('authorization', 'Bearer token')
      .send(report())
      .expect(200);
    expect(response.body).toEqual({ delay: 30_000, hold: false });
    expect(broadcastUiEvent).not.toHaveBeenCalled();
  });

  it('leaves a wait shorter than the cap alone', async () => {
    const { app } = createRuntime({ settings: { retryWaitMaxMs: 30_000 } });
    const response = await request(app)
      .post('/api/openchamber/retry-policy')
      .set('authorization', 'Bearer token')
      .send(report({ delay: 4_000 }))
      .expect(200);
    expect(response.body).toEqual({ delay: 4_000, hold: false });
  });

  it('never exceeds the setting ceiling even when the stored value is larger', async () => {
    const { app } = createRuntime({ settings: { retryWaitMaxMs: RETRY_WAIT_MAX_MS * 4 } });
    const response = await request(app)
      .post('/api/openchamber/retry-policy')
      .set('authorization', 'Bearer token')
      .send(report())
      .expect(200);
    expect(response.body).toEqual({ delay: RETRY_WAIT_MAX_MS, hold: false });
  });

  it('leaves the proposal alone when no cap is configured', async () => {
    const { app } = createRuntime({ settings: {} });
    const response = await request(app)
      .post('/api/openchamber/retry-policy')
      .set('authorization', 'Bearer token')
      .send(report())
      .expect(200);
    expect(response.body).toEqual({ delay: 900_000, hold: false });
  });

  it('holds the wait and announces it when the retry-now control is on', async () => {
    const { app, broadcastUiEvent } = createRuntime({ settings: { retryWaitMaxMs: 30_000, retryNowEnabled: true } });
    const before = Date.now();
    const response = await request(app)
      .post('/api/openchamber/retry-policy')
      .set('authorization', 'Bearer token')
      .send(report())
      .expect(200);

    expect(response.body).toEqual({ delay: 30_000, hold: true });
    expect(broadcastUiEvent).toHaveBeenCalledTimes(1);
    const [event] = broadcastUiEvent.mock.calls[0];
    expect(event.type).toBe('openchamber:session-status');
    expect(event.properties).toMatchObject({
      sessionID: 'ses_1',
      status: 'retry',
      metadata: { attempt: 2, message: 'rate limited' },
    });
    expect(event.properties.metadata.next).toBeGreaterThanOrEqual(before + 30_000);
  });

  it('holds without a cap when retry-now is on', async () => {
    const { app, broadcastUiEvent } = createRuntime({ settings: { retryNowEnabled: true } });
    const response = await request(app)
      .post('/api/openchamber/retry-policy')
      .set('authorization', 'Bearer token')
      .send(report())
      .expect(200);
    expect(response.body).toEqual({ delay: 900_000, hold: true });
    expect(broadcastUiEvent).toHaveBeenCalledTimes(1);
  });
});

describe('retry policy plugin', () => {
  const loadPlugin = async () => {
    const instanceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-retry-policy-'));
    temporaryDirectories.push(instanceDir);
    const runtime = createRetryPolicyRuntime({
      fsPromises: fs,
      path,
      instanceDir,
      readSettings: async () => ({}),
      authorizeRequest: () => true,
    });
    const directory = await runtime.materializePlugin();
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
    expect(manifest.exports['.']).toBe('./index.js');
    const module = await import(`${pathToFileURL(path.join(directory, 'index.js')).href}?t=${Date.now()}`);
    return module.default;
  };

  const createContext = () => {
    const hooks = {};
    const commands = {};
    return {
      hooks,
      commands,
      ctx: {
        command: {
          transform: async (callback) => {
            const editor = { add: (definition) => { commands[definition.name] = definition; } };
            await callback(editor);
          },
        },
        session: {
          hook: async (name, callback) => { hooks[name] = callback; },
        },
      },
    };
  };

  const retryEvent = (overrides = {}) => ({
    sessionID: 'ses_1',
    agent: 'build',
    model: { providerID: 'anthropic', id: 'claude-opus' },
    error: { type: 'provider.rate-limit', message: 'rate limited' },
    attempt: 2,
    decision: { retry: true, delay: 900_000 },
    ...overrides,
  });

  const withCallbackEnv = async (run) => {
    const saved = { url: process.env.OPENCHAMBER_AGENT_TOOL_URL, token: process.env.OPENCHAMBER_AGENT_TOOL_TOKEN };
    process.env.OPENCHAMBER_AGENT_TOOL_URL = 'http://127.0.0.1:4100/api/openchamber/agent-tool';
    process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = 'token';
    try {
      await run();
    } finally {
      for (const [key, value] of [['OPENCHAMBER_AGENT_TOOL_URL', saved.url], ['OPENCHAMBER_AGENT_TOOL_TOKEN', saved.token]]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  it('replaces the proposed wait with the server answer', async () => {
    const plugin = await loadPlugin();
    const { ctx, hooks } = createContext();
    await plugin.setup(ctx);
    await withCallbackEnv(async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ delay: 30_000, hold: false })));
      vi.stubGlobal('fetch', fetchMock);
      const event = retryEvent();

      await hooks.retry(event);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://127.0.0.1:4100/api/openchamber/retry-policy');
      expect(init.headers.authorization).toBe('Bearer token');
      expect(JSON.parse(init.body)).toEqual({
        sessionID: 'ses_1',
        attempt: 2,
        message: 'rate limited',
        delay: 900_000,
      });
      expect(event.decision).toEqual({ retry: true, delay: 30_000 });
    });
  });

  it('holds the wait until the retry-now command wakes it', async () => {
    const plugin = await loadPlugin();
    const { ctx, hooks, commands } = createContext();
    await plugin.setup(ctx);
    await withCallbackEnv(async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ delay: 2_000, hold: true }))));
      const event = retryEvent();
      const started = Date.now();
      const pending = hooks.retry(event);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await commands[RETRY_NOW_COMMAND].execute({ sessionID: 'ses_1' });
      await pending;

      expect(Date.now() - started).toBeLessThan(500);
      expect(event.decision).toEqual({ retry: true, delay: 0 });
    });
  });

  it('keeps OpenCode\'s decision when the server cannot be reached', async () => {
    const plugin = await loadPlugin();
    const { ctx, hooks } = createContext();
    await plugin.setup(ctx);
    await withCallbackEnv(async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
      const event = retryEvent();

      await hooks.retry(event);

      expect(event.decision).toEqual({ retry: true, delay: 900_000 });
    });
  });

  it('does not report a failure OpenCode will not retry', async () => {
    const plugin = await loadPlugin();
    const { ctx, hooks } = createContext();
    await plugin.setup(ctx);
    await withCallbackEnv(async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const event = retryEvent({ decision: { retry: false } });

      await hooks.retry(event);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(event.decision).toEqual({ retry: false });
    });
  });
});

describe('isRetryPolicyConfigured', () => {
  it('loads the plugin for a positive cap or the retry-now control', () => {
    expect(isRetryPolicyConfigured({ retryWaitMaxMs: 30_000 })).toBe(true);
    expect(isRetryPolicyConfigured({ retryNowEnabled: true })).toBe(true);
    expect(isRetryPolicyConfigured({ retryWaitMaxMs: 0, retryNowEnabled: false })).toBe(false);
    expect(isRetryPolicyConfigured({})).toBe(false);
    expect(isRetryPolicyConfigured(null)).toBe(false);
  });
});
