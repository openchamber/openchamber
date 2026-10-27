import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createAccountRotationRuntime } from './runtime.js';
import { materializeRotationPlugin, registerRotationPluginRoute, setupRotationPlugin } from './plugin.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const quota = { type: 'provider.quota', message: "You've hit your usage limit" };

const harness = async ({ enabled = true } = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rotation-plugin-'));
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  let active = 'a';
  const accounts = {
    list: async () => [active, ...['a', 'b', 'c'].filter((id) => id !== active)]
      .map((id) => ({ type: 'credential', method: 'oauth', id, label: `Account ${id}` })),
    activate: vi.fn(async (id) => { active = id; }),
  };
  const runtime = createAccountRotationRuntime({ dataDir, accounts });
  if (enabled) await runtime.save('openai', { enabled: true }, '/repo');
  const broadcast = vi.fn();
  const app = express();
  registerRotationPluginRoute(app, { express, runtime, broadcast, authorize: (req) => req.headers.authorization === 'Bearer test-token' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/openchamber/agent-tool`;
  const hooks = new Map();
  let events;
  const ctx = {
    location: { directory: '/repo' },
    session: { hook: async (name, handler) => { hooks.set(name, handler); } },
    event: { subscribe: ({ signal }) => new ReadableStream({ start(controller) {
      events = controller;
      signal.addEventListener('abort', () => controller.close(), { once: true });
    } }) },
  };
  const cleanup = await setupRotationPlugin(ctx, { url, token: 'test-token' });
  cleanups.push(cleanup);
  const request = (sessionID = 'chat') => hooks.get('model.request')({ kind: 'primary', sessionID });
  const fail = async (sessionID = 'chat', attempt = 2, error = quota) => {
    const event = { sessionID, attempt, error, model: { providerID: 'openai', id: 'same-model' }, decision: { retry: false } };
    await hooks.get('retry')(event);
    return event;
  };
  return { accounts, runtime, request, fail, hooks, broadcast, url, events, dataDir };
};

it.each(['chat', 'goal', 'subagent'])('retries one failed %s request and announces the account', async (sessionID) => {
  const { request, fail, accounts, broadcast } = await harness();
  request(sessionID);
  const event = await fail(sessionID);
  expect(event.decision).toEqual({ retry: true, delay: 0 });
  expect(event.model).toEqual({ providerID: 'openai', id: 'same-model' });
  expect(accounts.activate).toHaveBeenCalledExactlyOnceWith('b');
  expect(broadcast).toHaveBeenCalledExactlyOnceWith({ type: 'openchamber:account-rotated', properties: {
    providerID: 'openai', accountLabel: 'Account b', sessionID,
  } });
});

it('does not add another retry after recovery fails, even with another available account', async () => {
  const { request, fail, accounts } = await harness();
  request();
  await fail();
  request();
  expect((await fail('chat', 3)).decision).toEqual({ retry: false });
  expect(accounts.activate).toHaveBeenCalledTimes(1);
});

it('leaves the original error when the entire account pool is exhausted', async () => {
  const { request, fail, runtime, accounts } = await harness();
  for (let i = 0; i < 2; i++) {
    await runtime.recover({ providerID: 'openai', error: quota, directory: '/repo', startedAt: Date.now() + 1 });
  }
  request();
  const event = await fail();
  expect(event.decision).toEqual({ retry: false });
  expect(event.error).toBe(quota);
  expect(accounts.activate).toHaveBeenCalledTimes(2);
});

it('preserves the default retry policy for transient rate limits', async () => {
  const { request, hooks, accounts } = await harness();
  request();
  const event = { sessionID: 'chat', attempt: 2, model: { providerID: 'openai' },
    error: { message: 'Too many requests', status: 429 }, decision: { retry: true, delay: 2000 } };
  await hooks.get('retry')(event);
  expect(event.decision).toEqual({ retry: true, delay: 2000 });
  expect(accounts.activate).not.toHaveBeenCalled();
});

it('allows the first account recovery after an ordinary transient retry', async () => {
  const { request, hooks, fail, accounts } = await harness();
  request();
  await hooks.get('retry')({ sessionID: 'chat', attempt: 2, model: { providerID: 'openai' },
    error: { message: 'Too many requests', status: 429 }, decision: { retry: true, delay: 2000 } });
  request();
  expect((await fail('chat', 3)).decision).toEqual({ retry: true, delay: 0 });
  request();
  expect((await fail('chat', 4)).decision).toEqual({ retry: false });
  expect(accounts.activate).toHaveBeenCalledTimes(1);
});

it('permits account recovery again for a later logical step', async () => {
  const { request, fail } = await harness();
  request();
  await fail();
  // The next step's first decision restarts native numbering at 2.
  request();
  expect((await fail('chat', 2)).decision).toEqual({ retry: true, delay: 0 });
});

it('keeps rotation disabled and prevents duplicate callback recovery', async () => {
  const { request, fail, hooks, accounts } = await harness({ enabled: false });
  request();
  expect((await fail()).decision).toEqual({ retry: false });
  expect((await fail()).decision).toEqual({ retry: false });
  request();
  const event = { sessionID: 'chat', attempt: 2, model: { providerID: 'openai' }, error: quota, decision: { retry: true, delay: 2000 } };
  await hooks.get('retry')(event);
  expect(event.decision).toEqual({ retry: true, delay: 2000 });
  expect(accounts.activate).not.toHaveBeenCalled();
});

it('clears request attribution when a session stops', async () => {
  const { request, fail, accounts, events } = await harness();
  request();
  events.enqueue({ type: 'session.execution.interrupted', data: { sessionID: 'chat' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((await fail()).decision).toEqual({ retry: false });
  expect(accounts.activate).not.toHaveBeenCalled();
});

it('ignores unrelated events even when OpenCode ignores the subscription filter', async () => {
  const { request, fail, events } = await harness();
  request();
  events.enqueue({ type: 'session.renamed', data: { sessionID: 'chat' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((await fail()).decision).toEqual({ retry: true, delay: 0 });
});

it('ignores a recovery result that arrives after Stop', async () => {
  const { request, fail, accounts, events } = await harness();
  let release;
  let didStart;
  const held = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { didStart = resolve; });
  const activate = accounts.activate.getMockImplementation();
  accounts.activate.mockImplementationOnce(async (id) => { didStart(); await held; await activate(id); });
  request();
  const result = fail();
  await started;
  events.enqueue({ type: 'session.execution.interrupted', data: { sessionID: 'chat' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  expect((await result).decision).toEqual({ retry: false });
});

it('fails closed on callback failure and rejects unauthorized or malformed requests', async () => {
  const { request, fail, accounts, url } = await harness();
  accounts.activate.mockRejectedValueOnce(new Error('Unavailable'));
  request();
  expect((await fail()).decision).toEqual({ retry: false });
  expect((await fetch(`${url}/account-rotation`, { method: 'POST' })).status).toBe(401);
  expect((await fetch(`${url}/account-rotation`, { method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(400);
});

it('materializes an importable plugin using the managed callback environment', async () => {
  const { dataDir } = await harness();
  const directory = await materializeRotationPlugin(dataDir);
  const plugin = await import(path.join(directory, 'index.js'));
  expect(plugin.default.id).toBe('openchamber-account-rotation');
  expect(plugin.default.setup).toBeTypeOf('function');
});
