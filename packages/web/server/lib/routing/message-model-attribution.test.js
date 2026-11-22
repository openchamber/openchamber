import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { queryMessageModelAttribution, registerMessageModelAttributionRoutes } from './message-model-attribution.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'message-model-attribution-'));

const seedDb = (dir) => {
  const dbPath = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`create table route_attempt (
    id integer primary key autoincrement, time_started integer not null, time_ended integer not null,
    session_id text, assistant_message_id text, route_id text not null,
    provider_id text not null, model_id text not null, variant text,
    outcome text not null, error_tag text, error_message text
  )`);
  db.exec(`create table route_decision (
    id integer primary key autoincrement, time integer not null, session_id text,
    route_id text not null, selection text not null, reason text not null
  )`);
  const insertAttempt = db.prepare(`insert into route_attempt
    (time_started, time_ended, session_id, assistant_message_id, route_id, provider_id, model_id, variant, outcome, error_tag, error_message)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertDecision = db.prepare(`insert into route_decision
    (time, session_id, route_id, selection, reason) values (?, ?, ?, ?, ?)`);
  return { dbPath, insertAttempt, insertDecision, db };
};

describe('queryMessageModelAttribution', () => {
  it('attributes a plain success to its route and selection', async () => {
    const { dbPath, insertAttempt, insertDecision, db } = seedDb(tempDir());
    insertDecision.run(1000, 's1', 'fast-strong', 'round-robin', 'drawn');
    insertAttempt.run(1010, 1200, 's1', 'm1', 'fast-strong', 'github-copilot', 'gpt-6-luna', 'low', 'success', null, null);
    db.close();

    const result = await queryMessageModelAttribution(dbPath, { sessionID: 's1' });
    expect(result.available).toBe(true);
    expect(result.messages.m1).toEqual({
      providerID: 'github-copilot',
      modelID: 'gpt-6-luna',
      variant: 'low',
      routeID: 'fast-strong',
      selection: { mode: 'round-robin', reason: 'drawn' },
      failover: null,
    });
  });

  it('reports a failover from the earlier failing attempt', async () => {
    const { dbPath, insertAttempt, insertDecision, db } = seedDb(tempDir());
    insertDecision.run(1000, 's1', 'fast-strong', 'ordered', 'ordered');
    insertAttempt.run(1010, 1050, 's1', 'm1', 'fast-strong', 'openai', 'gpt-6-luna', null, 'failure', 'Timeout', 'first-token timeout');
    insertAttempt.run(1060, 1300, 's1', 'm1', 'fast-strong', 'github-copilot', 'gpt-6-luna', null, 'success', null, null);
    db.close();

    const result = await queryMessageModelAttribution(dbPath, { sessionID: 's1' });
    expect(result.messages.m1).toMatchObject({
      providerID: 'github-copilot',
      modelID: 'gpt-6-luna',
      routeID: 'fast-strong',
      failover: { providerID: 'openai', modelID: 'gpt-6-luna', errorTag: 'Timeout', errorMessage: 'first-token timeout' },
    });
  });

  it('does not mistake a hedge loser for a failover', async () => {
    const { dbPath, insertAttempt, db } = seedDb(tempDir());
    insertAttempt.run(1000, 1090, 's1', 'm1', 'fast-strong', 'openai', 'gpt-6-luna', null, 'hedged-out', null, null);
    insertAttempt.run(1000, 1100, 's1', 'm1', 'fast-strong', 'anthropic', 'claude-sonnet-5.5', null, 'success', null, null);
    db.close();

    const result = await queryMessageModelAttribution(dbPath, { sessionID: 's1' });
    expect(result.messages.m1.failover).toBeNull();
  });

  it('leaves route_id empty (no pool) as a null routeID with no selection', async () => {
    const { dbPath, insertAttempt, db } = seedDb(tempDir());
    insertAttempt.run(1000, 1100, 's1', 'm1', '', 'anthropic', 'claude-sonnet-5.5', 'high', 'success', null, null);
    db.close();

    const result = await queryMessageModelAttribution(dbPath, { sessionID: 's1' });
    expect(result.messages.m1).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-5.5',
      variant: 'high',
      routeID: null,
      selection: null,
      failover: null,
    });
  });

  it('only attributes messages for the requested session', async () => {
    const { dbPath, insertAttempt, db } = seedDb(tempDir());
    insertAttempt.run(1000, 1100, 's1', 'm1', '', 'openai', 'gpt-6', null, 'success', null, null);
    insertAttempt.run(1000, 1100, 's2', 'm2', '', 'openai', 'gpt-6', null, 'success', null, null);
    db.close();

    const result = await queryMessageModelAttribution(dbPath, { sessionID: 's1' });
    expect(Object.keys(result.messages)).toEqual(['m1']);
  });

  it('rejects a missing sessionID', async () => {
    await expect(queryMessageModelAttribution(path.join(tempDir(), 'opencode.db'), {})).rejects.toThrow(/sessionID/);
  });
});

describe('GET /api/model-routes/turns', () => {
  const createApp = (resolveDbPath) => {
    const app = express();
    registerMessageModelAttributionRoutes(app, { resolveDbPath });
    return app;
  };

  it('returns attribution for a seeded database', async () => {
    const { dbPath, insertAttempt, db } = seedDb(tempDir());
    insertAttempt.run(1000, 1100, 's1', 'm1', '', 'openai', 'gpt-6', null, 'success', null, null);
    db.close();

    const response = await request(createApp(() => dbPath)).get('/api/model-routes/turns?sessionID=s1');
    expect(response.status).toBe(200);
    expect(response.body.available).toBe(true);
    expect(response.body.messages.m1.providerID).toBe('openai');
  });

  it('requires sessionID', async () => {
    const response = await request(createApp(() => path.join(tempDir(), 'opencode.db'))).get('/api/model-routes/turns');
    expect(response.status).toBe(400);
  });

  it('returns available:false when telemetry is absent', async () => {
    const response = await request(createApp(() => path.join(tempDir(), 'missing.db'))).get(
      '/api/model-routes/turns?sessionID=s1',
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ available: false, reason: 'no-database' });
  });

  it('reads no local database and answers remote-opencode when OpenCode is remote', async () => {
    const app = express();
    registerMessageModelAttributionRoutes(app, {
      resolveDbPath: () => {
        throw new Error('must not resolve a local database path');
      },
      isOpenCodeLocal: () => false,
    });
    const response = await request(app).get('/api/model-routes/turns?sessionID=s1');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ available: false, reason: 'remote-opencode' });
  });
});
