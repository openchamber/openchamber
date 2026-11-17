import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createModelChoiceActions } from '../openchamber-control/model-choice-actions.js';
import { OPENCHAMBER_AGENT_TOOL_ACTIONS } from '../openchamber-control/actions.js';
import { buildModelChoiceNotes, buildModelChoiceSuggestions, goalWriterSuggestionId } from './notes.js';
import { registerModelChoiceRoutes } from './routes.js';
import { createModelChoiceService } from './service.js';
import { createModelChoiceStore, MAX_MODEL_CHOICE_DECISIONS, MAX_MODEL_CHOICE_EVENTS, MODEL_CHOICES_MAX_BYTES, MODEL_CHOICE_RETENTION_MS } from './store.js';

const DAY = 24 * 60 * 60 * 1000;

const choice = (overrides = {}) => ({
  surface: 'goal-writer',
  kind: 'effort',
  chosen: { model: 'anthropic/claude-opus', variant: 'low' },
  replaced: { model: 'anthropic/claude-opus', variant: 'high' },
  sessionModel: 'anthropic/claude-sonnet',
  inputSize: 'long',
  ...overrides,
});

const stamped = (overrides = {}, at = 1) => ({ ...choice(overrides), at });

let dataDir;
let clock;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-choices-'));
  clock = 1_000 * DAY;
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

const makeStore = () => createModelChoiceStore({ dataDir, now: () => clock });

const makeService = (settings = {}) => {
  const current = { ...settings };
  const persistSettings = vi.fn(async (changes) => Object.assign(current, changes));
  const service = createModelChoiceService({
    store: makeStore(),
    readSettings: async () => current,
    persistSettings,
  });
  return { service, persistSettings, current };
};

describe('model choice store', () => {
  it('keeps the fields of a choice and nothing else, with the time it was made', async () => {
    const store = makeStore();
    await store.record({ ...choice(), message: 'secret prompt text' });
    const { events } = await store.snapshot();
    expect(events).toEqual([stamped({}, clock)]);
    expect(await fs.readFile(store.filePath, 'utf8')).not.toContain('secret prompt text');
  });

  it('refuses a choice with an unknown surface or a model without a provider', async () => {
    const store = makeStore();
    await expect(store.record(choice({ surface: 'elsewhere' }))).rejects.toMatchObject({ statusCode: 400 });
    await expect(store.record(choice({ chosen: { model: 'opus', variant: null } }))).rejects.toMatchObject({ statusCode: 400 });
    await expect(fs.access(store.filePath)).rejects.toThrow();
  });

  it('keeps the newest 5,000 choices from the last 90 days', async () => {
    const store = makeStore();
    const old = stamped({}, clock - MODEL_CHOICE_RETENTION_MS - 1);
    const recent = Array.from({ length: MAX_MODEL_CHOICE_EVENTS }, (_, index) => stamped({ sessionModel: `p/m${index}` }, clock - 1));
    await fs.writeFile(store.filePath, JSON.stringify({ version: 1, events: [old, ...recent], decisions: [] }));
    await store.record(choice({ sessionModel: 'p/newest' }));
    const { events } = await store.snapshot();
    expect(events).toHaveLength(MAX_MODEL_CHOICE_EVENTS);
    expect(events.at(-1).sessionModel).toBe('p/newest');
    expect(events[0].sessionModel).toBe('p/m1');
  });

  it('drops choices older than 90 days when it reads', async () => {
    const store = makeStore();
    await fs.writeFile(store.filePath, JSON.stringify({ version: 1, events: [stamped({}, clock - MODEL_CHOICE_RETENTION_MS - 1), stamped({}, clock - DAY)], decisions: [] }));
    expect((await store.snapshot()).events).toHaveLength(1);
  });

  it('reports a malformed file as an error and leaves it in place', async () => {
    const store = makeStore();
    await fs.writeFile(store.filePath, '{"version":1,"events":"nope"}');
    await expect(store.snapshot()).rejects.toMatchObject({ statusCode: 500 });
    await expect(store.record(choice())).rejects.toMatchObject({ statusCode: 500 });
    expect(await fs.readFile(store.filePath, 'utf8')).toBe('{"version":1,"events":"nope"}');
  });

  it('records two choices made at the same moment', async () => {
    const store = makeStore();
    await Promise.all([store.record(choice()), store.record(choice({ kind: 'model' }))]);
    expect((await store.snapshot()).events).toHaveLength(2);
  });

  it('refuses an over-cap file through the error path and leaves it in place (#1610)', async () => {
    const store = makeStore();
    await fs.writeFile(store.filePath, '{"version":1,"events":[],"decisions":[]}');
    await fs.truncate(store.filePath, MODEL_CHOICES_MAX_BYTES + 1);
    await expect(store.snapshot()).rejects.toMatchObject({ statusCode: 500 });
    await expect(store.record(choice())).rejects.toMatchObject({ statusCode: 500 });
    expect((await fs.stat(store.filePath)).size).toBe(MODEL_CHOICES_MAX_BYTES + 1);
  });

  it('reads a file at exactly the read cap unchanged (#1610)', async () => {
    const store = makeStore();
    const data = { version: 1, events: [stamped({}, clock)], decisions: [{ id: 'd-cap', decision: 'approved', at: clock }] };
    const text = JSON.stringify(data);
    await fs.writeFile(store.filePath, text + ' '.repeat(MODEL_CHOICES_MAX_BYTES - text.length));
    expect(await store.snapshot()).toEqual({ events: data.events, decisions: data.decisions });
  });

  it('refuses a FIFO at the store path promptly and still serves the next operation (#1610)', async () => {
    const store = makeStore();
    execFileSync('mkfifo', [store.filePath]);
    const settled = await Promise.race([
      store.snapshot().then(() => 'resolved', (error) => error),
      new Promise((resolve) => { setTimeout(() => resolve('did-not-settle'), 2_000); }),
    ]);
    expect(settled).toMatchObject({ statusCode: 500 });
    await fs.rm(store.filePath, { force: true });
    await expect(store.snapshot()).resolves.toEqual({ events: [], decisions: [] });
  });

  it('refuses a directory at the store path through the error path (#1610)', async () => {
    const store = makeStore();
    await fs.mkdir(store.filePath);
    await expect(store.snapshot()).rejects.toMatchObject({ statusCode: 500 });
  });

  it('keeps at most the newest 5,000 decisions (#1610)', async () => {
    const store = makeStore();
    const planted = Array.from({ length: MAX_MODEL_CHOICE_DECISIONS + 10 }, (_, index) => ({ id: `d-${index}`, decision: 'declined', at: clock }));
    await fs.writeFile(store.filePath, JSON.stringify({ version: 1, events: [], decisions: planted }));
    await store.decide('d-newest', 'approved');
    const { decisions } = await store.snapshot();
    expect(decisions).toHaveLength(MAX_MODEL_CHOICE_DECISIONS);
    expect(decisions[0].id).toBe('d-11');
    expect(decisions.at(-1)).toEqual({ id: 'd-newest', decision: 'approved', at: clock });
  });

  it('clears every choice and decision', async () => {
    const store = makeStore();
    await store.record(choice());
    await store.decide('goal-writer:a/b:default', 'declined');
    await store.clear();
    expect(await store.snapshot()).toEqual({ events: [], decisions: [] });
  });
});

describe('model choice notes', () => {
  it('summarizes repeated choices per surface, largest first', () => {
    const events = [
      ...Array.from({ length: 7 }, () => stamped()),
      stamped({ chosen: { model: 'openai/gpt-5', variant: null } }),
      stamped({ chosen: { model: 'openai/gpt-5', variant: null } }),
      stamped({ surface: 'composer', chosen: { model: 'opencode-route/cheap-fast', variant: null }, replaced: null, inputSize: 'unknown' }),
      stamped({ surface: 'composer', chosen: { model: 'opencode-route/cheap-fast', variant: null }, replaced: null, inputSize: 'unknown' }),
    ];
    expect(buildModelChoiceNotes(events).map((note) => note.text)).toEqual([
      'picks low effort on claude-opus for goal specs (7 of 9 times), usually over high effort on claude-opus, mostly for long inputs',
      'picks default effort on gpt-5 for goal specs (2 of 9 times), usually over high effort on claude-opus, mostly for long inputs',
      'picks default effort on pool cheap-fast for chat messages (2 of 2 times)',
    ]);
  });

  it('leaves out a choice made once', () => {
    expect(buildModelChoiceNotes([stamped()])).toEqual([]);
  });
});

describe('model choice suggestions', () => {
  const habit = (count, overrides) => Array.from({ length: count }, () => stamped(overrides));

  it('suggests the goal writer default when recent goal choices show a clear habit', () => {
    const [suggestion] = buildModelChoiceSuggestions({ events: [...habit(5), stamped({ chosen: { model: 'x/y', variant: null } })], decisions: [], settings: {} });
    expect(suggestion).toMatchObject({
      id: goalWriterSuggestionId({ model: 'anthropic/claude-opus', variant: 'low' }),
      count: 5,
      total: 6,
      settings: { sessionGoalWriterModel: 'anthropic/claude-opus', sessionGoalWriterVariant: 'low' },
    });
  });

  it('suggests nothing below five matching choices or below 70 percent of them', () => {
    expect(buildModelChoiceSuggestions({ events: habit(4), decisions: [], settings: {} })).toEqual([]);
    const mixed = [...habit(5), ...habit(3, { chosen: { model: 'x/y', variant: null } })];
    expect(buildModelChoiceSuggestions({ events: mixed, decisions: [], settings: {} })).toEqual([]);
  });

  it('suggests nothing when the setting already says so, or the user answered it', () => {
    const settings = { sessionGoalWriterModel: 'anthropic/claude-opus', sessionGoalWriterVariant: 'low' };
    expect(buildModelChoiceSuggestions({ events: habit(6), decisions: [], settings })).toEqual([]);
    const decisions = [{ id: goalWriterSuggestionId({ model: 'anthropic/claude-opus', variant: 'low' }), decision: 'declined', at: 1 }];
    expect(buildModelChoiceSuggestions({ events: habit(6), decisions, settings: {} })).toEqual([]);
  });

  it('gives null and a literal default variant different suggestion ids (#2095)', () => {
    const forNull = goalWriterSuggestionId({ model: 'p/m', variant: null });
    const forDefault = goalWriterSuggestionId({ model: 'p/m', variant: 'default' });
    expect(forNull).not.toBe(forDefault);
    expect(forNull).toMatch(/^goal-writer:v2:[0-9a-f]{64}$/);
    expect(forDefault).toMatch(/^goal-writer:v2:[0-9a-f]{64}$/);
  });

  it('does not let a decision for null suppress the literal default suggestion, or the reverse (#2095)', () => {
    const nullHabit = habit(6, { chosen: { model: 'p/m', variant: null } });
    const defaultHabit = habit(6, { chosen: { model: 'p/m', variant: 'default' } });
    const decidedNull = [{ id: goalWriterSuggestionId({ model: 'p/m', variant: null }), decision: 'declined', at: 1 }];
    const decidedDefault = [{ id: goalWriterSuggestionId({ model: 'p/m', variant: 'default' }), decision: 'declined', at: 1 }];
    expect(buildModelChoiceSuggestions({ events: defaultHabit, decisions: decidedNull, settings: {} })).toHaveLength(1);
    expect(buildModelChoiceSuggestions({ events: nullHabit, decisions: decidedDefault, settings: {} })).toHaveLength(1);
    expect(buildModelChoiceSuggestions({ events: nullHabit, decisions: decidedNull, settings: {} })).toEqual([]);
    expect(buildModelChoiceSuggestions({ events: defaultHabit, decisions: decidedDefault, settings: {} })).toEqual([]);
  });

  it('keeps delimiter-shifted selections distinct in ids and in note grouping (#2095)', () => {
    expect(goalWriterSuggestionId({ model: 'p/m|x', variant: 'y' }))
      .not.toBe(goalWriterSuggestionId({ model: 'p/m', variant: 'x|y' }));
    expect(goalWriterSuggestionId({ model: 'p/m', variant: 'a:b' }))
      .not.toBe(goalWriterSuggestionId({ model: 'p/m:a', variant: 'b' }));
    const events = [
      ...habit(2, { chosen: { model: 'p/a|b', variant: 'c' }, replaced: null }),
      ...habit(2, { chosen: { model: 'p/a', variant: 'b|c' }, replaced: null }),
    ];
    expect(buildModelChoiceNotes(events)).toHaveLength(2);
  });

  it('never suppresses a suggestion for a legacy pre-v2 decision id (#2095)', () => {
    const legacy = [{ id: 'goal-writer:p/m:default', decision: 'declined', at: 1 }];
    expect(buildModelChoiceSuggestions({ events: habit(6, { chosen: { model: 'p/m', variant: null } }), decisions: legacy, settings: {} })).toHaveLength(1);
    expect(buildModelChoiceSuggestions({ events: habit(6, { chosen: { model: 'p/m', variant: 'default' } }), decisions: legacy, settings: {} })).toHaveLength(1);
  });

  it('keeps ids fixed-size for maximum-length models and variants (#2095)', () => {
    const model = `p/${'m'.repeat(298)}`;
    const id = goalWriterSuggestionId({ model, variant: 'v'.repeat(64) });
    expect(id.length).toBeLessThanOrEqual(400);
    expect(id).not.toBe(goalWriterSuggestionId({ model: `${model}x`, variant: 'v'.repeat(64) }));
  });

  it('reads only goal writer choices', () => {
    expect(buildModelChoiceSuggestions({ events: habit(6, { surface: 'composer' }), decisions: [], settings: {} })).toEqual([]);
  });
});

describe('model choice service', () => {
  it('records nothing while recording is off, and records by default', async () => {
    const off = makeService({ modelChoiceRecordingEnabled: false });
    await expect(off.service.record(choice())).resolves.toEqual({ recorded: false });
    expect((await off.service.summary()).total).toBe(0);

    const on = makeService({});
    await expect(on.service.record(choice())).resolves.toEqual({ recorded: true });
    expect((await on.service.summary()).total).toBe(1);
  });

  it('offers no suggestion while recording is off', async () => {
    const { service, current } = makeService({});
    for (let index = 0; index < 5; index += 1) await service.record(choice());
    expect((await service.summary()).suggestions).toHaveLength(1);
    current.modelChoiceRecordingEnabled = false;
    expect((await service.summary()).suggestions).toEqual([]);
  });

  it('applies an approved suggestion and never offers it again', async () => {
    const { service, persistSettings } = makeService({});
    for (let index = 0; index < 5; index += 1) await service.record(choice());
    const [suggestion] = (await service.summary()).suggestions;
    await expect(service.decide(suggestion.id, 'approved')).resolves.toMatchObject({ settings: suggestion.settings });
    expect(persistSettings).toHaveBeenCalledWith(suggestion.settings);
    expect((await service.summary()).suggestions).toEqual([]);
  });

  it('records a decline without changing settings, and the suggestion stays gone', async () => {
    const { service, persistSettings } = makeService({});
    for (let index = 0; index < 5; index += 1) await service.record(choice());
    const [suggestion] = (await service.summary()).suggestions;
    await service.decide(suggestion.id, 'declined');
    expect(persistSettings).not.toHaveBeenCalled();
    for (let index = 0; index < 5; index += 1) await service.record(choice());
    expect((await service.summary()).suggestions).toEqual([]);
  });

  it('keeps a suggestion on offer when applying it fails', async () => {
    const { service, persistSettings } = makeService({});
    persistSettings.mockRejectedValueOnce(new Error('disk full'));
    for (let index = 0; index < 5; index += 1) await service.record(choice());
    const [suggestion] = (await service.summary()).suggestions;
    await expect(service.decide(suggestion.id, 'approved')).rejects.toThrow('disk full');
    expect((await service.summary()).suggestions).toHaveLength(1);
  });

  it('refuses to answer a suggestion that is not on offer', async () => {
    const { service, persistSettings } = makeService({});
    await expect(service.decide('goal-writer:a/b:default', 'approved')).rejects.toMatchObject({ statusCode: 404 });
    expect(persistSettings).not.toHaveBeenCalled();
  });

  it('preserves legacy decision ids untouched and still offers the suggestion once (#2095)', async () => {
    const { service } = makeService({});
    const store = makeStore();
    await store.decide('goal-writer:p/m:default', 'declined');
    for (let index = 0; index < 5; index += 1) await service.record(choice({ chosen: { model: 'p/m', variant: null } }));
    const [suggestion] = (await service.summary()).suggestions;
    expect(suggestion.id).toMatch(/^goal-writer:v2:[0-9a-f]{64}$/);
    await service.decide(suggestion.id, 'declined');
    expect((await service.summary()).suggestions).toEqual([]);
    const { decisions } = await store.snapshot();
    expect(decisions.map((entry) => entry.id)).toEqual(['goal-writer:p/m:default', suggestion.id]);
  });

  it('returns the newest events first, up to the limit', async () => {
    const { service } = makeService({});
    await service.record(choice({ sessionModel: 'p/first' }));
    await service.record(choice({ sessionModel: 'p/second' }));
    const summary = await service.summary({ limit: 1 });
    expect(summary.events.map((event) => event.sessionModel)).toEqual(['p/second']);
  });

  // Settings asks for limit=0: the count and notes, no events.
  it('returns no events for a limit of 0, and the default for a missing limit', async () => {
    const { service } = makeService({});
    await service.record(choice({}));
    const none = await service.summary({ limit: 0 });
    expect(none.events).toEqual([]);
    expect(none.total).toBe(1);
    expect((await service.summary({ limit: undefined })).events).toHaveLength(1);
  });
});

describe('model choice routes', () => {
  const createApp = (service) => {
    const app = express();
    registerModelChoiceRoutes(app, { modelChoiceService: service });
    return app;
  };

  it('records, reads, answers and clears over HTTP', async () => {
    const { service } = makeService({});
    const app = createApp(service);
    for (let index = 0; index < 5; index += 1) {
      await request(app).post('/api/openchamber/model-choices').send(choice()).expect(200, { recorded: true });
    }
    const read = await request(app).get('/api/openchamber/model-choices?limit=2').expect(200);
    expect(read.body).toMatchObject({ enabled: true, total: 5 });
    expect(read.body.events).toHaveLength(2);
    expect(read.body.notes[0].text).toContain('low effort on claude-opus');

    await request(app).post('/api/openchamber/model-choices/decision')
      .send({ id: read.body.suggestions[0].id, decision: 'declined' })
      .expect(200);
    await request(app).post('/api/openchamber/model-choices/decision')
      .send({ id: read.body.suggestions[0].id, decision: 'declined' })
      .expect(404);

    await request(app).delete('/api/openchamber/model-choices').expect(204);
    expect((await request(app).get('/api/openchamber/model-choices').expect(200)).body.total).toBe(0);
  });

  it('judges the limit strictly, so malformed spellings fall back to the service default', async () => {
    const { service } = makeService({});
    const app = createApp(service);
    for (let index = 0; index < 60; index += 1) {
      await request(app).post('/api/openchamber/model-choices').send(choice()).expect(200, { recorded: true });
    }
    // 60 events separate the answers: the default shows 50, a reinterpreted
    // '1e3' would clamp to 500 and show all 60, '' / '-5' would show none.
    const cases = [['1e3', 50], ['0x10', 50], ['2.0', 50], ['', 50], ['-5', 50], ['0', 0], ['2', 2]];
    for (const [limit, expected] of cases) {
      const read = await request(app).get(`/api/openchamber/model-choices?limit=${limit}`).expect(200);
      expect(read.body.events).toHaveLength(expected);
    }
    const missing = await request(app).get('/api/openchamber/model-choices').expect(200);
    expect(missing.body.events).toHaveLength(50);
  });

  it('answers 400 for an invalid choice or decision', async () => {
    const app = createApp(makeService({}).service);
    await request(app).post('/api/openchamber/model-choices').send({ surface: 'composer' }).expect(400);
    await request(app).post('/api/openchamber/model-choices/decision').send({ id: 'x', decision: 'maybe' }).expect(400);
  });
});

describe('models.choices agent action', () => {
  it('is offered to agents and returns notes and recent events only', async () => {
    expect(OPENCHAMBER_AGENT_TOOL_ACTIONS).toContain('models.choices');
    const { service } = makeService({});
    await service.record(choice());
    await service.record(choice());
    const actions = createModelChoiceActions({ modelChoiceService: service });
    const result = await actions.execute('models.choices', { limit: 1 });
    expect(Object.keys(result).sort()).toEqual(['enabled', 'events', 'notes', 'total']);
    expect(result).toMatchObject({ enabled: true, total: 2 });
    expect(result.events).toHaveLength(1);
    expect(result.notes[0].text).toBe('picks low effort on claude-opus for goal specs (2 of 2 times), usually over high effort on claude-opus, mostly for long inputs');
  });
});
