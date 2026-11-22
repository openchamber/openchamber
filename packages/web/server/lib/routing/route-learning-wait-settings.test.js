import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';

import { learnedChoices } from './route-learning.js';
import { cooldownHistory, estimateWait, ORDINARY_COOLDOWN_MS } from './route-wait.js';
import { createSettingsStore, DEFAULT_SETTINGS, normalizeSettings } from './route-settings.js';

const correction = (option) => ({ key: 'claude', option, accepted: 'corrected' });
const undo = (option) => ({ key: 'claude', option, accepted: false });

describe('learnedChoices', () => {
  it('learns an option once it leads by the threshold', () => {
    expect(learnedChoices([correction('A'), correction('A'), correction('A')], { learnAfter: 3 })).toEqual({ claude: 'A' });
  });

  it('does not learn from fewer corrections than the threshold', () => {
    expect(learnedChoices([correction('A'), correction('A')], { learnAfter: 3 })).toEqual({});
  });

  it('counts an undo against the option it came from', () => {
    const feedback = [correction('A'), correction('A'), correction('A'), undo('A'), undo('A')];
    expect(learnedChoices(feedback, { learnAfter: 3 })).toEqual({});
  });

  it('does not learn when two options are tied', () => {
    const feedback = [correction('A'), correction('B'), correction('A'), correction('B'), correction('A'), correction('B')];
    expect(learnedChoices(feedback, { learnAfter: 3 })).toEqual({});
  });
});

describe('estimateWait', () => {
  const now = new Date(2026, 9, 8, 9, 30).getTime();
  const minutes = (value) => value * 60_000;

  const rowsAt = (count, durationMs, { daysAgo = 7, hour = 9 } = {}) =>
    Array.from({ length: count }, (_, index) => {
      const start = new Date(2026, 9, 8 - daysAgo, hour, index).getTime();
      return { time: start, until: start + durationMs };
    });

  it('reports no estimate without samples', () => {
    expect(estimateWait([], { now })).toMatchObject({ active: null, expectedMs: null, basis: 'none', samples: 0 });
  });

  it('uses the weekday and hour when enough samples share them', () => {
    const estimate = estimateWait(rowsAt(6, minutes(5)), { now, percentile: 25, minSamples: 5 });
    expect(estimate).toMatchObject({ basis: 'weekday-hour', expectedMs: minutes(5), samples: 6 });
  });

  it('falls back to all samples when the hour has too few', () => {
    const rows = rowsAt(6, minutes(5), { hour: 20 });
    const estimate = estimateWait(rows, { now, percentile: 25, minSamples: 5 });
    expect(estimate.basis).toBe('all');
  });

  it('never estimates less than an ordinary cooldown', () => {
    const estimate = estimateWait(rowsAt(6, 10_000), { now, percentile: 25, minSamples: 5 });
    expect(estimate.expectedMs).toBe(ORDINARY_COOLDOWN_MS);
  });

  it('reports the cooldown that is still running', () => {
    const active = { time: now - minutes(1), until: now + minutes(4) };
    const estimate = estimateWait([active], { now, minSamples: 5 });
    expect(estimate.active).toEqual({ until: active.until, remainingMs: minutes(4) });
  });

  it('reads cooldown starts for one target from the history table', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-wait-'));
    const db = new DatabaseSync(path.join(dir, 'opencode.db'));
    db.exec(`create table route_health (id integer primary key, time integer not null, route_id text,
      provider_id text not null, model_id text not null, kind text not null, reason text, until integer)`);
    const insert = db.prepare(
      'insert into route_health (time, provider_id, model_id, kind, until) values (?, ?, ?, ?, ?)',
    );
    insert.run(now - minutes(10), 'anthropic', 'claude-opus-4-6', 'cooldown-start', now - minutes(5));
    insert.run(now - minutes(10), 'anthropic', 'claude-sonnet-4-5', 'cooldown-start', now - minutes(5));
    insert.run(now - minutes(10), 'anthropic', 'claude-opus-4-6', 'cooldown-end', null);
    const rows = cooldownHistory(db, { providerID: 'anthropic', modelID: 'claude-opus-4-6', now });
    db.close();
    expect(rows).toEqual([{ time: now - minutes(10), until: now - minutes(5) }]);
  });
});

describe('route settings', () => {
  it('keeps values inside their ranges', () => {
    expect(normalizeSettings({ learnAfter: 99, waitPercentile: 1, waitMinSamples: 0 })).toMatchObject({
      learnAfter: 20,
      waitPercentile: 5,
      waitMinSamples: 1,
    });
  });

  it('preserves a corrupt settings file instead of silently resetting to defaults', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-settings-'));
      const file = path.join(dir, 'route-settings.json');
      const corrupt = '{"learnAfter":7,"stages":{"keywords":fal';
      fs.writeFileSync(file, corrupt);
      const store = createSettingsStore({ file });
      expect(store.read()).toEqual(DEFAULT_SETTINGS);
      const preserved = fs.readdirSync(dir).filter((name) => name.startsWith('route-settings.json.corrupt-'));
      expect(preserved).toHaveLength(1);
      expect(fs.readFileSync(path.join(dir, preserved[0]), 'utf8')).toBe(corrupt);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(preserved[0]));
      const warned = warn.mock.calls.flat().map(String).join(' ');
      expect(warned).not.toContain('learnAfter');
    } finally {
      warn.mockRestore();
    }
  });

  it('preserves a corrupt settings file before a write overwrites it, and leaves no temp file', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-settings-'));
      const file = path.join(dir, 'route-settings.json');
      fs.writeFileSync(file, '{"learnAfter":7,"stages":{"keywords":fal');
      const store = createSettingsStore({ file });
      const saved = store.write({ learnAfter: 5 });
      expect(store.read()).toEqual(saved);
      const names = fs.readdirSync(dir);
      expect(names.filter((name) => name.startsWith('route-settings.json.corrupt-'))).toHaveLength(1);
      expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('preserves a settings file that parses but cannot be normalized before a write overwrites it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-settings-'));
      const file = path.join(dir, 'route-settings.json');
      fs.writeFileSync(file, 'null');
      const store = createSettingsStore({ file });
      const saved = store.write({ learnAfter: 5 });
      expect(store.read()).toEqual(saved);
      const preserved = fs.readdirSync(dir).filter((name) => name.startsWith('route-settings.json.corrupt-'));
      expect(preserved).toHaveLength(1);
      expect(fs.readFileSync(path.join(dir, preserved[0]), 'utf8')).toBe('null');
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses to overwrite an existing settings file it cannot read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-settings-'));
    const file = path.join(dir, 'route-settings.json');
    // A directory at the settings path makes the guard's read fail with
    // EISDIR: an existing file whose bytes can be neither parsed nor
    // preserved, so the write must refuse rather than rename over it.
    fs.mkdirSync(file);
    const store = createSettingsStore({ file });
    expect(() => store.write({ learnAfter: 5 })).toThrow(/Refusing to overwrite the unreadable route settings file/);
    expect(fs.statSync(file).isDirectory()).toBe(true);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('defaults a missing or unreadable file and round-trips a saved one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-settings-'));
    const store = createSettingsStore({ file: path.join(dir, 'route-settings.json') });
    expect(store.read()).toEqual(DEFAULT_SETTINGS);
    const saved = store.write({ stages: { local: false }, learnAfter: 5 });
    expect(saved.stages).toEqual({ keywords: true, local: false, external: true });
    expect(store.read()).toEqual(saved);
  });
});
