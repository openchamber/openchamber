import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { registerRouteRulesRoutes } from './route-rules-routes.js';
import { createOverrideStore } from './route-overrides-store.js';
import { createSettingsStore } from './route-settings.js';
import { LOCAL_MODEL } from './route-local-model.js';

const endpoint = { url: 'https://jev.test/answer', model: 'jev', headers: {} };
const sha256Of = (content) => crypto.createHash('sha256').update(content).digest('hex');

const setup = ({ jevAnswers = {}, localAnswers, modelInstalled = false, dbPath, model, fetchImpl } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-rules-'));
  const modelFile = path.join(dir, LOCAL_MODEL.file);
  if (modelInstalled) {
    fs.writeFileSync(modelFile, '');
    fs.truncateSync(modelFile, LOCAL_MODEL.bytes);
  }
  const jev = {
    ask: vi.fn(async () => ({
      answers: jevAnswers,
      ms: 1,
    })),
  };
  const answerer = {
    answer: vi.fn(async () => localAnswers ?? { action: 'none', provider: 'none', family: 'none', duration: 'none' }),
  };
  const store = createOverrideStore({ dataDir: dir });
  const settings = createSettingsStore({ file: path.join(dir, 'settings.json') });
  const app = express();
  registerRouteRulesRoutes(app, {
    routingRuntime: { classifierEndpoint: async () => endpoint },
    jev,
    store,
    settings,
    answerer,
    modelFile,
    dbPath: dbPath ?? path.join(dir, 'missing.db'),
    model,
    fetchImpl: fetchImpl ?? vi.fn(async () => new Response(null, { status: 503 })),
  });
  return { app, dir, jev, answerer, store };
};

const context = {
  providers: ['anthropic', 'openai', 'google'],
  models: [{ id: 'claude-opus-4-6', providerID: 'anthropic' }, { id: 'gpt-5', providerID: 'openai' }],
};

describe('interpret', () => {
  it('applies a certain keyword answer without asking a smart stage', async () => {
    const { app, jev, store } = setup();
    const response = await request(app)
      .post('/api/model-routes/interpret')
      .send({ text: 'stop using anthropic for the rest of the day', context });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'applied', confidence: 'certain' });
    expect(response.body.rules).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({ action: 'avoid', providers: ['anthropic'], source: 'interpreter' });
    expect(jev.ask).not.toHaveBeenCalled();
  });

  it('asks one question for an ambiguous sentence and applies the answer', async () => {
    const { app, store } = setup();
    const asked = await request(app)
      .post('/api/model-routes/interpret')
      .send({ text: "don't use claude anymore today", context });
    expect(asked.body).toMatchObject({ status: 'clarify', key: 'claude' });
    expect(asked.body.options).toHaveLength(2);
    expect(store.list()).toHaveLength(0);

    const answered = await request(app)
      .post('/api/model-routes/interpret/answer')
      .send({
        text: "don't use claude anymore today",
        context,
        key: 'claude',
        label: 'Anthropic provider only',
      });
    expect(answered.body).toMatchObject({ status: 'applied' });
    expect(store.list()[0]).toMatchObject({ providers: ['anthropic'], origin: { key: 'claude' } });
    expect(store.readFeedback()[0]).toMatchObject({ key: 'claude', option: 'Anthropic provider only', accepted: 'corrected' });
  });

  it('rejects an answer whose question no longer applies', async () => {
    const { app } = setup();
    const response = await request(app)
      .post('/api/model-routes/interpret/answer')
      .send({ text: 'stop using anthropic for the rest of the day', context, key: 'claude', label: 'x' });
    expect(response.status).toBe(400);
  });

  it('asks the external classifier when the keywords cannot read the sentence', async () => {
    const { app, jev, store } = setup({
      jevAnswers: {
        action: { choice: 'prefer', confidence: 0.9 },
        provider: { choice: 'anthropic', confidence: 0.9 },
        family: { choice: 'none', confidence: 0.9 },
        duration: { choice: 'none', confidence: 0.9 },
      },
    });
    const response = await request(app)
      .post('/api/model-routes/interpret')
      .send({ text: 'lean on claude for now', context });
    expect(jev.ask).toHaveBeenCalledWith(expect.objectContaining({ questions: expect.any(Object) }), endpoint);
    expect(response.body).toMatchObject({ status: 'applied', confidence: 'tentative' });
    expect(store.list()[0]).toMatchObject({ action: 'prefer', providers: ['anthropic'] });
  });

  it('uses the local model when it is installed and the keywords cannot read the sentence', async () => {
    const { app, answerer, jev, store } = setup({
      modelInstalled: true,
      localAnswers: { action: 'prefer', provider: 'google', family: 'none', duration: 'hour' },
    });
    const response = await request(app)
      .post('/api/model-routes/interpret')
      .send({ text: 'lean on gemini for now', context });
    expect(answerer.answer).toHaveBeenCalledTimes(1);
    expect(jev.ask).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({ status: 'applied', stage: 'smart' });
    expect(store.list()[0]).toMatchObject({ providers: ['google'], action: 'prefer' });
  });

  it('does not change anything for a sentence no stage can read', async () => {
    const { app, store } = setup();
    const response = await request(app)
      .post('/api/model-routes/interpret')
      .send({ text: 'make the sidebar nicer', context });
    expect(response.body).toMatchObject({ status: 'unknown' });
    expect(store.list()).toHaveLength(0);
  });

  it('refuses a body without text or context', async () => {
    const { app } = setup();
    const response = await request(app).post('/api/model-routes/interpret').send({ context });
    expect(response.status).toBe(400);
  });
});

describe('undo', () => {
  it('removes the whole interpretation and records the undo against its choice', async () => {
    const { app, store } = setup();
    await request(app)
      .post('/api/model-routes/interpret/answer')
      .send({ text: "don't use claude anymore today", context, key: 'claude', label: 'Anthropic provider only' });
    const [rule] = store.list();
    const response = await request(app).delete(`/api/model-routes/rules/${encodeURIComponent(rule.id)}`);
    expect(response.status).toBe(200);
    expect(response.body.rules).toHaveLength(0);
    expect(store.readFeedback().at(-1)).toMatchObject({ key: 'claude', option: 'Anthropic provider only', accepted: false });
  });

  it('returns 404 for a rule that does not exist', async () => {
    const { app } = setup();
    const response = await request(app).delete('/api/model-routes/rules/nope');
    expect(response.status).toBe(404);
  });
});

describe('settings', () => {
  it('returns defaults and stores clamped values', async () => {
    const { app } = setup();
    const defaults = await request(app).get('/api/model-routes/settings');
    expect(defaults.body).toMatchObject({ learnAfter: 3, waitPercentile: 25, waitMinSamples: 5 });
    const saved = await request(app).put('/api/model-routes/settings').send({ learnAfter: 99, stages: { local: false } });
    expect(saved.body).toMatchObject({ learnAfter: 20, stages: { keywords: true, local: false, external: true } });
  });
});

describe('wait', () => {
  it('estimates from the cooldown history when OpenCode has recorded it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-rules-db-'));
    const dbPath = path.join(dir, 'opencode.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`create table route_health (id integer primary key, time integer not null, route_id text,
      provider_id text not null, model_id text not null, kind text not null, reason text, until integer);
      create table route_attempt (id integer primary key);`);
    const now = Date.now();
    db.prepare('insert into route_health (time, provider_id, model_id, kind, until) values (?, ?, ?, ?, ?)').run(
      now - 60_000,
      'anthropic',
      'claude-opus-4-6',
      'cooldown-start',
      now + 120_000,
    );
    db.close();
    const { app } = setup({ dbPath });
    const response = await request(app).get('/api/model-routes/wait?provider=anthropic&model=claude-opus-4-6');
    expect(response.status).toBe(200);
    expect(response.body.active).toMatchObject({ until: expect.any(Number) });
  });

  it('says there is no history when OpenCode has no routing database', async () => {
    const { app } = setup();
    const response = await request(app).get('/api/model-routes/wait?provider=anthropic&model=claude-opus-4-6');
    expect(response.body).toMatchObject({ expectedMs: null, reason: 'no-database' });
  });

  it('needs both the provider and the model', async () => {
    const { app } = setup();
    const response = await request(app).get('/api/model-routes/wait?provider=anthropic');
    expect(response.status).toBe(400);
  });
});

describe('local model', () => {
  it('reports the model as missing until it is downloaded', async () => {
    const { app } = setup();
    const response = await request(app).get('/api/model-routes/local');
    expect(response.body).toMatchObject({ id: LOCAL_MODEL.id, installed: false, bytes: LOCAL_MODEL.bytes });
  });

  it('reports a finished download when the file is in place', async () => {
    const { app } = setup({ modelInstalled: true });
    const response = await request(app).get('/api/model-routes/local');
    expect(response.body.installed).toBe(true);
  });

  it('refuses a download with no pinned checksum, says why, and fetches nothing', async () => {
    const fetchImpl = vi.fn();
    const { app, dir } = setup({ model: { ...LOCAL_MODEL, sha256: null }, fetchImpl });
    const response = await request(app).post('/api/model-routes/local/download');
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/No checksum is pinned/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, LOCAL_MODEL.file))).toBe(false);
    expect((await request(app).get('/api/model-routes/local')).body).toMatchObject({ downloading: false, installed: false, error: null });
  });

  it('downloads a model whose digest matches, then reports it installed', async () => {
    const content = Buffer.from('a stand-in for the model file');
    const model = { ...LOCAL_MODEL, url: 'https://models.test/stand-in.gguf', bytes: content.length, sha256: sha256Of(content) };
    const fetchImpl = vi.fn(async () => new Response(content, { status: 200 }));
    const { app, dir } = setup({ model, fetchImpl });
    const started = await request(app).post('/api/model-routes/local/download');
    expect(started.status).toBe(200);
    const finished = await vi.waitFor(async () => {
      const body = (await request(app).get('/api/model-routes/local')).body;
      if (body.downloading) throw new Error('still downloading');
      return body;
    });
    expect(finished).toMatchObject({ installed: true, error: null });
    expect(fetchImpl).toHaveBeenCalledWith(model.url, { signal: expect.any(AbortSignal) });
    expect(fs.readFileSync(path.join(dir, LOCAL_MODEL.file))).toEqual(content);
  });

  it('reports a download that fails its digest as an error and keeps no model file', async () => {
    const content = Buffer.from('a stand-in for the model file');
    const model = { ...LOCAL_MODEL, url: 'https://models.test/stand-in.gguf', bytes: content.length, sha256: sha256Of('other bytes') };
    const fetchImpl = vi.fn(async () => new Response(content, { status: 200 }));
    const { app, dir } = setup({ model, fetchImpl });
    await request(app).post('/api/model-routes/local/download').expect(200);
    const finished = await vi.waitFor(async () => {
      const body = (await request(app).get('/api/model-routes/local')).body;
      if (body.downloading) throw new Error('still downloading');
      return body;
    });
    expect(finished).toMatchObject({ installed: false, error: expect.stringMatching(/did not match its checksum/) });
    expect(fs.existsSync(path.join(dir, LOCAL_MODEL.file))).toBe(false);
    expect(fs.existsSync(path.join(dir, `${LOCAL_MODEL.file}.part`))).toBe(false);
  });
});
