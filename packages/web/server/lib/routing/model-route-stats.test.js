import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  queryRouteStats,
  registerModelRouteStatsRoutes,
  resolveOpenCodeDbPath,
} from './model-route-stats.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'route-stats-'));

const seedDb = (dir) => {
  const dbPath = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`create table route_attempt (
    id integer primary key autoincrement, time_started integer not null, time_ended integer not null,
    session_id text, assistant_message_id text, route_id text not null,
    provider_id text not null, model_id text not null, variant text,
    outcome text not null, error_tag text, error_code text, error_status integer,
    error_message text, error_body text, retryable integer, output_started integer not null,
    failed_over_to text, hedged integer, first_token_ms real, response_ms real,
    tokens_per_second real, tokens_input integer, tokens_estimated integer,
    tokens_output integer, tokens_reasoning integer, tokens_cache_read integer,
    tokens_cache_write integer, quota text
  )`);
  const insert = db.prepare(`insert into route_attempt
    (time_started, time_ended, assistant_message_id, route_id, provider_id, model_id,
     outcome, error_tag, error_status, error_message, output_started, hedged,
     first_token_ms, tokens_per_second)
    values (?, ?, ?, 'r', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const row = (time, message, provider, model, outcome, extra = {}) => [
    time, time + 100, message, provider, model, outcome,
    extra.tag ?? null, extra.status ?? null, extra.message ?? null,
    1, extra.hedged == null ? null : extra.hedged ? 1 : 0, extra.firstTokenMs ?? null, extra.tokensPerSecond ?? null,
  ];
  const now = Date.now();
  // openai/x: 3 attempts, 2 failures (one shared 503), slow first tokens.
  insert.run(...row(now - 1000, 'm1', 'openai', 'x', 'success', { firstTokenMs: 120, tokensPerSecond: 40 }));
  insert.run(...row(now - 2000, 'm2', 'openai', 'x', 'failure', { tag: 'ProviderInternal', status: 503, message: 'upstream exploded' }));
  insert.run(...row(now - 3000, 'm3', 'openai', 'x', 'failure', { tag: 'ProviderInternal', status: 503, message: 'upstream exploded again' }));
  // A hedged pair: anthropic/y answered, openai/x lost.
  insert.run(...row(now - 4000, 'mh', 'anthropic', 'y', 'success', { hedged: true, firstTokenMs: 90, tokensPerSecond: 60 }));
  insert.run(...row(now - 4000, 'mh', 'openai', 'x', 'hedged-out', { hedged: true }));
  // Same pair shape but a single unhedged row must not count as a hedge.
  insert.run(...row(now - 5000, 'solo', 'anthropic', 'y', 'success', { firstTokenMs: 80, tokensPerSecond: 55 }));
  db.close();
  return dbPath;
};

describe('queryRouteStats', () => {
  it('aggregates per-target counts, latencies, errors and hedge wins', async () => {
    const stats = await queryRouteStats(seedDb(tempDir()), { hours: 1 });
    expect(stats.available).toBe(true);
    expect(stats.targets).toHaveLength(2);
    const openai = stats.targets.find((row) => row.providerID === 'openai');
    expect(openai).toMatchObject({ modelID: 'x', attempts: 4, failures: 2, timeouts: 0 });
    expect(openai.avgFirstTokenMs).toBe(120);
    expect(openai.avgTokensPerSecond).toBe(40);
    const providerError = stats.errors.find((row) => row.tag === 'ProviderInternal');
    expect(providerError).toMatchObject({
      providerID: 'openai',
      modelID: 'x',
      status: 503,
      count: 2,
      lastMessage: 'upstream exploded',
    });
    expect(stats.hedges).toEqual([
      { providerID: 'anthropic', modelID: 'y', hedges: 1, wins: 1 },
      { providerID: 'openai', modelID: 'x', hedges: 1, wins: 0 },
    ]);
  });

  it('reports no-database and no-tables instead of throwing', async () => {
    await expect(queryRouteStats(path.join(tempDir(), 'missing.db'))).rejects.toThrow(/not found/);
    const dir = tempDir();
    const dbPath = path.join(dir, 'opencode.db');
    new DatabaseSync(dbPath).exec('create table other (id integer)');
    await expect(queryRouteStats(dbPath)).rejects.toThrow(/does not record/);
  });
});

describe('GET /api/model-routes/stats', () => {
  const createApp = (resolveDbPath) => {
    const app = express();
    registerModelRouteStatsRoutes(app, { resolveDbPath });
    return app;
  };

  it('returns aggregates for a seeded database', async () => {
    const dbPath = seedDb(tempDir());
    const response = await request(createApp(() => dbPath)).get('/api/model-routes/stats?hours=1');
    expect(response.status).toBe(200);
    expect(response.body.available).toBe(true);
    expect(response.body.targets).toHaveLength(2);
  });

  // Seed plus one attempt 100h ago: inside a reinterpreted 1e3-hour
  // (clamped 336h) window, outside the 24h default and a 2h window.
  const seedDbWithOldAttempt = () => {
    const dbPath = seedDb(tempDir());
    const db = new DatabaseSync(dbPath);
    const now = Date.now();
    db.prepare(`insert into route_attempt
      (time_started, time_ended, assistant_message_id, route_id, provider_id, model_id,
       outcome, error_tag, error_status, error_message, output_started, hedged,
       first_token_ms, tokens_per_second)
      values (?, ?, 'm-old', 'r', 'openai', 'x', 'success', null, null, null, 1, null, 100, 50)`)
      .run(now - 100 * 3_600_000, now - 100 * 3_600_000 + 100);
    db.close();
    return dbPath;
  };

  const openaiAttempts = (body) => body.targets.find((row) => row.providerID === 'openai')?.attempts;

  it.each(['1e3', '0x10', '2.0', '-5', '+2', ' 2 ', '01', '2.50'])(
    'falls back to the 24h default for the reinterpreted hours spelling %j',
    async (spelling) => {
      const dbPath = seedDbWithOldAttempt();
      const response = await request(createApp(() => dbPath)).get(
        `/api/model-routes/stats?hours=${encodeURIComponent(spelling)}`,
      );
      expect(response.status).toBe(200);
      expect(response.body.windowHours).toBe(24);
      expect(openaiAttempts(response.body)).toBe(4);
    },
  );

  it('honours canonical hours spellings, including a fractional window', async () => {
    const dbPath = seedDbWithOldAttempt();
    const wide = await request(createApp(() => dbPath)).get('/api/model-routes/stats?hours=200');
    expect(wide.body.windowHours).toBe(200);
    expect(openaiAttempts(wide.body)).toBe(5);
    const fractional = await request(createApp(() => dbPath)).get('/api/model-routes/stats?hours=1.5');
    expect(fractional.body.windowHours).toBe(1.5);
    expect(openaiAttempts(fractional.body)).toBe(4);
  });

  it('returns available:false when telemetry is absent', async () => {
    const response = await request(createApp(() => path.join(tempDir(), 'missing.db'))).get(
      '/api/model-routes/stats',
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ available: false, reason: 'no-database' });
  });

  it('reads no local database and answers remote-opencode when OpenCode is remote', async () => {
    const app = express();
    registerModelRouteStatsRoutes(app, {
      resolveDbPath: () => {
        throw new Error('must not resolve a local database path');
      },
      isOpenCodeLocal: () => false,
    });
    const response = await request(app).get('/api/model-routes/stats');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ available: false, reason: 'remote-opencode' });
  });
});

describe('resolveOpenCodeDbPath', () => {
  it('honours OPENCODE_DB and :memory:', () => {
    expect(resolveOpenCodeDbPath({ OPENCODE_DB: '/tmp/custom.db' })).toBe('/tmp/custom.db');
    expect(resolveOpenCodeDbPath({ OPENCODE_DB: ':memory:' })).toMatch(/opencode\.db$/);
    expect(resolveOpenCodeDbPath({})).toMatch(/opencode\.db$/);
    expect(resolveOpenCodeDbPath({ XDG_DATA_HOME: '/srv/data' })).toBe('/srv/data/opencode/opencode.db');
    expect(resolveOpenCodeDbPath({ XDG_DATA_HOME: '/srv/data', OPENCODE_DB: 'other.db' })).toBe('/srv/data/opencode/other.db');
  });
});
