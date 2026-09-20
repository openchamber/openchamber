import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRoutingStore, parseEffectiveConfig, resolveEffectiveConfig, toStoredConfig } from './store.js';
import { BUILTIN_CATEGORIES } from './defaults.js';

const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'routing-store-'));

const sampleConfig = (patch = {}) => ({
  enabled: true,
  fallback: { model: { providerID: 'anthropic', modelID: 'claude-sonnet-5' }, variant: 'medium' },
  minConfidence: 0.6,
  safetyNet: { enabled: true, threshold: 0.6 },
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

  it('stores only deviations from the built-ins and round-trips them', async () => {
    const dir = await tempDir();
    const store = createRoutingStore({ dataDir: dir });
    const config = sampleConfig();
    config.categories[0] = { ...config.categories[0], enabled: false };
    config.categories[3] = { ...config.categories[3], model: { providerID: 'openai', modelID: 'gpt-6-astra' }, variant: 'high', agent: 'plan' };
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

  it('records a removed built-in as deleted and keeps the others', async () => {
    const config = sampleConfig();
    config.categories = config.categories.filter((c) => c.id !== 'research');
    const stored = toStoredConfig(config);
    expect(stored.categories.research).toEqual({ builtin: true, deleted: true });
    const resolved = resolveEffectiveConfig(stored);
    expect(resolved.categories.map((c) => c.id)).toEqual(['trivial', 'implement', 'hard']);
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
});
