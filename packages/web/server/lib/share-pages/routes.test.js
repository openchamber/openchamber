import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerSharePageRoutes } from './routes.js';
import { createSharePagesRuntime, parseShareRequest } from './runtime.js';
import { createSharePageStore } from './store.js';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const createApp = async ({ available = true } = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-share-routes-'));
  directories.push(dataDir);
  let counter = 0;
  const relay = {
    create: vi.fn(async (base) => {
      counter += 1;
      return { id: `id${counter}`, url: `${base}/p/id${counter}` };
    }),
    states: vi.fn(async (_base, ids) => ids.map((id) => ({ id, status: 'open', opens: [] }))),
    close: vi.fn(async (_base, id) => ({ id, status: 'cancelled', closed: true })),
  };
  let enabled = true;
  const runtime = createSharePagesRuntime({
    crypto,
    store: createSharePageStore({ fsPromises: fs, path, dataDir }),
    relay,
    postSynthetic: vi.fn(),
    isAvailable: () => available && enabled,
    isRelayBaseAllowed: () => available && enabled,
    resolveRelayBase: async () => 'https://share.test',
    setIntervalImpl: () => ({ unref() {} }),
  });
  await runtime.createGroup({ sessionId: 'ses_1', callId: 'call_1', title: 'Schema', share: parseShareRequest({ recipients: ['Yulia'], summary: 'Pick a schema' }) });
  const app = express();
  registerSharePageRoutes(app, runtime);
  return { app, relay, disable: () => { enabled = false; } };
};

const BASE = '/api/openchamber/sessions/ses_1/share-pages/call_1';

describe('share page routes', () => {
  it('serve the group, take the document, withdraw a link and give the preview, as the card expects', async () => {
    const { app } = await createApp();

    const before = await request(app).get(BASE).expect(200);
    expect(before.body).toMatchObject({ title: 'Schema', kind: 'questionnaire', expectAnswer: true, summary: 'Pick a schema', documentState: 'preparing' });
    expect(before.body.recipients[0]).toEqual({
      recipientId: 'r1', label: 'Yulia', status: 'preparing', link: null, pin: null, opens: [], answeredAt: null, answerSummary: null, error: null,
    });

    const uploaded = await request(app).post(`${BASE}/document`).send({ html: '<p>Pick</p>', title: 'Schema' }).expect(200);
    expect(uploaded.body.documentState).toBe('ready');
    expect(uploaded.body.recipients[0].link).toMatch(/^https:\/\/share\.test\/p\/id1#[A-Za-z0-9_-]{43}$/);
    expect(uploaded.body.recipients[0].pin).toMatch(/^\d{6}$/);
    await request(app).post(`${BASE}/document`).send({ html: '<p>Pick</p>' }).expect(409);

    expect((await request(app).get(`${BASE}/preview`).expect(200)).body).toEqual({ html: '<p>Pick</p>' });
    const cancelled = await request(app).post(`${BASE}/recipients/r1/cancel`).expect(200);
    expect(cancelled.body.recipients[0].status).toBe('cancelled');
  });

  it('answer 404 for an unknown call and 403 enterprise_mode when sharing is unavailable', async () => {
    const { app, disable, relay } = await createApp();
    await request(app).get('/api/openchamber/sessions/ses_1/share-pages/other').expect(404);
    disable();
    const refused = await request(app).post(`${BASE}/document`).send({ html: '<p>Pick</p>' }).expect(403);
    expect(refused.body.code).toBe('enterprise_mode');
    expect(relay.create).not.toHaveBeenCalled();
    // The card hides itself on this refusal.
    expect((await request(app).get(BASE).expect(403)).body.code).toBe('enterprise_mode');
  });
});
