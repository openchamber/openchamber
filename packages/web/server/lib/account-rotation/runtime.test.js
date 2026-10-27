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
  const entries = ['a', 'b', 'c', 'd'].map((id) => ({ type: 'credential', id, label: `Account ${id}`, method: 'oauth' }));
  const accounts = {
    list: vi.fn(async () => [entries.find((entry) => entry.id === active), ...entries.filter((entry) => entry.id !== active)].filter(Boolean)),
    activate: vi.fn(async (id) => { active = id; }),
  };
  const options = { dataDir, accounts, now: () => time };
  const runtime = createAccountRotationRuntime(options);
  const fail = (extra = {}) => runtime.recover({ providerID: 'openai', error: usageError(), startedAt: time - 1, directory: '/repo', ...extra });
  const enable = () => runtime.save('openai', { enabled: true }, '/repo');
  return { runtime, options, accounts, entries, fail, enable, dataDir, advance: (ms = 10) => { time += ms; }, active: () => active };
};
const retry = (account) => ({ limited: true, retry: true, accountLabel: `Account ${account}` });
const declined = { limited: true, retry: false };

describe('provider account rotation', () => {
  it('requires a usage-limit signal and leaves transient rate limits alone', () => {
    expect(openAIUsageLimit({ message: 'Too many requests', status: 429 })).toBeNull();
    expect(openAIUsageLimit({ message: 'Request failed', status: 500 })).toBeNull();
    expect(openAIUsageLimit({ message: 'usage_limit_reached', status: 401 })).toBeNull();
    expect(openAIUsageLimit(usageError(5000))).toEqual({ resetAt: 5_000_000 });
    expect(openAIUsageLimit({ message: "You've hit your usage limit. Try again later." })).toEqual({ resetAt: null });
  });

  it('starts disabled and scopes settings and classification to supported providers', async () => {
    const { runtime, accounts, fail, enable } = await setup();
    expect(await runtime.describe('openai')).toEqual({ enabled: false });
    expect(await fail()).toEqual({ limited: false, retry: false });
    await enable();
    expect(await fail({ providerID: 'anthropic' })).toEqual({ limited: false, retry: false });
    expect(await fail({ error: { message: 'Too many requests', status: 429 } })).toEqual({ limited: false, retry: false });
    expect(runtime.supports('anthropic')).toBe(false);
    await expect(runtime.save('anthropic', { enabled: true }, '/repo')).rejects.toMatchObject({ statusCode: 501 });
    expect(accounts.activate).not.toHaveBeenCalled();
  });

  it('rotates saved sign-ins and stops when every account is exhausted', async () => {
    const { accounts, fail, enable, advance, active } = await setup();
    await enable();
    for (const expected of ['b', 'c', 'd']) {
      expect(await fail()).toEqual(retry(expected));
      expect(active()).toBe(expected);
      advance();
    }
    expect(await fail()).toEqual(declined);
    expect(accounts.activate.mock.calls.flat()).toEqual(['b', 'c', 'd']);
  });

  it('shares one switch between simultaneous chat, goal, and subagent failures', async () => {
    const { accounts, fail, enable } = await setup();
    await enable();
    expect(await Promise.all([fail(), fail(), fail()])).toEqual([retry('b'), retry('b'), retry('b')]);
    expect(accounts.activate).toHaveBeenCalledTimes(1);
  });

  it('reuses a switched account for an older failure without charging its cooldown', async () => {
    const { accounts, fail, enable, advance } = await setup();
    await enable();
    expect(await fail()).toEqual(retry('b'));
    advance(5000);
    expect(await fail({ startedAt: 999_999 })).toEqual(retry('b'));
    expect(accounts.activate.mock.calls.flat()).toEqual(['b']);
    expect(await fail()).toEqual(retry('c'));
  });

  it('records exhaustion after the one retry but cannot switch again', async () => {
    const { accounts, fail, enable, advance, dataDir } = await setup();
    await enable();
    await fail();
    advance();
    expect(await fail({ allowSwitch: false })).toEqual(declined);
    expect(accounts.activate.mock.calls.flat()).toEqual(['b']);
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'account-rotation.json'), 'utf8'));
    expect(stored.openai.exhausted.b).toBeGreaterThan(1_000_000);
  });

  it('persists cooldowns across restart and allows an account after its reported reset', async () => {
    const { options, accounts, entries, fail, enable, advance } = await setup();
    entries.splice(2);
    await enable();
    await fail({ error: usageError(1002) });
    advance(3000);
    const restarted = createAccountRotationRuntime(options);
    expect(await restarted.recover({ providerID: 'openai', directory: '/repo', startedAt: 1_002_999, error: usageError() })).toEqual(retry('a'));
    expect(accounts.activate.mock.calls.flat()).toEqual(['b', 'a']);
  });

  it('uses a one-hour cooldown when no reset is reported', async () => {
    const { entries, fail, enable, advance } = await setup();
    entries.splice(2);
    await enable();
    await fail();
    advance();
    expect(await fail()).toEqual(declined);
    advance(3_600_000);
    expect(await fail()).toEqual(retry('a'));
  });

  it('requires two usable OAuth sign-ins and excludes keys and reauthentication', async () => {
    const { runtime, entries, enable } = await setup();
    entries[1].method = 'key';
    entries[2].status = { status: 'needs_auth' };
    entries.splice(3);
    await expect(enable()).rejects.toMatchObject({ statusCode: 400 });
    expect(await runtime.describe('openai')).toEqual({ enabled: false });
  });

  it('skips removed accounts and accounts requiring sign-in', async () => {
    const { entries, fail, enable, active } = await setup();
    await enable();
    entries[1].status = { status: 'needs_auth', message: 'Sign in again' };
    entries.splice(2, 1);
    expect(await fail()).toEqual(retry('d'));
    expect(active()).toBe('d');
  });

  it('preserves settings on a failed catalog read and can still be disabled offline', async () => {
    const { runtime, accounts, enable } = await setup();
    await enable();
    accounts.list.mockRejectedValue(new Error('Offline'));
    await expect(enable()).rejects.toThrow('Offline');
    expect(await runtime.describe('openai')).toEqual({ enabled: true });
    expect(await runtime.save('openai', { enabled: false }, '/repo')).toEqual({ enabled: false });
  });

  it('preserves malformed persistence and refuses to overwrite it', async () => {
    const { runtime, dataDir, fail } = await setup();
    const file = path.join(dataDir, 'account-rotation.json');
    fs.writeFileSync(file, '{broken');
    await expect(runtime.describe('openai')).rejects.toThrow('Could not read');
    await expect(fail()).rejects.toThrow('Could not read');
    await expect(runtime.save('openai', { enabled: false }, '/repo')).rejects.toThrow('Could not read');
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
  });

  it('preserves the cooldown if activation fails', async () => {
    const { accounts, fail, enable, dataDir } = await setup();
    await enable();
    accounts.activate.mockRejectedValueOnce(new Error('Offline'));
    await expect(fail()).rejects.toThrow('Offline');
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'account-rotation.json'), 'utf8')).openai;
    expect(state.exhausted.a).toBeGreaterThan(1_000_000);
    expect(state.switchedTo).toBeNull();
  });

  it('does not activate when exhaustion cannot be saved', async () => {
    const { accounts, fail, enable, dataDir } = await setup();
    await enable();
    const file = path.join(dataDir, 'account-rotation.json');
    const before = fs.readFileSync(file, 'utf8');
    fs.chmodSync(file, 0o400);
    try {
      await expect(fail()).rejects.toThrow();
      expect(accounts.activate).not.toHaveBeenCalled();
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    } finally { fs.chmodSync(file, 0o600); }
  });

  it('does not offer or run recovery against an external OpenCode process', async () => {
    const { options } = await setup();
    const runtime = createAccountRotationRuntime({ ...options, isAvailable: () => false });
    expect(runtime.supports('openai')).toBe(false);
    await expect(runtime.save('openai', { enabled: true }, '/repo')).rejects.toMatchObject({ statusCode: 501 });
    expect(await runtime.recover({ providerID: 'openai', error: usageError() })).toEqual({ limited: false, retry: false });
  });

  it.each(['', '1'])('serves provider-scoped settings with enterprise mode %s', async (enterprise) => {
    vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', enterprise);
    const { runtime, accounts } = await setup();
    const app = express();
    app.use(express.json());
    registerAccountRotationRoutes(app, { runtime, resolveProjectDirectory: async () => ({ directory: '/repo' }) });
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const url = `${base}/api/provider/openai/account-rotation`;
    const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true });
    expect(await (await fetch(url)).json()).toEqual({ enabled: true });
    expect((await fetch(`${base}/api/provider/anthropic/account-rotation`)).status).toBe(501);
    expect(accounts.activate).not.toHaveBeenCalled();
  });
});
