import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { querySessionsOnTarget, queryTargetReliability } from './model-route-stats.js';
import {
  DEFAULT_ROTATION_SETTINGS,
  createPoolRotation,
  orderForMove,
  pickDestination,
  readRotationSettings,
  registerPoolRotationRoutes,
} from './pool-rotation.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pool-rotation-'));
const MINUTE = 60_000;

const projection = (ratio) => ({
  quotaName: 'daily', unit: 'requests', limit: 100, windowHours: 24, projected: ratio * 100, ratio,
  status: ratio >= 1 ? 'over' : ratio >= 0.7 ? 'warn' : 'ok',
});
const target = (ref, activeSessions, planID = null, ratio = null) => ({
  ref,
  activeSessions,
  blastRadius: activeSessions >= 2,
  suggestion: null,
  plan: planID ? { id: planID, label: planID, providerID: ref.split('/')[0], siblingRefs: [], projection: ratio === null ? null : projection(ratio) } : null,
});

/** One pool `busy` whose first target is near its plan's limit, with three sessions on it. */
const setup = ({
  enabled = true,
  intervalMinutes = 5,
  targets = [target('openai/a', 3, 'plan-a', 0.9), target('anthropic/b', 0, 'plan-b', 0.2)],
  rawTargets = ['openai/a', 'anthropic/b#high'],
  onTarget = [
    { sessionID: 'primary-old', lastAttempt: 1 * MINUTE },
    { sessionID: 'primary-new', lastAttempt: 5 * MINUTE },
    { sessionID: 'sub', lastAttempt: 9.5 * MINUTE },
  ],
  sessions = {
    'primary-old': { model: { providerID: 'opencode-route', id: 'busy' } },
    'primary-new': { model: { providerID: 'opencode-route', id: 'busy' } },
    sub: { parentID: 'primary-old', model: { providerID: 'opencode-route', id: 'busy' } },
  },
  auto = new Set(),
  statsAvailable = true,
  reliability = [],
  switchModel = null,
  callTimeoutMs = 15_000,
  // Sessions OpenCode lists as running (session.active); the running subagent by default.
  active = new Set(['sub']),
  activeFails = false,
  projectRoutes = null,
  getSession = null,
} = {}) => {
  const data = dir();
  fs.writeFileSync(path.join(data, 'pool-rotation.json'), JSON.stringify({ enabled, intervalMinutes }));
  const switches = [];
  const clock = { now: 10 * MINUTE };
  const rotation = createPoolRotation({
    dataDir: data,
    computeHealth: async () => ({ available: true, statsAvailable, pools: { busy: { selection: 'ordered', targets } } }),
    // A project directory gets its own pool map when the test gives one.
    readRoutes: (directory) => (directory && projectRoutes ? projectRoutes : { busy: { targets: rawTargets } }),
    // Like the database, this knows only the last attempts, not a model the session was switched to since.
    // An entry is on `openai/a` unless it names another target.
    sessionsOnTarget: async ({ ref }) => onTarget
      .filter((entry) => (entry.target ?? 'openai/a') === ref)
      .map(({ sessionID, lastAttempt }) => ({ sessionID, lastAttempt })),
    activeSessionIDs: async () => {
      if (activeFails) throw new Error('OpenCode is restarting');
      return active;
    },
    getSession: getSession ?? (async (sessionID) => sessions[sessionID]),
    targetReliability: async () => reliability,
    switchModel: switchModel ?? (async (sessionID, model) => {
      switches.push({ sessionID, model });
      sessions[sessionID] = { ...sessions[sessionID], model };
    }),
    isAutoSession: (sessionID) => auto.has(sessionID),
    now: () => clock.now,
    callTimeoutMs,
    log: { warn: () => {} },
  });
  return { rotation, switches, clock, data, sessions };
};

describe('pool rotation', () => {
  it('does nothing while turned off, which is the default', async () => {
    const data = dir();
    expect(readRotationSettings(data)).toEqual(DEFAULT_ROTATION_SETTINGS);
    const { rotation, switches } = setup({ enabled: false });
    expect(await rotation.tick()).toEqual([]);
    expect(switches).toEqual([]);
  });

  it('moves a subagent first, onto the target with headroom, keeping its variant', async () => {
    const { rotation, switches } = setup();
    const [move] = await rotation.tick();
    expect(switches).toEqual([{ sessionID: 'sub', model: { providerID: 'anthropic', id: 'b', variant: 'high' } }]);
    expect(move).toMatchObject({ poolID: 'busy', sessionID: 'sub', subagent: true, from: 'openai/a', to: 'anthropic/b' });
    expect(rotation.recentMoves()).toHaveLength(1);
  });

  it('moves one session per pool per interval, then the one idle longest', async () => {
    const { rotation, switches, clock } = setup({ intervalMinutes: 5 });
    await rotation.tick();
    clock.now += 4 * MINUTE;
    expect(await rotation.tick()).toEqual([]);
    clock.now += 1 * MINUTE;
    await rotation.tick();
    expect(switches.map(({ sessionID }) => sessionID)).toEqual(['sub', 'primary-old']);
  });

  it('leaves Auto sessions and sessions no longer on the pool alone', async () => {
    const { rotation, switches } = setup({
      auto: new Set(['sub']),
      sessions: {
        'primary-old': { model: { providerID: 'openai', id: 'a' } },
        'primary-new': { model: { providerID: 'opencode-route', id: 'busy' } },
        other: { model: { providerID: 'opencode-route', id: 'busy' } },
        sub: { parentID: 'x', model: { providerID: 'opencode-route', id: 'busy' } },
      },
      onTarget: [
        { sessionID: 'primary-old', lastAttempt: 1 * MINUTE },
        { sessionID: 'primary-new', lastAttempt: 5 * MINUTE },
        { sessionID: 'other', lastAttempt: 6 * MINUTE },
        { sessionID: 'sub', lastAttempt: 9.5 * MINUTE },
      ],
    });
    await rotation.tick();
    expect(switches.map(({ sessionID }) => sessionID)).toEqual(['primary-new']);
  });

  // An Auto session on the target loses its cache in the same bust, so it counts
  // toward the two-session crowd; it never moves, because Auto re-picks per send.
  it('counts an Auto session toward the crowd but never moves it', async () => {
    const pool = { providerID: 'opencode-route', id: 'busy' };
    const { rotation, switches } = setup({
      auto: new Set(['on-auto']),
      onTarget: [
        { sessionID: 'on-auto', lastAttempt: 1 * MINUTE },
        { sessionID: 'primary-new', lastAttempt: 5 * MINUTE },
      ],
      sessions: { 'on-auto': { model: pool }, 'primary-new': { model: pool } },
    });
    await rotation.tick();
    expect(switches.map(({ sessionID }) => sessionID)).toEqual(['primary-new']);
  });

  it('paces each pool on its own', async () => {
    const pool = (id) => ({ providerID: 'opencode-route', id });
    const sessions = {
      a1: { model: pool('one') }, a2: { model: pool('one') }, a3: { model: pool('one') },
      b1: { model: pool('two') }, b2: { model: pool('two') }, b3: { model: pool('two') },
    };
    const data = dir();
    fs.writeFileSync(path.join(data, 'pool-rotation.json'), JSON.stringify({ enabled: true, intervalMinutes: 5 }));
    const health = [target('openai/a', 3, 'plan-a', 0.9), target('anthropic/b', 0, 'plan-b', 0.2)];
    const switches = [];
    const rotation = createPoolRotation({
      dataDir: data,
      computeHealth: async () => ({ available: true, statsAvailable: true, pools: { one: { selection: 'ordered', targets: health }, two: { selection: 'ordered', targets: health } } }),
      readRoutes: () => ({ one: { targets: ['openai/a', 'anthropic/b'] }, two: { targets: ['openai/a', 'anthropic/b'] } }),
      sessionsOnTarget: async ({ routeID }) => [1, 2, 3].map((n) => ({ sessionID: `${routeID === 'one' ? 'a' : 'b'}${n}`, lastAttempt: n * MINUTE })),
      activeSessionIDs: async () => new Set(),
      getSession: async (sessionID) => sessions[sessionID],
      switchModel: async (sessionID, model) => { switches.push(sessionID); sessions[sessionID] = { model }; },
      now: () => 10 * MINUTE,
      log: { warn: () => {} },
    });
    const made = await rotation.tick();
    expect(made.map(({ poolID }) => poolID)).toEqual(['one', 'two']);
    expect(switches).toEqual(['a1', 'b1']);
  });

  it('moves nothing when every other target shares the plan or is near its own limit', async () => {
    const { rotation, switches } = setup({
      targets: [target('openai/a', 3, 'plan-a', 0.9), target('openai/a2', 0, 'plan-a', 0.1), target('anthropic/b', 0, 'plan-b', 0.8)],
      rawTargets: ['openai/a', 'openai/a2', 'anthropic/b'],
    });
    expect(await rotation.tick()).toEqual([]);
    expect(switches).toEqual([]);
  });

  it('moves nothing off a target with a single session, or when telemetry is unavailable', async () => {
    const single = setup({
      targets: [target('openai/a', 1, 'plan-a', 0.95), target('anthropic/b', 0, 'plan-b', 0.1)],
      onTarget: [{ sessionID: 'primary-old', lastAttempt: 1 * MINUTE }],
    });
    expect(await single.rotation.tick()).toEqual([]);
    const blind = setup({ statsAvailable: false });
    expect(await blind.rotation.tick()).toEqual([]);
    expect([...single.switches, ...blind.switches]).toEqual([]);
  });

  it('moves the next session when one switch fails, and skips the failed one for a while', async () => {
    const attempts = [];
    const ctx = setup({
      switchModel: async (sessionID, model) => {
        attempts.push(sessionID);
        if (sessionID === 'sub') throw new Error('LocationNotFoundError');
        ctx.switches.push({ sessionID, model });
        ctx.sessions[sessionID] = { ...ctx.sessions[sessionID], model };
      },
    });
    const [move] = await ctx.rotation.tick();
    expect(attempts).toEqual(['sub', 'primary-old']);
    expect(move).toMatchObject({ sessionID: 'primary-old' });
    ctx.clock.now += 5 * MINUTE;
    // 'sub' is still running and first in line, but it failed and is skipped; being
    // live, it still counts on the target, so primary-new is not the last and moves.
    await ctx.rotation.tick();
    expect(attempts).toEqual(['sub', 'primary-old', 'primary-new']);
    expect(ctx.rotation.recentMoves().map(({ sessionID }) => sessionID)).toEqual(['primary-new', 'primary-old']);
  });

  it('does not throttle a pool when every switch failed', async () => {
    let fail = true;
    const onTarget = [
      { sessionID: 'primary-old', lastAttempt: 1 * MINUTE },
      { sessionID: 'primary-new', lastAttempt: 5 * MINUTE },
    ];
    const ctx = setup({
      onTarget,
      switchModel: async (sessionID, model) => {
        if (fail) throw new Error('OpenCode is restarting');
        ctx.switches.push({ sessionID, model });
        ctx.sessions[sessionID] = { ...ctx.sessions[sessionID], model };
      },
    });
    expect(await ctx.rotation.tick()).toEqual([]);
    // One minute later, well inside the 5-minute pace: two new sessions arrive and one moves.
    fail = false;
    ctx.clock.now += 1 * MINUTE;
    onTarget.push({ sessionID: 'fresh-a', lastAttempt: 10.5 * MINUTE }, { sessionID: 'fresh-b', lastAttempt: 10.8 * MINUTE });
    ctx.sessions['fresh-a'] = { model: { providerID: 'opencode-route', id: 'busy' } };
    ctx.sessions['fresh-b'] = { model: { providerID: 'opencode-route', id: 'busy' } };
    const [move] = await ctx.rotation.tick();
    expect(move).toMatchObject({ sessionID: 'fresh-a' });
  });

  it('a call that never answers does not stop the tick or later ticks', async () => {
    const onTarget = [
      { sessionID: 'primary-old', lastAttempt: 1 * MINUTE },
      { sessionID: 'primary-new', lastAttempt: 5 * MINUTE },
      { sessionID: 'sub', lastAttempt: 9.5 * MINUTE },
    ];
    const ctx = setup({
      onTarget,
      callTimeoutMs: 20,
      switchModel: (sessionID, model) => {
        if (sessionID === 'sub') return new Promise(() => {});
        ctx.switches.push({ sessionID, model });
        ctx.sessions[sessionID] = { ...ctx.sessions[sessionID], model };
        return Promise.resolve();
      },
    });
    const [first] = await ctx.rotation.tick();
    expect(first).toMatchObject({ sessionID: 'primary-old' });
    ctx.clock.now += 5 * MINUTE;
    // The stuck subagent kept sending, so primary-new is not the last live session on the target.
    onTarget[2].lastAttempt = ctx.clock.now - 30_000;
    const [second] = await ctx.rotation.tick();
    expect(second).toMatchObject({ sessionID: 'primary-new' });
  });

  it('never moves a session onto a target whose latest request failed', async () => {
    const now = 10 * MINUTE;
    const { rotation, switches } = setup({
      reliability: [{ providerID: 'anthropic', modelID: 'b', attempts: 3, failures: 2, lastSuccess: now - 5 * MINUTE, lastFailure: now - 1 * MINUTE }],
    });
    expect(await rotation.tick()).toEqual([]);
    expect(switches).toEqual([]);
  });

  it('keeps the last session on a target even when the health count is stale', async () => {
    const { rotation, switches } = setup({
      targets: [target('openai/a', 3, 'plan-a', 0.9), target('anthropic/b', 0, 'plan-b', 0.2)],
      onTarget: [{ sessionID: 'primary-old', lastAttempt: 1 * MINUTE }],
    });
    expect(await rotation.tick()).toEqual([]);
    expect(switches).toEqual([]);
  });

  it('moves a running subagent first even when its last request is minutes old', async () => {
    // A subagent can sit in one long tool call; OpenCode still lists it as running.
    const { rotation, switches } = setup({
      onTarget: [
        { sessionID: 'primary-old', lastAttempt: 1 * MINUTE },
        { sessionID: 'primary-new', lastAttempt: 5 * MINUTE },
        { sessionID: 'sub', lastAttempt: 4 * MINUTE },
      ],
    });
    await rotation.tick();
    expect(switches.map(({ sessionID }) => sessionID)).toEqual(['sub']);
  });

  it('moves no subagent when the running list cannot be read', async () => {
    const { rotation, switches } = setup({ activeFails: true });
    await rotation.tick();
    expect(switches.map(({ sessionID }) => sessionID)).toEqual(['primary-old']);
  });

  it('never moves a session onto a target past its until', async () => {
    const { rotation, switches } = setup({ rawTargets: ['openai/a', { model: 'anthropic/b', until: 10 * MINUTE - 1 }] });
    expect(await rotation.tick()).toEqual([]);
    expect(switches).toEqual([]);
  });

  it('moves a session only to a target its own project keeps in the pool', async () => {
    const inProject = (model) => ({ model, location: { directory: '/p' } });
    const pool = { providerID: 'opencode-route', id: 'busy' };
    const { rotation, switches } = setup({
      // The project overrides the pool: anthropic/b is not in it.
      projectRoutes: { busy: { targets: ['openai/a', 'other/c'] } },
      sessions: {
        'primary-old': inProject(pool),
        'primary-new': { model: pool },
        sub: { ...inProject(pool), parentID: 'primary-old' },
      },
    });
    await rotation.tick();
    expect(switches.map(({ sessionID }) => sessionID)).toEqual(['primary-new']);
  });

  it('leaves a session whose model changed while the others were being read', async () => {
    const pool = { providerID: 'opencode-route', id: 'busy' };
    const reads = new Map();
    const sessions = {
      'primary-old': { model: pool },
      'primary-new': { model: pool },
      sub: { parentID: 'primary-old', model: pool },
    };
    const { rotation, switches } = setup({
      sessions,
      // The second read of 'sub', just before the switch, finds the user's own pick.
      getSession: async (sessionID) => {
        const count = (reads.get(sessionID) ?? 0) + 1;
        reads.set(sessionID, count);
        return sessionID === 'sub' && count > 1 ? { ...sessions.sub, model: { providerID: 'openai', id: 'a' } } : sessions[sessionID];
      },
    });
    await rotation.tick();
    expect(switches.map(({ sessionID }) => sessionID)).toEqual(['primary-old']);
  });

  it('moves nothing once rotation is turned off while a tick reads sessions', async () => {
    const pool = { providerID: 'opencode-route', id: 'busy' };
    const sessions = {
      'primary-old': { model: pool },
      'primary-new': { model: pool },
      sub: { parentID: 'primary-old', model: pool },
    };
    let data = '';
    const ctx = setup({
      sessions,
      // The user turns rotation off while the tick is reading the sessions.
      getSession: async (sessionID) => {
        fs.writeFileSync(path.join(data, 'pool-rotation.json'), JSON.stringify({ enabled: false, intervalMinutes: 5 }));
        return sessions[sessionID];
      },
    });
    data = ctx.data;
    expect(await ctx.rotation.tick()).toEqual([]);
    expect(ctx.switches).toEqual([]);
  });

  it('skips a destination whose until has passed in the session project pool', async () => {
    const pool = { providerID: 'opencode-route', id: 'busy' };
    const inProject = { model: pool, location: { directory: '/p' } };
    const { rotation, switches } = setup({
      projectRoutes: { busy: { targets: ['openai/a', { model: 'anthropic/b', until: 10 * MINUTE - 1 }] } },
      sessions: { 'primary-old': inProject, 'primary-new': inProject, sub: { ...inProject, parentID: 'x' } },
    });
    expect(await rotation.tick()).toEqual([]);
    expect(switches).toEqual([]);
  });

  it('moves a session to the best destination its own project keeps, not only the best overall', async () => {
    const pool = { providerID: 'opencode-route', id: 'busy' };
    const inProject = { model: pool, location: { directory: '/p' } };
    const { rotation, switches } = setup({
      targets: [target('openai/a', 3, 'plan-a', 0.9), target('anthropic/b', 0, 'plan-b', 0.1), target('other/c', 0, 'plan-c', 0.3)],
      rawTargets: ['openai/a', 'anthropic/b', 'other/c'],
      // The project's pool has no anthropic/b, the best overall; other/c is next.
      projectRoutes: { busy: { targets: ['openai/a', 'other/c'] } },
      sessions: { 'primary-old': inProject, 'primary-new': inProject, sub: { ...inProject, parentID: 'x' } },
    });
    await rotation.tick();
    expect(switches).toEqual([{ sessionID: 'sub', model: { providerID: 'other', id: 'c' } }]);
  });

  it('moves to the variant the session project lists, not the global one', async () => {
    const pool = { providerID: 'opencode-route', id: 'busy' };
    const inProject = { model: pool, location: { directory: '/p' } };
    const { rotation, switches } = setup({
      // Globally the pool lists anthropic/b#high; this project lists #low.
      projectRoutes: { busy: { targets: ['openai/a', 'anthropic/b#low'] } },
      sessions: { 'primary-old': inProject, 'primary-new': inProject, sub: { ...inProject, parentID: 'x' } },
    });
    await rotation.tick();
    expect(switches).toEqual([{ sessionID: 'sub', model: { providerID: 'anthropic', id: 'b', variant: 'low' } }]);
  });

  it('keeps a model the user picked for the chosen session while the others were read', async () => {
    const pool = { providerID: 'opencode-route', id: 'busy' };
    const sessions = {
      'primary-old': { model: pool },
      'primary-new': { model: pool },
      sub: { parentID: 'primary-old', model: pool },
    };
    const reads = new Map();
    const { rotation, switches } = setup({
      sessions,
      // The second read of primary-old is the check that another session is
      // still on the target; the user picks a model for sub during it.
      getSession: async (sessionID) => {
        const count = (reads.get(sessionID) ?? 0) + 1;
        reads.set(sessionID, count);
        if (sessionID === 'primary-old' && count === 2) sessions.sub = { parentID: 'primary-old', model: { providerID: 'openai', id: 'a' } };
        return sessions[sessionID];
      },
    });
    await rotation.tick();
    expect(switches.map(({ sessionID }) => sessionID)).not.toContain('sub');
  });

  it('does not move the last session when the others left while it was being read', async () => {
    const pool = { providerID: 'opencode-route', id: 'busy' };
    const reads = new Map();
    const sessions = { 'primary-old': { model: pool }, 'primary-new': { model: pool } };
    const { rotation, switches } = setup({
      active: new Set(),
      onTarget: [
        { sessionID: 'primary-old', lastAttempt: 1 * MINUTE },
        { sessionID: 'primary-new', lastAttempt: 5 * MINUTE },
      ],
      sessions,
      // primary-new moves off the pool after its first read.
      getSession: async (sessionID) => {
        const count = (reads.get(sessionID) ?? 0) + 1;
        reads.set(sessionID, count);
        return sessionID === 'primary-new' && count > 1 ? { model: { providerID: 'openai', id: 'a' } } : sessions[sessionID];
      },
    });
    expect(await rotation.tick()).toEqual([]);
    expect(switches).toEqual([]);
  });

  it('does not spend a move on a subagent that has finished', async () => {
    // OpenCode no longer lists it as running, however recent its last request.
    const { rotation, switches } = setup({
      active: new Set(),
      onTarget: [
        { sessionID: 'primary-old', lastAttempt: 1 * MINUTE },
        { sessionID: 'primary-new', lastAttempt: 5 * MINUTE },
        { sessionID: 'sub', lastAttempt: 9.9 * MINUTE },
      ],
    });
    await rotation.tick();
    expect(switches.map(({ sessionID }) => sessionID)).toEqual(['primary-old']);
  });

  it('keeps the pace when the clock moves during a tick', async () => {
    const ctx = setup({
      intervalMinutes: 5,
      onTarget: [
        { sessionID: 'primary-old', lastAttempt: 1 * MINUTE },
        { sessionID: 'primary-new', lastAttempt: 5 * MINUTE },
        { sessionID: 'third', lastAttempt: 6 * MINUTE },
      ],
      sessions: {
        'primary-old': { model: { providerID: 'opencode-route', id: 'busy' } },
        'primary-new': { model: { providerID: 'opencode-route', id: 'busy' } },
        third: { model: { providerID: 'opencode-route', id: 'busy' } },
      },
      switchModel: async (sessionID, model) => {
        ctx.clock.now += 1000;
        ctx.switches.push({ sessionID, model });
        ctx.sessions[sessionID] = { ...ctx.sessions[sessionID], model };
      },
    });
    await ctx.rotation.tick();
    ctx.clock.now = 10 * MINUTE + 5 * MINUTE;
    await ctx.rotation.tick();
    expect(ctx.switches.map(({ sessionID }) => sessionID)).toEqual(['primary-old', 'primary-new']);
  });

  it('refuses invalid settings and a damaged settings file', () => {
    const { rotation, data } = setup();
    expect(() => rotation.updateSettings({ intervalMinutes: 0 })).toThrow('whole number from 1 to 60');
    expect(() => rotation.updateSettings({ enabled: 'yes' })).toThrow();
    expect(rotation.updateSettings({ intervalMinutes: 10 })).toEqual({ enabled: true, intervalMinutes: 10 });
    fs.writeFileSync(path.join(data, 'pool-rotation.json'), '{ broken');
    expect(() => readRotationSettings(data)).toThrow(/not valid JSON/);
    // A root that is not an object is malformed too, not the defaults.
    for (const root of ['null', '[]', '5']) {
      fs.writeFileSync(path.join(data, 'pool-rotation.json'), root);
      expect(() => readRotationSettings(data)).toThrow(/does not match/);
    }
  });
});

describe('pickDestination and orderForMove', () => {
  it('prefers a target with a recent success, then the most headroom', () => {
    const health = { targets: [target('openai/a', 3, 'plan-a', 0.9), target('y/quiet', 0, 'plan-y', 0.1), target('z/proven', 0, 'plan-z', 0.5)] };
    const reliability = new Map([['z/proven', { failures: 0, lastSuccess: 5, lastFailure: null }]]);
    expect(pickDestination(health, ['openai/a', 'y/quiet', 'z/proven'], health.targets[0], reliability).ref).toBe('z/proven');
  });

  it('prefers a linked target with the most headroom over an unlinked one', () => {
    const health = { targets: [target('openai/a', 3, 'plan-a', 0.9), target('x/unlinked', 0), target('y/linked', 0, 'plan-y', 0.3), target('z/linked', 0, 'plan-z', 0.1)] };
    expect(pickDestination(health, ['openai/a', 'x/unlinked', 'y/linked', 'z/linked'], health.targets[0]).ref).toBe('z/linked');
  });

  it('skips patterns and nested pools as destinations', () => {
    const health = { targets: [target('openai/a', 3, 'plan-a', 0.9), target('openai/*', 0), target('opencode-route/other', 0)] };
    expect(pickDestination(health, ['openai/a', 'openai/*', 'opencode-route/other'], health.targets[0])).toBeNull();
  });

  it('orders subagents first, then by oldest last request', () => {
    const ordered = orderForMove([
      { sessionID: 'p2', subagent: false, lastAttempt: 5 },
      { sessionID: 's1', subagent: true, lastAttempt: 9 },
      { sessionID: 'p1', subagent: false, lastAttempt: 1 },
    ]);
    expect(ordered.map(({ sessionID }) => sessionID)).toEqual(['s1', 'p1', 'p2']);
  });
});

describe('querySessionsOnTarget', () => {
  it('returns sessions whose latest attempt in the route is on the target', async () => {
    const dbPath = path.join(dir(), 'opencode.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`create table route_attempt (time_started integer, session_id text, route_id text, provider_id text, model_id text)`);
    const insert = db.prepare('insert into route_attempt values (?, ?, ?, ?, ?)');
    const now = Date.now();
    insert.run(now - 3 * MINUTE, 'stays', 'busy', 'openai', 'a');
    insert.run(now - 4 * MINUTE, 'moved', 'busy', 'openai', 'a');
    insert.run(now - 1 * MINUTE, 'moved', 'busy', 'anthropic', 'b');
    insert.run(now - 2 * MINUTE, 'other-route', 'calm', 'openai', 'a');
    insert.run(now - 60 * MINUTE, 'stale', 'busy', 'openai', 'a');
    db.close();
    const rows = await querySessionsOnTarget(dbPath, { routeID: 'busy', ref: 'openai/a', minutes: 15, now });
    expect(rows).toEqual([{ sessionID: 'stays', lastAttempt: now - 3 * MINUTE }]);
    // A pattern source covers the concrete models OpenCode recorded under it.
    const covered = await querySessionsOnTarget(dbPath, { routeID: 'busy', ref: 'openai/*', minutes: 15, now });
    expect(covered).toEqual([{ sessionID: 'stays', lastAttempt: now - 3 * MINUTE }]);
  });
});

describe('queryTargetReliability', () => {
  it('reports attempts, failures and the latest success and failure per target in the window', async () => {
    const dbPath = path.join(dir(), 'opencode.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`create table route_attempt (time_started integer, provider_id text, model_id text, outcome text)`);
    const insert = db.prepare('insert into route_attempt values (?, ?, ?, ?)');
    const now = Date.now();
    insert.run(now - 5 * MINUTE, 'anthropic', 'b', 'success');
    insert.run(now - 2 * MINUTE, 'anthropic', 'b', 'failure');
    insert.run(now - 1 * MINUTE, 'anthropic', 'b', 'timeout');
    insert.run(now - 60 * MINUTE, 'anthropic', 'b', 'success');
    insert.run(now - 3 * MINUTE, 'openai', 'a', 'success');
    db.close();
    const rows = await queryTargetReliability(dbPath, { minutes: 15, now });
    expect(rows.find((row) => row.providerID === 'anthropic')).toEqual({
      providerID: 'anthropic', modelID: 'b', attempts: 3, failures: 2, lastSuccess: now - 5 * MINUTE, lastFailure: now - 1 * MINUTE,
    });
    expect(rows.find((row) => row.providerID === 'openai')).toMatchObject({ failures: 0, lastFailure: null });
  });
});

describe('rotation routes', () => {
  it('reads and saves the settings', async () => {
    const { rotation } = setup({ enabled: false });
    const app = express();
    registerPoolRotationRoutes(app, rotation);
    expect((await request(app).get('/api/model-routes/rotation')).body).toEqual({ settings: { enabled: false, intervalMinutes: 5 }, moves: [] });
    const saved = await request(app).put('/api/model-routes/rotation').send({ enabled: true });
    expect(saved.body.settings).toEqual({ enabled: true, intervalMinutes: 5 });
    expect((await request(app).put('/api/model-routes/rotation').send({ intervalMinutes: 99 })).status).toBe(400);
  });
});
