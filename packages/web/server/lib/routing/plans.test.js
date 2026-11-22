import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { addNote, emptyPlanStore, readNotes, readPlanStore, setModel, setPool, upsertPlan, writePlanStore } from './plans.js';

const NOW = '2026-10-14T09:00:00.000Z';
const isWindows = process.platform === 'win32';
const PLAN_STORE_MAX_BYTES = 8 * 1024 * 1024;
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plans-'));

describe('plan store', () => {
  it('creates a plan from its provider and name, then merges later updates into it', () => {
    const first = upsertPlan(emptyPlanStore(), { providerID: 'anthropic', plan: 'Max 20x' }, NOW);
    expect(first.plan).toMatchObject({ id: 'anthropic-max-20x', status: 'active', coverage: 'subscription', quotas: [] });
    const second = upsertPlan(
      first.store,
      { id: 'anthropic-max-20x', fee: { amount: 200, currency: 'USD', period: 'monthly' }, verifiedAt: '2026-10-14' },
      '2026-10-15T00:00:00.000Z',
    );
    expect(second.store.plans).toHaveLength(1);
    expect(second.plan).toMatchObject({
      plan: 'Max 20x',
      fee: { amount: 200 },
      verifiedAt: '2026-10-14',
      createdAt: NOW,
      updatedAt: '2026-10-15T00:00:00.000Z',
    });
  });

  it('clears a field set to null and keeps one that is left out', () => {
    const { store } = upsertPlan(emptyPlanStore(), { providerID: 'openai', plan: 'Plus', expiresOn: '2026-12-01' }, NOW);
    const next = upsertPlan(store, { id: 'openai-plus', expiresOn: null }, NOW);
    expect(next.plan.plan).toBe('Plus');
    expect(next.plan.expiresOn).toBeUndefined();
  });

  it('refuses a plan with no provider, a model with no tier, and an unknown enumeration', () => {
    expect(() => upsertPlan(emptyPlanStore(), { label: 'none' }, NOW)).toThrow('providerID');
    expect(() => setModel(emptyPlanStore(), 'openai/gpt-6-astra', {}, NOW)).toThrow('needs a tier');
    expect(() => upsertPlan(emptyPlanStore(), { providerID: 'openai', coverage: 'lottery' }, NOW)).toThrow();
  });

  it('stores a model tier and a pool purpose beside the plans', () => {
    const withModel = setModel(emptyPlanStore(), 'openai/gpt-6-astra', { tier: 'frontier', coveredBy: ['openai-plus'] }, NOW);
    const withPool = setPool(withModel, 'hard', { tier: 'frontier', purpose: 'debugging with an unknown cause' }, NOW);
    expect(withPool.models['openai/gpt-6-astra']).toMatchObject({ tier: 'frontier', coveredBy: ['openai-plus'] });
    expect(withPool.pools.hard).toMatchObject({ tier: 'frontier', purpose: 'debugging with an unknown cause' });
  });

  it('writes atomically and reads back what it wrote', () => {
    const root = dir();
    const { store } = upsertPlan(emptyPlanStore(), { providerID: 'anthropic', plan: 'Max 20x' }, NOW);
    writePlanStore(store, root);
    expect(fs.readdirSync(root).filter((file) => file.endsWith('.tmp'))).toEqual([]);
    expect(readPlanStore(root).plans.map((plan) => plan.id)).toEqual(['anthropic-max-20x']);
  });

  it('keeps a missing store empty and accepts a valid file at the byte cap only', () => {
    const root = dir();
    expect(readPlanStore(root)).toEqual(emptyPlanStore());

    const plan = {
      id: 'openai-free',
      providerID: 'openai',
      label: '',
      coverage: 'free',
      quotas: [],
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    };
    const base = JSON.stringify({ version: 1, plans: [plan], models: {}, pools: {} });
    const label = 'x'.repeat(PLAN_STORE_MAX_BYTES - Buffer.byteLength(base));
    const text = JSON.stringify({ version: 1, plans: [{ ...plan, label }], models: {}, pools: {} });
    const file = path.join(root, 'plans.json');
    expect(Buffer.byteLength(text)).toBe(PLAN_STORE_MAX_BYTES);
    fs.writeFileSync(file, text);
    expect(readPlanStore(root).plans[0].label).toHaveLength(label.length);

    fs.appendFileSync(file, ' ');
    expect(() => readPlanStore(root)).toThrow(
      expect.objectContaining({ status: 409, code: 'PLAN_STORE_MALFORMED' }),
    );
  });

  it('treats a malformed plan file as an error, never as an empty store', () => {
    const root = dir();
    fs.writeFileSync(path.join(root, 'plans.json'), '{ not json');
    expect(() => readPlanStore(root)).toThrow(
      expect.objectContaining({ status: 409, code: 'PLAN_STORE_MALFORMED' }),
    );
    fs.writeFileSync(path.join(root, 'plans.json'), JSON.stringify({ version: 2, plans: [] }));
    expect(() => readPlanStore(root)).toThrow(
      expect.objectContaining({ status: 409, code: 'PLAN_STORE_MALFORMED', message: expect.stringContaining('plan store format') }),
    );
  });

  it.skipIf(isWindows)('reports an unreadable plan store as unreadable, not as malformed JSON', () => {
    const root = dir();
    const file = path.join(root, 'plans.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, plans: [], models: {}, pools: {} }));
    fs.chmodSync(file, 0o000);
    try {
      expect(() => readPlanStore(root)).toThrow(
        expect.objectContaining({
          status: 409,
          code: 'PLAN_STORE_UNREADABLE',
          message: expect.stringContaining('unreadable: EACCES'),
        }),
      );
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });

  it.skipIf(isWindows)('refuses a FIFO plan store without blocking', () => {
    const root = dir();
    execFileSync('mkfifo', [path.join(root, 'plans.json')]);

    expect(() => readPlanStore(root)).toThrow(
      expect.objectContaining({ status: 409, code: 'PLAN_STORE_MALFORMED' }),
    );
  });

  it('keeps notes in order, filters them, and skips a damaged line while counting it', () => {
    const root = dir();
    addNote({ text: 'ran out of claude too fast', kind: 'experience', providerID: 'anthropic' }, '2026-10-10T10:00:00.000Z', root);
    addNote({ text: 'I always have GPT left at month end', kind: 'expectation', providerID: 'openai' }, '2026-10-11T10:00:00.000Z', root);
    fs.appendFileSync(path.join(root, 'plan-notes.jsonl'), 'not a note\n');
    const all = readNotes({}, root);
    expect(all.notes.map((note) => note.text)).toEqual([
      'ran out of claude too fast',
      'I always have GPT left at month end',
    ]);
    expect(all.skipped).toBe(1);
    expect(readNotes({ providerID: 'anthropic' }, root).notes).toHaveLength(1);
    expect(readNotes({ limit: 1 }, root).notes[0]?.kind).toBe('expectation');
  });

  it('keeps a missing notes file as an empty result', () => {
    expect(readNotes({}, dir())).toEqual({ notes: [], skipped: 0 });
  });

  it('refuses an over-cap notes file with a coded 413', () => {
    const root = dir();
    const note = { id: 'note_big', at: NOW, kind: 'other', text: 'x'.repeat(8 * 1024 * 1024), source: 'ui' };
    fs.writeFileSync(path.join(root, 'plan-notes.jsonl'), `${JSON.stringify(note)}\n`);

    expect(() => readNotes({ limit: 20 }, root)).toThrow(
      expect.objectContaining({ status: 413, code: 'PLAN_NOTES_TOO_LARGE' }),
    );
  });

  it.skipIf(isWindows)('refuses a FIFO notes file without blocking', () => {
    const root = dir();
    const file = path.join(root, 'plan-notes.jsonl');
    execFileSync('mkfifo', [file]);

    expect(() => readNotes({}, root)).toThrow(
      expect.objectContaining({ status: 409, code: 'PLAN_NOTES_NOT_REGULAR' }),
    );
  });

  it('refuses a blank note', () => {
    expect(() => addNote({ text: '   ' }, NOW, dir())).toThrow('some text');
  });
});
