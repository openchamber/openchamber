import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import express from 'express';
import request from 'supertest';

import { computePoolHealth, isLocalOpenCode, registerPoolHealthRoutes } from './pool-health.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pool-health-'));

const seedDb = (dir, rows) => {
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
    (time_started, time_ended, session_id, route_id, provider_id, model_id, outcome, output_started, tokens_input, tokens_output, tokens_reasoning)
    values (?, ?, ?, 'pool', ?, ?, 'success', 1, ?, ?, ?)`);
  for (const row of rows) {
    insert.run(row.time, row.time + 100, row.session, row.provider, row.model, row.tokensIn ?? null, row.tokensOut ?? null, row.tokensReasoning ?? null);
  }
  db.close();
  return dbPath;
};

const plan = (id, quotas) => ({
  id, providerID: 'openai', label: id, coverage: 'subscription', status: 'active', quotas,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});

const baseDeps = (dbPath, { routes, plans = [], links = {} }) => ({
  readConfigLayers: () => ({ mergedConfig: { experimental: { model_routes: routes } }, userConfig: { experimental: { model_routes: routes } }, paths: { userPath: '/u/opencode.json' } }),
  resolveDbPath: () => dbPath,
  loadPlanStore: () => ({ version: 1, plans, models: {}, pools: {} }),
  loadPoolPlanLinks: () => ({ version: 1, links }),
  openchamberDataDir: '/unused',
});

describe('computePoolHealth', () => {
  it('counts active sessions per target and leaves unlinked targets with no plan info', async () => {
    const dir = tempDir();
    const now = Date.now();
    const dbPath = seedDb(dir, [
      { time: now - 1000, session: 's1', provider: 'openai', model: 'a' },
      { time: now - 2000, session: 's2', provider: 'openai', model: 'a' },
      { time: now - 3000, session: 's1', provider: 'openai', model: 'a' }, // same session again, counts once
      { time: now - 4000, session: 's3', provider: 'anthropic', model: 'b' },
    ]);
    const routes = { pool1: { targets: ['openai/a', 'anthropic/b'] } };
    const health = await computePoolHealth({ ...baseDeps(dbPath, { routes }), now });
    expect(health.available).toBe(true);
    expect(health.statsAvailable).toBe(true);
    const [openaiTarget, anthropicTarget] = health.pools.pool1.targets;
    expect(openaiTarget).toMatchObject({ ref: 'openai/a', activeSessions: 2, plan: null, blastRadius: true, suggestion: null });
    expect(anthropicTarget).toMatchObject({ ref: 'anthropic/b', activeSessions: 1, plan: null, blastRadius: false });
  });

  it('lets a higher-priority flat pool replace a lower-priority nested pool of the same id', async () => {
    const dbPath = seedDb(tempDir(), []);
    const health = await computePoolHealth({
      ...baseDeps(dbPath, { routes: {} }),
      readConfigLayers: () => ({
        userConfig: { experimental: { routes: { models: { pool1: { targets: ['anthropic/b'] } } } } },
        userOverrideConfig: {},
        customConfig: {},
        projectConfig: { experimental: { model_routes: { pool1: { targets: ['openai/a'] } } } },
        // What shared.js mergeConfigs produces: both files' shapes side by side.
        mergedConfig: {
          experimental: {
            routes: { models: { pool1: { targets: ['anthropic/b'] } } },
            model_routes: { pool1: { targets: ['openai/a'] } },
          },
        },
        paths: { userPath: '/u/opencode.json', userOverridePath: null, customPath: null, projectPath: '/p/opencode.json' },
      }),
      now: Date.now(),
    });
    expect(Object.keys(health.pools)).toEqual(['pool1']);
    expect(health.pools.pool1.targets.map((target) => target.ref)).toEqual(['openai/a']);
  });

  it('combines sibling targets on the same plan and flags a weighted pool nearing its quota', async () => {
    const dir = tempDir();
    const now = Date.now();
    // 48 attempts across both targets in the last 24h -> 2/hour -> over a 24h window that would be 48, past the 10-request limit.
    const rows = [];
    for (let i = 0; i < 24; i += 1) rows.push({ time: now - i * 3_600_000, session: `s${i}`, provider: 'openai', model: 'a' });
    for (let i = 0; i < 24; i += 1) rows.push({ time: now - i * 3_600_000, session: `t${i}`, provider: 'openai', model: 'a-secondary' });
    const dbPath = seedDb(dir, rows);
    const routes = {
      pool1: {
        selection: 'weighted',
        // anthropic/b is on no plan, so lowering an openai target's weight sends traffic off that quota.
        targets: ['openai/a', 'openai/a-secondary', 'anthropic/b'],
        weights: { 'openai/a': 1, 'openai/a-secondary': 1 },
      },
    };
    const plans = [{
      id: 'openai-plus', providerID: 'openai', label: 'OpenAI Plus', coverage: 'subscription', status: 'active',
      quotas: [{ name: 'daily', unit: 'requests', limit: 10, windowHours: 24 }],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }];
    const links = { 'openai/a': 'openai-plus', 'openai/a-secondary': 'openai-plus' };
    const health = await computePoolHealth({ ...baseDeps(dbPath, { routes, plans, links }), now, hours: 24 });
    const [first, second] = health.pools.pool1.targets;
    expect(first.plan.id).toBe('openai-plus');
    expect(first.plan.siblingRefs).toEqual(['openai/a-secondary']);
    expect(first.plan.projection.status).toBe('over');
    expect(first.suggestion).toBe('lower-weight');
    expect(second.plan.siblingRefs).toEqual(['openai/a']);
  });

  it('projects a token window from input, output and reasoning tokens', async () => {
    const now = Date.now();
    // 12 attempts over 24h at 100 + 50 + 50 tokens each: 2,400 tokens a day against a 2,000-token daily window.
    const rows = [];
    for (let i = 0; i < 12; i += 1) {
      rows.push({ time: now - i * 3_600_000, session: `s${i}`, provider: 'openai', model: 'a', tokensIn: 100, tokensOut: 50, tokensReasoning: 50 });
    }
    const dbPath = seedDb(tempDir(), rows);
    const plans = [plan('openai-tokens', [{ name: 'daily tokens', unit: 'tokens', limit: 2000, windowHours: 24 }])];
    const health = await computePoolHealth({
      ...baseDeps(dbPath, { routes: { pool1: { targets: ['openai/a'] } }, plans, links: { 'openai/a': 'openai-tokens' } }),
      now,
      hours: 24,
    });
    expect(health.pools.pool1.targets[0].plan.projection).toMatchObject({ unit: 'tokens', projected: 2400, status: 'over' });
  });

  it('labels a projection as a traffic estimate', async () => {
    const now = Date.now();
    const dbPath = seedDb(tempDir(), [{ time: now - 1000, session: 's1', provider: 'openai', model: 'a' }]);
    const plans = [plan('openai-plus', [{ name: 'daily', unit: 'requests', limit: 10, windowHours: 24 }])];
    const health = await computePoolHealth({
      ...baseDeps(dbPath, { routes: { pool1: { targets: ['openai/a'] } }, plans, links: { 'openai/a': 'openai-plus' } }),
      now,
      hours: 24,
    });
    expect(health.pools.pool1.targets[0].plan.projection).toMatchObject({ unit: 'requests', source: 'traffic-estimate' });
    expect(health.pools.pool1.targets[0].plan.unprojectedQuotas).toEqual([]);
  });

  it('explains why usd and percent windows get no projection instead of silence', async () => {
    const now = Date.now();
    const dbPath = seedDb(tempDir(), [{ time: now - 1000, session: 's1', provider: 'openai', model: 'a' }]);
    const plans = [plan('openai-metered', [
      { name: 'monthly cost', unit: 'usd', limit: 20, windowHours: 720 },
      { name: 'weekly share', unit: 'percent', limit: 80, windowHours: 168 },
    ])];
    const health = await computePoolHealth({
      ...baseDeps(dbPath, { routes: { pool1: { targets: ['openai/a'] } }, plans, links: { 'openai/a': 'openai-metered' } }),
      now,
      hours: 24,
    });
    const target = health.pools.pool1.targets[0];
    expect(target.plan.projection).toBeNull();
    expect(target.plan.unprojectedQuotas).toEqual([
      { quotaName: 'monthly cost', unit: 'usd', reason: 'needs-pricing' },
      { quotaName: 'weekly share', unit: 'percent', reason: 'needs-provider-meter' },
    ]);
  });

  it('still names an unprojected usd window beside a projected token window', async () => {
    const now = Date.now();
    const dbPath = seedDb(tempDir(), [{ time: now - 1000, session: 's1', provider: 'openai', model: 'a', tokensIn: 10, tokensOut: 0, tokensReasoning: 0 }]);
    const plans = [plan('openai-mixed', [
      { name: 'daily tokens', unit: 'tokens', limit: 2000, windowHours: 24 },
      { name: 'monthly cost', unit: 'usd', limit: 20, windowHours: 720 },
    ])];
    const health = await computePoolHealth({
      ...baseDeps(dbPath, { routes: { pool1: { targets: ['openai/a'] } }, plans, links: { 'openai/a': 'openai-mixed' } }),
      now,
      hours: 24,
    });
    const target = health.pools.pool1.targets[0];
    expect(target.plan.projection).toMatchObject({ unit: 'tokens', source: 'traffic-estimate' });
    expect(target.plan.unprojectedQuotas).toEqual([
      { quotaName: 'monthly cost', unit: 'usd', reason: 'needs-pricing' },
    ]);
  });

  it('reports the tightest of several quota windows', async () => {
    const now = Date.now();
    const rows = [];
    for (let i = 0; i < 6; i += 1) rows.push({ time: now - i * 3_600_000, session: `s${i}`, provider: 'openai', model: 'a' });
    const dbPath = seedDb(tempDir(), rows);
    // 6 requests a day: 6 percent of the loose window, 75 percent of the tight one.
    const plans = [plan('openai-two-windows', [
      { name: 'loose', unit: 'requests', limit: 100, windowHours: 24 },
      { name: 'tight', unit: 'requests', limit: 8, windowHours: 24 },
    ])];
    const health = await computePoolHealth({
      ...baseDeps(dbPath, { routes: { pool1: { targets: ['openai/a'] } }, plans, links: { 'openai/a': 'openai-two-windows' } }),
      now,
      hours: 24,
    });
    expect(health.pools.pool1.targets[0].plan.projection).toMatchObject({ quotaName: 'tight', status: 'warn' });
  });

  it('falls back to a 24-hour window when hours is not a positive number', async () => {
    const now = Date.now();
    const dbPath = seedDb(tempDir(), [{ time: now - 1000, session: 's1', provider: 'openai', model: 'a' }]);
    const plans = [plan('openai-plus', [{ name: 'daily', unit: 'requests', limit: 10, windowHours: 24 }])];
    const health = await computePoolHealth({
      ...baseDeps(dbPath, { routes: { pool1: { targets: ['openai/a'] } }, plans, links: { 'openai/a': 'openai-plus' } }),
      now,
      hours: Number.NaN,
    });
    expect(health.pools.pool1.targets[0].plan.projection).toMatchObject({ projected: 1, status: 'ok' });
  });

  it('counts a pattern target across the concrete models it matches, each session once', async () => {
    const now = Date.now();
    const dbPath = seedDb(tempDir(), [
      { time: now - 1000, session: 's1', provider: 'openai', model: 'gpt-x' },
      { time: now - 2000, session: 's1', provider: 'openai', model: 'gpt-y' },
      { time: now - 3000, session: 's2', provider: 'openai', model: 'gpt-y' },
      { time: now - 4000, session: 's3', provider: 'anthropic', model: 'gpt-x' },
    ]);
    const plans = [plan('openai-plus', [{ name: 'daily', unit: 'requests', limit: 100, windowHours: 24 }])];
    const health = await computePoolHealth({
      ...baseDeps(dbPath, { routes: { pool1: { targets: ['openai/*'] } }, plans, links: { 'openai/*': 'openai-plus' } }),
      now,
      hours: 24,
    });
    expect(health.pools.pool1.targets[0]).toMatchObject({ ref: 'openai/*', activeSessions: 2 });
    expect(health.pools.pool1.targets[0].plan.projection.projected).toBe(3);
  });

  it('keeps the session counts when plans.json or the links file cannot be read', async () => {
    const now = Date.now();
    const dbPath = seedDb(tempDir(), [
      { time: now - 1000, session: 's1', provider: 'openai', model: 'a' },
      { time: now - 2000, session: 's2', provider: 'openai', model: 'a' },
    ]);
    const health = await computePoolHealth({
      ...baseDeps(dbPath, { routes: { pool1: { targets: ['openai/a'] } } }),
      loadPlanStore: () => { throw new Error('plans.json is not valid JSON'); },
      loadPoolPlanLinks: () => { throw new Error('pool-plan-links.json is not valid JSON'); },
      now,
    });
    expect(health.planError).toContain('plans.json');
    expect(health.linksError).toContain('pool-plan-links.json');
    expect(health.pools.pool1.targets[0]).toMatchObject({ activeSessions: 2, blastRadius: true, plan: null, missingPlanID: null });
  });

  it('reports a link to a plan that no longer exists', async () => {
    const dbPath = seedDb(tempDir(), []);
    const health = await computePoolHealth({
      ...baseDeps(dbPath, { routes: { pool1: { targets: ['openai/a'] } }, links: { 'openai/a': 'deleted-plan' } }),
    });
    expect(health.pools.pool1.targets[0]).toMatchObject({ plan: null, missingPlanID: 'deleted-plan' });
  });

  it('counts a session on the target of its latest attempt, not one it failed over from', async () => {
    const now = Date.now();
    const dbPath = seedDb(tempDir(), [
      { time: now - 5 * 60_000, session: 's1', provider: 'openai', model: 'a' },
      { time: now - 1 * 60_000, session: 's1', provider: 'anthropic', model: 'b' },
      { time: now - 2 * 60_000, session: 's2', provider: 'openai', model: 'a' },
    ]);
    const health = await computePoolHealth({ ...baseDeps(dbPath, { routes: { pool1: { targets: ['openai/a', 'anthropic/b'] } } }), now });
    expect(health.pools.pool1.targets.map(({ ref, activeSessions }) => [ref, activeSessions])).toEqual([['openai/a', 1], ['anthropic/b', 1]]);
  });

  it('gives no projection for a window of zero or negative hours', async () => {
    const now = Date.now();
    const dbPath = seedDb(tempDir(), [{ time: now - 1000, session: 's1', provider: 'openai', model: 'a' }]);
    const plans = [plan('broken', [{ name: 'none', unit: 'requests', limit: 10, windowHours: 0 }, { name: 'negative', unit: 'requests', limit: 10, windowHours: -5 }])];
    const health = await computePoolHealth({ ...baseDeps(dbPath, { routes: { pool1: { targets: ['openai/a'] } }, plans, links: { 'openai/a': 'broken' } }), now });
    expect(health.pools.pool1.targets[0].plan.projection).toBeNull();
  });

  it('projects from the hours the query actually sampled when asked for less than its minimum', async () => {
    const now = Date.now();
    // One attempt 4 minutes ago: inside the 6-minute (0.1 h) minimum sample, outside 3 minutes.
    const dbPath = seedDb(tempDir(), [{ time: now - 4 * 60_000, session: 's1', provider: 'openai', model: 'a' }]);
    const plans = [plan('openai-plus', [{ name: 'hourly', unit: 'requests', limit: 100, windowHours: 1 }])];
    const health = await computePoolHealth({ ...baseDeps(dbPath, { routes: { pool1: { targets: ['openai/a'] } }, plans, links: { 'openai/a': 'openai-plus' } }), now, hours: 0.05 });
    expect(health.pools.pool1.targets[0].plan.projection.projected).toBe(10);
  });

  it('offers no lower-weight suggestion once the weight is at its floor', async () => {
    const now = Date.now();
    const rows = [];
    for (let i = 0; i < 24; i += 1) rows.push({ time: now - i * 3_600_000, session: `s${i}`, provider: 'openai', model: 'a' });
    const dbPath = seedDb(tempDir(), rows);
    const plans = [plan('openai-plus', [{ name: 'daily', unit: 'requests', limit: 10, windowHours: 24 }])];
    const at = (weight) => computePoolHealth({
      ...baseDeps(dbPath, {
        routes: { pool1: { selection: 'round-robin', targets: ['openai/a', 'anthropic/b'], weights: { 'openai/a': weight } } },
        plans,
        links: { 'openai/a': 'openai-plus' },
      }),
      now,
    });
    expect((await at(0.2)).pools.pool1.targets[0].suggestion).toBe('lower-weight');
    expect((await at(0.1)).pools.pool1.targets[0].suggestion).toBeNull();
  });

  it('counts each telemetry row once when overlapping links name the same plan', async () => {
    const now = Date.now();
    const rows = [];
    for (let i = 0; i < 6; i += 1) rows.push({ time: now - i * 3_600_000, session: `s${i}`, provider: 'openai', model: 'gpt-x' });
    const dbPath = seedDb(tempDir(), rows);
    const plans = [plan('openai-plus', [{ name: 'daily', unit: 'requests', limit: 100, windowHours: 24 }])];
    const health = await computePoolHealth({
      ...baseDeps(dbPath, { routes: { pool1: { targets: ['openai/*', 'openai/gpt-x'] } }, plans, links: { 'openai/*': 'openai-plus', 'openai/gpt-x': 'openai-plus' } }),
      now,
      hours: 24,
    });
    expect(health.pools.pool1.targets[0].plan.projection.projected).toBe(6);
  });

  it('keeps the session counts when only the usage query fails', async () => {
    const now = Date.now();
    const dbPath = path.join(tempDir(), 'opencode.db');
    const db = new DatabaseSync(dbPath);
    // An older table without the token columns: the usage query fails, the session query works.
    db.exec('create table route_attempt (time_started integer, session_id text, route_id text, provider_id text, model_id text, outcome text)');
    db.prepare('insert into route_attempt values (?, ?, ?, ?, ?, ?)').run(now - 1000, 's1', 'pool', 'openai', 'a', 'success');
    db.prepare('insert into route_attempt values (?, ?, ?, ?, ?, ?)').run(now - 2000, 's2', 'pool', 'openai', 'a', 'success');
    db.close();
    const plans = [plan('openai-plus', [{ name: 'daily', unit: 'requests', limit: 10, windowHours: 24 }])];
    const health = await computePoolHealth({ ...baseDeps(dbPath, { routes: { pool1: { targets: ['openai/a'] } }, plans, links: { 'openai/a': 'openai-plus' } }), now });
    expect(health).toMatchObject({ statsAvailable: false, sessionsAvailable: true, usageAvailable: false });
    expect(health.pools.pool1.targets[0]).toMatchObject({ activeSessions: 2, blastRadius: true });
    expect(health.pools.pool1.targets[0].plan.projection).toBeNull();
  });

  it('reads no local telemetry for an OpenCode on another host', async () => {
    const now = Date.now();
    const dbPath = seedDb(tempDir(), [{ time: now - 1000, session: 's1', provider: 'openai', model: 'a' }]);
    const health = await computePoolHealth({ ...baseDeps(dbPath, { routes: { pool1: { targets: ['openai/a'] } } }), telemetryLocal: false, now });
    expect(health).toMatchObject({ statsAvailable: false, statsReason: 'remote-opencode' });
    expect(health.pools.pool1.targets[0].activeSessions).toBeNull();
  });

  it('treats only a loopback OpenCode as local', () => {
    expect(isLocalOpenCode(() => 'http://127.0.0.1:4096/')).toBe(true);
    expect(isLocalOpenCode(() => 'http://localhost:4096/')).toBe(true);
    expect(isLocalOpenCode(() => 'http://[::1]:4096/')).toBe(true);
    expect(isLocalOpenCode(() => 'http://seamus:4095/')).toBe(false);
    expect(isLocalOpenCode(() => { throw new Error('not started'); })).toBe(false);
  });

  it('offers no lower-weight suggestion when every other target draws on the same plan', async () => {
    const now = Date.now();
    const rows = [];
    for (let i = 0; i < 24; i += 1) rows.push({ time: now - i * 3_600_000, session: `s${i}`, provider: 'openai', model: 'a' });
    const dbPath = seedDb(tempDir(), rows);
    const plans = [plan('openai-plus', [{ name: 'daily', unit: 'requests', limit: 10, windowHours: 24 }])];
    const health = await computePoolHealth({
      ...baseDeps(dbPath, {
        routes: { pool1: { selection: 'weighted', targets: ['openai/a', 'openai/a2'] } },
        plans,
        links: { 'openai/a': 'openai-plus', 'openai/a2': 'openai-plus' },
      }),
      now,
    });
    expect(health.pools.pool1.targets.map(({ suggestion }) => suggestion)).toEqual([null, null]);
  });

  it('offers no lower-weight suggestion for a pattern target, whose weight OpenCode never reads', async () => {
    const now = Date.now();
    const rows = [];
    for (let i = 0; i < 24; i += 1) rows.push({ time: now - i * 3_600_000, session: `s${i}`, provider: 'openai', model: 'a' });
    const dbPath = seedDb(tempDir(), rows);
    const plans = [plan('openai-plus', [{ name: 'daily', unit: 'requests', limit: 10, windowHours: 24 }])];
    const health = await computePoolHealth({
      ...baseDeps(dbPath, {
        routes: { pool1: { selection: 'weighted', targets: ['openai/*', 'anthropic/b'] } },
        plans,
        links: { 'openai/*': 'openai-plus' },
      }),
      now,
    });
    const [pattern, concrete] = health.pools.pool1.targets;
    // The pattern's plan is projected over, so every other suggestion
    // condition holds; the pattern itself is the only reason for no offer.
    expect(pattern.plan.projection.status).toBe('over');
    expect(pattern.suggestion).toBeNull();
    expect(concrete.suggestion).toBeNull();
  });

  it('gives a request to the most specific link when overlapping links name different plans', async () => {
    const now = Date.now();
    const rows = [];
    for (let i = 0; i < 4; i += 1) rows.push({ time: now - i * 3_600_000, session: `x${i}`, provider: 'openai', model: 'gpt-x' });
    for (let i = 0; i < 2; i += 1) rows.push({ time: now - i * 3_600_000, session: `y${i}`, provider: 'openai', model: 'gpt-y' });
    const dbPath = seedDb(tempDir(), rows);
    const window = [{ name: 'daily', unit: 'requests', limit: 100, windowHours: 24 }];
    const health = await computePoolHealth({
      ...baseDeps(dbPath, {
        routes: { pool1: { targets: ['openai/*', 'openai/gpt-x'] } },
        plans: [plan('wide', window), plan('exact', window)],
        links: { 'openai/*': 'wide', 'openai/gpt-x': 'exact' },
      }),
      now,
      hours: 24,
    });
    const [wide, exact] = health.pools.pool1.targets;
    expect(wide.plan.projection.projected).toBe(2);
    expect(exact.plan.projection.projected).toBe(4);
  });

  it('counts a request once when a pattern and a model it covers link to the same plan', async () => {
    const now = Date.now();
    // 20 attempts on openai/gpt-x in 24h against a 24-request daily quota:
    // the single-link projection is 20 (ratio 0.83). Counting the rows under
    // both links would project 40 and flip the plan to over.
    const rows = [];
    for (let i = 0; i < 20; i += 1) rows.push({ time: now - i * 3_600_000, session: `s${i}`, provider: 'openai', model: 'gpt-x' });
    const dbPath = seedDb(tempDir(), rows);
    const plans = [plan('openai-plus', [{ name: 'daily', unit: 'requests', limit: 24, windowHours: 24 }])];
    const routes = { pool1: { targets: ['openai/*', 'openai/gpt-x'] } };
    const both = await computePoolHealth({
      ...baseDeps(dbPath, { routes, plans, links: { 'openai/*': 'openai-plus', 'openai/gpt-x': 'openai-plus' } }),
      now,
      hours: 24,
    });
    const patternOnly = await computePoolHealth({
      ...baseDeps(dbPath, { routes, plans, links: { 'openai/*': 'openai-plus' } }),
      now,
      hours: 24,
    });
    for (const target of both.pools.pool1.targets) {
      expect(target.plan.projection.projected).toBe(20);
      expect(target.plan.projection.status).not.toBe('over');
    }
    expect(both.pools.pool1.targets[0].plan.projection).toEqual(patternOnly.pools.pool1.targets[0].plan.projection);
  });

  it('leaves nested pools out of the target list', async () => {
    const dbPath = seedDb(tempDir(), []);
    const health = await computePoolHealth({ ...baseDeps(dbPath, { routes: { outer: { targets: ['openai/a', 'opencode-route/inner'] } } }) });
    expect(health.pools.outer.targets.map(({ ref }) => ref)).toEqual(['openai/a']);
  });

  it('degrades to statsAvailable: false instead of throwing when the database is missing', async () => {
    const routes = { pool1: { targets: ['openai/a'] } };
    const health = await computePoolHealth({ ...baseDeps(path.join(tempDir(), 'missing.db'), { routes }) });
    expect(health.available).toBe(true);
    expect(health.statsAvailable).toBe(false);
    expect(health.statsReason).toBe('no-database');
    expect(health.pools.pool1.targets[0]).toMatchObject({ activeSessions: null, plan: null, blastRadius: false });
  });
});

describe('registerPoolHealthRoutes query parsing', () => {
  const routeApp = () => {
    const root = tempDir();
    const xdg = path.join(root, 'xdg');
    const opencodeDir = path.join(xdg, 'opencode');
    fs.mkdirSync(opencodeDir, { recursive: true });
    const now = Date.now();
    // s1 is inside every window; s2 is inside 30 minutes but outside the
    // 15-minute default; the old attempt is inside a reinterpreted 1e3-hour
    // (clamped 336h) window but outside the 24-hour default.
    seedDb(opencodeDir, [
      { time: now - 10 * 60_000, session: 's1', provider: 'openai', model: 'a' },
      { time: now - 20 * 60_000, session: 's2', provider: 'openai', model: 'a' },
      { time: now - 100 * 3_600_000, session: 's-old', provider: 'openai', model: 'a' },
    ]);
    const plans = [plan('openai-plus', [{ name: 'daily', unit: 'requests', limit: 100, windowHours: 24 }])];
    fs.writeFileSync(path.join(opencodeDir, 'plans.json'), JSON.stringify({ version: 1, plans, models: {}, pools: {} }));
    const openchamberDataDir = path.join(root, 'openchamber');
    fs.mkdirSync(openchamberDataDir, { recursive: true });
    fs.writeFileSync(path.join(openchamberDataDir, 'pool-plan-links.json'), JSON.stringify({ version: 1, links: { 'openai/a': 'openai-plus' } }));
    process.env.XDG_DATA_HOME = xdg;
    delete process.env.OPENCODE_DB;
    const app = express();
    registerPoolHealthRoutes(app, {
      readConfigLayers: () => ({ mergedConfig: { experimental: { model_routes: { pool1: { targets: ['openai/a'] } } } }, userConfig: { experimental: { model_routes: { pool1: { targets: ['openai/a'] } } } }, paths: { userPath: '/u/opencode.json' } }),
      openchamberDataDir,
      isOpenCodeLocal: () => true,
    });
    return app;
  };

  const targetFor = async (app, query) => {
    const response = await request(app).get(`/api/model-routes/health${query}`);
    expect(response.status).toBe(200);
    return response.body.pools.pool1.targets[0];
  };

  it('falls back to the defaults for reinterpreted spellings of both parameters', async () => {
    const app = routeApp();
    // 1e3 reinterpreted would be a 336h usage window (3 attempts, projected
    // 0.2) and a 1000-minute active window (2 sessions).
    const target = await targetFor(app, '?hours=1e3&activeMinutes=1e3');
    expect(target.activeSessions).toBe(1);
    expect(target.plan.projection.projected).toBe(2);
  });

  it('falls back to the defaults for radix-prefixed spellings', async () => {
    const app = routeApp();
    // 0x10 reinterpreted as 16h would project (2/16)*24 = 3.
    const byHours = await targetFor(app, '?hours=0x10');
    expect(byHours.plan.projection.projected).toBe(2);
    // 0b101 reinterpreted as 5 minutes would count no active session.
    const byActive = await targetFor(app, '?activeMinutes=0b101');
    expect(byActive.activeSessions).toBe(1);
  });

  it('honours canonical spellings, including a fractional window', async () => {
    const app = routeApp();
    const target = await targetFor(app, '?hours=2&activeMinutes=30');
    expect(target.activeSessions).toBe(2);
    expect(target.plan.projection.projected).toBe(24);
    const fractional = await targetFor(app, '?hours=1.5');
    expect(fractional.plan.projection.projected).toBe(32);
  });
});
