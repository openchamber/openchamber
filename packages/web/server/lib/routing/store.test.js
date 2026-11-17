import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AUTO_SESSIONS_MAX_BYTES,
  CLASSIFIER_SOURCE_MAX_BYTES,
  CUSTOM_ENDPOINT_MAX_BYTES,
  createRoutingStore,
  parseEffectiveConfig,
  resolveEffectiveConfig,
  ROUTING_AUTH_MAX_BYTES,
  ROUTING_CONFIG_MAX_BYTES,
  toStoredConfig,
} from './store.js';
import { BUILTIN_CATEGORIES } from './defaults.js';

const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'routing-store-'));

const sampleConfig = (patch = {}) => ({
  enabled: true,
  fallback: { model: { providerID: 'anthropic', modelID: 'claude-sonnet-5' }, variant: 'medium' },
  minConfidence: 0.6,
  preserveCache: true,
  safetyNet: { enabled: true, threshold: 0.6 },
  stickiness: { enabled: true, enterTurns: 2, exitTurns: 3, strongConfidence: 0.9 },
  categories: resolveEffectiveConfig(null).categories,
  ...patch,
});

describe('routing store', () => {
  it('resolves the defaults when nothing is stored', async () => {
    const store = createRoutingStore({ dataDir: await tempDir() });
    const config = await store.readConfig();
    expect(config.enabled).toBe(false);
    expect(config.fallback).toBeNull();
    expect(config.categories.map((c) => c.id)).toEqual(BUILTIN_CATEGORIES.map((c) => c.id));
    expect(config.categories.every((c) => c.builtin && c.enabled && c.model === null)).toBe(true);
  });

  it('stores stickiness only when it differs from the defaults', async () => {
    const dir = await tempDir();
    const store = createRoutingStore({ dataDir: dir });
    await store.writeConfig(sampleConfig());
    expect(JSON.parse(await fs.readFile(path.join(dir, 'routing.json'), 'utf8')).stickiness).toBeUndefined();
    const tuned = { enabled: true, enterTurns: 1, exitTurns: 5, strongConfidence: 0.8 };
    await store.writeConfig(sampleConfig({ stickiness: tuned }));
    expect(JSON.parse(await fs.readFile(path.join(dir, 'routing.json'), 'utf8')).stickiness).toEqual(tuned);
    expect((await store.readConfig()).stickiness).toEqual(tuned);
  });

  it('rejects out-of-range stickiness and accepts a config without it', () => {
    const base = sampleConfig();
    expect(() => parseEffectiveConfig({ ...base, stickiness: { enabled: true, enterTurns: 0, exitTurns: 3, strongConfidence: 0.9 } })).toThrow(/stickiness/);
    const { stickiness: _omitted, ...older } = base;
    expect(parseEffectiveConfig(older).stickiness).toBeUndefined();
  });

  it('stores only deviations from the built-ins and round-trips them', async () => {
    const dir = await tempDir();
    const store = createRoutingStore({ dataDir: dir });
    const config = sampleConfig();
    config.categories[0] = { ...config.categories[0], enabled: false };
    config.categories = config.categories.map((category) => category.id === 'hard'
      ? { ...category, model: { providerID: 'openai', modelID: 'gpt-6-astra' }, variant: 'high', agent: 'plan' }
      : category);
    config.categories.push({ id: 'my-refactors', builtin: false, enabled: true, name: 'My refactors', description: 'Refactors across modules.', model: null, variant: null, agent: null });
    await store.writeConfig(config);

    const stored = JSON.parse(await fs.readFile(path.join(dir, 'routing.json'), 'utf8'));
    expect(stored.categories).toEqual({
      trivial: { builtin: true, disabled: true },
      hard: { builtin: true, model: { providerID: 'openai', modelID: 'gpt-6-astra' }, variant: 'high', agent: 'plan' },
      'my-refactors': { builtin: false, name: 'My refactors', description: 'Refactors across modules.' },
    });
    expect(await store.readConfig()).toEqual(config);
  });

  it('keeps the cache setting on until it is turned off, also for clients that do not send it', async () => {
    expect(resolveEffectiveConfig(null).preserveCache).toBe(true);
    expect(resolveEffectiveConfig({ version: 1, enabled: true }).preserveCache).toBe(true);

    const store = createRoutingStore({ dataDir: await tempDir() });
    await store.writeConfig(sampleConfig({ preserveCache: false }));
    expect((await store.readConfig()).preserveCache).toBe(false);

    const { preserveCache: _omitted, ...older } = sampleConfig();
    expect(parseEffectiveConfig(older).preserveCache).toBe(true);
  });

  it('records a removed built-in as deleted and keeps the others', async () => {
    const config = sampleConfig();
    config.categories = config.categories.filter((c) => c.id !== 'research');
    const stored = toStoredConfig(config);
    expect(stored.categories.research).toEqual({ builtin: true, deleted: true });
    const resolved = resolveEffectiveConfig(stored);
    expect(resolved.categories.map((c) => c.id)).toEqual(['trivial', 'implement', 'review', 'hard']);
  });

  it('applies later built-in text to an untouched category but keeps an edited one', () => {
    const edited = resolveEffectiveConfig({ version: 1, categories: { hard: { builtin: true, description: 'My own hard.' } } });
    expect(edited.categories.find((c) => c.id === 'hard').description).toBe('My own hard.');
    expect(edited.categories.find((c) => c.id === 'trivial').description).toBe(BUILTIN_CATEGORIES[0].description);
  });

  it('rejects a malformed file instead of treating it as empty', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'routing.json'), '{"version":1,"categories":{"x":{"builtin":false}}}');
    const store = createRoutingStore({ dataDir: dir });
    await expect(store.readConfig()).rejects.toThrow(/Invalid routing.json/);
  });

  it('reads a routing config at the byte cap and rejects one byte over it', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'routing.json');
    const valid = '{"version":1}';
    await fs.writeFile(file, valid + ' '.repeat(ROUTING_CONFIG_MAX_BYTES - Buffer.byteLength(valid)));
    const store = createRoutingStore({ dataDir: dir });
    expect((await store.readConfig()).enabled).toBe(false);

    await fs.appendFile(file, ' ');
    await expect(store.readConfig()).rejects.toThrow(/Invalid routing.json: exceeds .* byte limit/);
  });

  it('keeps unreadable-file defaults when routing files exceed their individual caps', async () => {
    const dir = await tempDir();
    await Promise.all([
      fs.writeFile(path.join(dir, 'routing-auth.json'), Buffer.alloc(ROUTING_AUTH_MAX_BYTES + 1)),
      fs.writeFile(path.join(dir, 'classification.json'), Buffer.alloc(CLASSIFIER_SOURCE_MAX_BYTES + 1)),
      fs.writeFile(path.join(dir, 'classifier-endpoint.json'), Buffer.alloc(CUSTOM_ENDPOINT_MAX_BYTES + 1)),
      fs.writeFile(path.join(dir, 'auto-sessions.json'), Buffer.alloc(AUTO_SESSIONS_MAX_BYTES + 1)),
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createRoutingStore({ dataDir: dir });

    await expect(store.readToken()).resolves.toBeNull();
    await expect(store.readClassifierSource()).resolves.toBeNull();
    await expect(store.readCustomEndpoint()).resolves.toBeNull();
    expect(store.readAutoSessions()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls.flat().join(' ')).toContain('exceeds');
    warn.mockRestore();
  });

  it.skipIf(process.platform === 'win32')('refuses FIFO routing files in async and sync readers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fifo = async (name) => {
      const dir = await tempDir();
      const file = path.join(dir, name);
      execFileSync('mkfifo', [file]);
      return createRoutingStore({ dataDir: dir });
    };

    const configStore = await fifo('routing.json');
    await expect(configStore.readConfig()).rejects.toThrow(/not a regular file/);

    const tokenStore = await fifo('routing-auth.json');
    await expect(tokenStore.readToken()).resolves.toBeNull();

    const classifierStore = await fifo('classification.json');
    await expect(classifierStore.readClassifierSource()).resolves.toBeNull();

    const endpointStore = await fifo('classifier-endpoint.json');
    await expect(endpointStore.readCustomEndpoint()).resolves.toBeNull();

    const sessionsStore = await fifo('auto-sessions.json');
    expect(sessionsStore.readAutoSessions()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });

  it('rejects an invalid PUT body with a 400 status', () => {
    expect(() => parseEffectiveConfig({ enabled: true })).toThrow(expect.objectContaining({ status: 400 }));
    const duplicate = sampleConfig();
    duplicate.categories = [...duplicate.categories, { ...duplicate.categories[0], builtin: false }];
    expect(() => parseEffectiveConfig(duplicate)).toThrow(/Duplicate category id/);
  });

  it('refuses the Auto sentinel as a fallback or category model', () => {
    const asFallback = sampleConfig({ fallback: { model: { providerID: 'openchamber', modelID: 'auto' }, variant: null } });
    expect(() => parseEffectiveConfig(asFallback)).toThrow(/Auto model cannot be a routing target/);
    const asCategory = sampleConfig();
    asCategory.categories = asCategory.categories.map((c, i) => (i === 0 ? { ...c, model: { providerID: 'openchamber', modelID: 'auto' } } : c));
    expect(() => parseEffectiveConfig(asCategory)).toThrow(/Auto model cannot be a routing target/);
  });

  it('keeps the token in its own 0600 file and clears it', async () => {
    const dir = await tempDir();
    const store = createRoutingStore({ dataDir: dir });
    expect(await store.readToken()).toBeNull();
    await store.writeToken('ts-secret');
    expect(await store.readToken()).toBe('ts-secret');
    const stat = await fs.stat(path.join(dir, 'routing-auth.json'));
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);
    expect(JSON.stringify(JSON.parse(await fs.readFile(path.join(dir, 'routing.json'), 'utf8').catch(() => '{}')))).not.toContain('ts-secret');
    await store.clearToken();
    expect(await store.readToken()).toBeNull();
  });

  it('round-trips the classifier pick and reads a broken file as no pick', async () => {
    const dir = await tempDir();
    const store = createRoutingStore({ dataDir: dir });
    expect(await store.readClassifierSource()).toBeNull();
    await store.writeClassifierSource('zen-key');
    expect(await store.readClassifierSource()).toBe('zen-key');
    await fs.writeFile(path.join(dir, 'classification.json'), '{"version":1,"source":"cloudflare"}');
    expect(await store.readClassifierSource()).toBeNull();
    await store.writeClassifierSource('custom');
    expect(await store.readClassifierSource()).toBe('custom');
  });

  it('keeps the custom endpoint in its own 0600 file, round-trips it and clears it', async () => {
    const dir = await tempDir();
    const store = createRoutingStore({ dataDir: dir });
    expect(await store.readCustomEndpoint()).toBeNull();
    const endpoint = { url: 'https://jev.example.com/v1/systemone', model: 'jev-latest', key: 'own-secret' };
    await store.writeCustomEndpoint(endpoint);
    await store.writeToken('ts-secret');
    expect(await store.readCustomEndpoint()).toEqual(endpoint);
    expect(await store.readToken()).toBe('ts-secret');
    const stat = await fs.stat(path.join(dir, 'classifier-endpoint.json'));
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);
    await store.writeCustomEndpoint({ url: endpoint.url, model: 'jev-1.13' });
    expect(await store.readCustomEndpoint()).toEqual({ url: endpoint.url, model: 'jev-1.13' });
    await store.clearCustomEndpoint();
    expect(await store.readCustomEndpoint()).toBeNull();
    expect(await store.readToken()).toBe('ts-secret');
  });

  it('reads a hand-edited custom endpoint with an unsafe URL as none', async () => {
    const dir = await tempDir();
    const store = createRoutingStore({ dataDir: dir });
    await fs.writeFile(path.join(dir, 'classifier-endpoint.json'), JSON.stringify({ version: 1, endpoint: { url: 'file:///etc/hosts', model: 'jev-latest' } }));
    expect(await store.readCustomEndpoint()).toBeNull();
  });

  it('reads no Auto sessions before any are saved, and round-trips the list in its order', async () => {
    const store = createRoutingStore({ dataDir: await tempDir() });
    expect(store.readAutoSessions()).toEqual([]);
    const sessions = [
      { sessionId: 'ses_b', directory: '/repo', at: 2 },
      { sessionId: 'ses_a', directory: null, at: 1 },
    ];
    store.writeAutoSessions(sessions);
    expect(store.readAutoSessions()).toEqual(sessions);
    store.writeAutoSessions([]);
    expect(store.readAutoSessions()).toEqual([]);
  });

  it('reads a malformed Auto session file as none with a warning, and the next write replaces it', async () => {
    const dir = await tempDir();
    const store = createRoutingStore({ dataDir: dir });
    await fs.writeFile(path.join(dir, 'auto-sessions.json'), JSON.stringify({ version: 1, sessions: [{ sessionId: '' }] }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(store.readAutoSessions()).toEqual([]);
    expect(warn).toHaveBeenCalledWith('[routing] auto-sessions.json is unreadable:', expect.stringContaining('Invalid auto-sessions.json'));
    warn.mockRestore();
    store.writeAutoSessions([{ sessionId: 'ses_a', directory: null, at: 1 }]);
    expect(store.readAutoSessions()).toEqual([{ sessionId: 'ses_a', directory: null, at: 1 }]);
  });
});
