import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { registerPlanRoutes } from './plan-routes.js';

const NOW = '2026-10-14T09:00:00.000Z';
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plan-routes-'));

const createApp = (dataDir) => {
  const app = express();
  registerPlanRoutes(app, { dataDir, now: () => new Date(NOW) });
  return app;
};

describe('plan routes', () => {
  it('records a plan and returns it with the whole store', async () => {
    const dataDir = dir();
    const app = createApp(dataDir);
    const saved = await request(app)
      .put('/api/routing/plans/record')
      .send({ providerID: 'anthropic', plan: 'Max 20x', quotas: [{ name: '5-hour', unit: 'messages', windowHours: 5 }] })
      .expect(200);
    expect(saved.body).toMatchObject({ id: 'anthropic-max-20x', providerID: 'anthropic', updatedAt: NOW });
    const listed = await request(app).get('/api/routing/plans').expect(200);
    expect(listed.body.plans.map((plan) => plan.id)).toEqual(['anthropic-max-20x']);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'plans.json'), 'utf8')).plans).toHaveLength(1);
  });

  it('answers a bad field with a 400 that names the problem', async () => {
    const app = createApp(dir());
    const rejected = await request(app)
      .put('/api/routing/plans/record')
      .send({ providerID: 'openai', coverage: 'lottery' })
      .expect(400);
    expect(rejected.body.error).toBeTruthy();
  });

  it('sets a model tier and a pool purpose', async () => {
    const app = createApp(dir());
    const model = await request(app)
      .put('/api/routing/plans/model')
      .send({ model: 'openai/gpt-6-astra', tier: 'frontier', coveredBy: ['openai-plus'] })
      .expect(200);
    expect(model.body).toMatchObject({ tier: 'frontier', coveredBy: ['openai-plus'] });
    await request(app).put('/api/routing/plans/model').send({ model: 'no-slash', tier: 'frontier' }).expect(400);
    const pool = await request(app)
      .put('/api/routing/plans/pool')
      .send({ id: 'hard', tier: 'frontier', purpose: 'debugging with an unknown cause' })
      .expect(200);
    expect(pool.body).toMatchObject({ tier: 'frontier', purpose: 'debugging with an unknown cause' });
  });

  it('adds a note from the UI and lists it back', async () => {
    const app = createApp(dir());
    const added = await request(app)
      .post('/api/routing/plans/notes')
      .send({ text: 'ran out of claude too fast', kind: 'experience', providerID: 'anthropic', source: 'model' })
      .expect(200);
    expect(added.body).toMatchObject({ kind: 'experience', source: 'ui', providerID: 'anthropic' });
    const listed = await request(app).get('/api/routing/plans/notes?limit=5').expect(200);
    expect(listed.body.notes.map((note) => note.text)).toEqual(['ran out of claude too fast']);
  });

  it('defaults malformed note limits and clamps valid limits', async () => {
    const dataDir = dir();
    const notes = Array.from({ length: 505 }, (_value, index) => JSON.stringify({
      id: `note-${index}`,
      at: new Date(Date.parse(NOW) + index * 1000).toISOString(),
      kind: 'other',
      text: `note ${index}`,
      source: 'user',
    }));
    fs.writeFileSync(path.join(dataDir, 'plan-notes.jsonl'), `${notes.join('\n')}\n`);
    const app = createApp(dataDir);

    for (const limit of ['10junk', '2.9', '1e3']) {
      const listed = await request(app).get('/api/routing/plans/notes').query({ limit }).expect(200);
      expect(listed.body.notes).toHaveLength(50);
      expect(listed.body.notes[0].text).toBe('note 455');
    }

    const ten = await request(app).get('/api/routing/plans/notes?limit=10').expect(200);
    expect(ten.body.notes).toHaveLength(10);
    const two = await request(app).get('/api/routing/plans/notes?limit=2').expect(200);
    expect(two.body.notes).toHaveLength(2);
    const capped = await request(app).get('/api/routing/plans/notes?limit=500').expect(200);
    expect(capped.body.notes).toHaveLength(500);
  });

  it('refuses to write over a malformed plan file, and leaves it as it was', async () => {
    const dataDir = dir();
    fs.writeFileSync(path.join(dataDir, 'plans.json'), '{ broken');
    const app = createApp(dataDir);
    await request(app).put('/api/routing/plans/record').send({ providerID: 'openai' }).expect(409);
    expect(fs.readFileSync(path.join(dataDir, 'plans.json'), 'utf8')).toBe('{ broken');
  });
});
