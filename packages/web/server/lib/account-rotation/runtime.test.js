import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAccountRotationRuntime, openAIUsageLimit, registerAccountRotationRoutes } from './runtime.js';

const directories = [];
const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const usageError = (reset = null) => ({
  type: 'provider.error', message: "You've hit your usage limit", status: 429,
  response: { body: JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: reset ?? undefined } }) },
});
const setup = async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-rotation-'));
  directories.push(dataDir);
  let time = 1_000_000;
  let active = 'a';
  const entries = ['a', 'b', 'c', 'd'].map((id) => ({ type: 'credential', id, label: id, method: 'oauth' }));
  const accounts = {
    list: vi.fn(async () => [entries.find((entry) => entry.id === active), ...entries.filter((entry) => entry.id !== active)].filter(Boolean)),
    activate: vi.fn(async (id) => { active = id; }),
  };
  const options = { dataDir, accounts, now: () => time };
  const runtime = createAccountRotationRuntime(options);
  const fail = (extra = {}) => runtime.recover({ providerID: 'openai', error: usageError(), startedAt: time - 1, directory: '/repo', ...extra });
  return { runtime, options, accounts, entries, fail, dataDir, advance: (ms = 10) => { time += ms; }, active: () => active };
};

describe('OpenAI usage exhaustion', () => {
  it('requires a usage-limit signal and leaves transient rate limits alone', () => {
    expect(openAIUsageLimit({ message: 'Too many requests', status: 429 })).toBeNull();
    expect(openAIUsageLimit({ message: 'Request failed', status: 500 })).toBeNull();
    expect(openAIUsageLimit({ message: 'usage_limit_reached', status: 401 })).toBeNull();
    expect(openAIUsageLimit(usageError(5000))).toEqual({ resetAt: 5_000_000 });
    expect(openAIUsageLimit({ message: "You've hit your usage limit. Try again later." })).toEqual({ resetAt: null });
  });

  it('starts disabled and never rotates another provider or a generic 429', async () => {
    const { runtime, accounts, fail } = await setup();
    expect(await runtime.describe()).toEqual({ enabled: false, accountIds: [] });
    expect(await fail()).toBe(false);
    await runtime.save({ enabled: true, accountIds: ['a', 'b'] }, '/repo');
    expect(await fail({ providerID: 'anthropic' })).toBe(false);
    expect(await fail({ error: { message: 'Too many requests', status: 429 } })).toBe(false);
    expect(accounts.activate).not.toHaveBeenCalled();
  });

  it('rotates four sign-ins in the selected order and stops when all are exhausted', async () => {
    const { runtime, accounts, fail, advance, active } = await setup();
    await runtime.save({ enabled: true, accountIds: ['a', 'c', 'b', 'd'] }, '/repo');
    for (const expected of ['c', 'b', 'd']) {
      expect(await fail()).toBe(true);
      expect(active()).toBe(expected);
      advance();
    }
    expect(await fail()).toBe(false);
    expect(accounts.activate.mock.calls.flat()).toEqual(['c', 'b', 'd']);
  });

  it('shares one switch between simultaneous failures from different goals', async () => {
    const { runtime, accounts, fail, active } = await setup();
    await runtime.save({ enabled: true, accountIds: ['a', 'b', 'c', 'd'] }, '/repo');
    expect(await Promise.all([fail(), fail(), fail()])).toEqual([true, true, true]);
    expect(accounts.activate).toHaveBeenCalledTimes(1);
    expect(active()).toBe('b');
  });

  it('reuses the switched account when an older in-flight request fails later', async () => {
    const { runtime, accounts, fail, advance } = await setup();
    await runtime.save({ enabled: true, accountIds: ['a', 'b', 'c'] }, '/repo');
    expect(await fail()).toBe(true);
    advance(5000);
    expect(await fail({ startedAt: 999_999 })).toBe(true);
    expect(accounts.activate.mock.calls.flat()).toEqual(['b']);
    expect(await fail()).toBe(true);
    expect(accounts.activate.mock.calls.flat()).toEqual(['b', 'c']);
  });

  it('persists cooldowns across runtime recreation and retries after a reported reset', async () => {
    const { runtime, options, accounts, fail, advance } = await setup();
    await runtime.save({ enabled: true, accountIds: ['a', 'b'] }, '/repo');
    await fail({ error: usageError(1002) });
    advance(3000);
    const restarted = createAccountRotationRuntime(options);
    expect(await restarted.recover({ providerID: 'openai', directory: '/repo', startedAt: 1_002_999, error: usageError() })).toBe(true);
    expect(accounts.activate.mock.calls.flat()).toEqual(['b', 'a']);
  });

  it('rejects API keys, duplicates, missing accounts, and an enabled single-account pool', async () => {
    const { runtime, entries } = await setup();
    entries[1].method = 'key';
    for (const accountIds of [['a', 'b'], ['a', 'a'], ['a', 'missing'], ['a']]) {
      await expect(runtime.save({ enabled: true, accountIds }, '/repo')).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(await runtime.describe()).toEqual({ enabled: false, accountIds: [] });
  });

  it('skips removed accounts and accounts requiring sign-in', async () => {
    const { runtime, entries, fail, active } = await setup();
    await runtime.save({ enabled: true, accountIds: ['a', 'b', 'c', 'd'] }, '/repo');
    entries[1].status = { status: 'needs_auth', message: 'Sign in again' };
    entries.splice(2, 1);
    expect(await fail()).toBe(true);
    expect(active()).toBe('d');
  });

  it('keeps prior settings when validation or a credential read fails', async () => {
    const { runtime, accounts } = await setup();
    const config = { enabled: true, accountIds: ['a', 'b'] };
    await runtime.save(config, '/repo');
    accounts.list.mockRejectedValueOnce(new Error('Offline'));
    await expect(runtime.save(config, '/repo')).rejects.toThrow('Offline');
    expect(await runtime.describe()).toEqual(config);
  });

  it('can be disabled when OpenCode is offline or a selected account was removed', async () => {
    const { runtime, accounts } = await setup();
    await runtime.save({ enabled: true, accountIds: ['a', 'b'] }, '/repo');
    accounts.list.mockRejectedValue(new Error('Offline'));
    const disabled = { enabled: false, accountIds: ['a', 'b'] };
    expect(await runtime.save(disabled, '/repo')).toEqual(disabled);
    expect(await runtime.describe()).toEqual(disabled);
  });

  it('fails on malformed persistence without replacing it', async () => {
    const { runtime, dataDir, fail } = await setup();
    const file = path.join(dataDir, 'account-rotation.json');
    fs.writeFileSync(file, '{broken');
    await expect(runtime.describe()).rejects.toThrow('Could not read');
    await expect(fail()).rejects.toThrow('Could not read');
    await expect(runtime.save({ enabled: false, accountIds: [] }, '/repo')).rejects.toThrow('Could not read');
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
  });

  it('records exhaustion even when activation fails and does not claim success', async () => {
    const { runtime, accounts, fail, dataDir } = await setup();
    await runtime.save({ enabled: true, accountIds: ['a', 'b'] }, '/repo');
    accounts.activate.mockRejectedValueOnce(new Error('Offline'));
    await expect(fail()).rejects.toThrow('Offline');
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'account-rotation.json'), 'utf8'));
    expect(state.exhausted.a).toBeGreaterThan(1_000_000);
    expect(state.switchedTo).toBeNull();
  });

  it('keeps the current account and persisted settings when exhaustion cannot be saved', async () => {
    const { runtime, accounts, fail, dataDir } = await setup();
    await runtime.save({ enabled: true, accountIds: ['a', 'b'] }, '/repo');
    const file = path.join(dataDir, 'account-rotation.json');
    const before = fs.readFileSync(file, 'utf8');
    fs.chmodSync(file, 0o400);
    try {
      await expect(fail()).rejects.toThrow();
      expect(accounts.activate).not.toHaveBeenCalled();
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });

  it.each(['', '1'])('serves metadata-only configuration with enterprise mode %s', async (enterprise) => {
    vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', enterprise);
    const { runtime, accounts } = await setup();
    const app = express();
    app.use(express.json());
    registerAccountRotationRoutes(app, { runtime, resolveProjectDirectory: async () => ({ directory: '/repo' }) });
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/provider/account-rotation`;
    const config = { enabled: true, accountIds: ['a', 'b'] };
    const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(config);
    expect(await (await fetch(url)).json()).toEqual(config);
    expect(accounts.activate).not.toHaveBeenCalled();
  });
});
