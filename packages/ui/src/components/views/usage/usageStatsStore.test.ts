import { describe, expect, test } from 'bun:test';

import type { UsageStats } from '@/lib/opencode/session-stats';

import { createUsageStatsStore, usageStatsKey, type UsageStatsRequest } from './usageStatsStore';

const report = (prompts: number): UsageStats => ({
  range: { from: 0, to: 1 },
  sessions: 1,
  subagents: 0,
  prompts,
  steps: prompts,
  tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0,
  tools: { mode: 'none' },
  activeDays: 1,
  streak: 1,
  activity: [],
  models: [],
});

type Pending = { request: UsageStatsRequest; resolve: (stats: UsageStats) => void; reject: (error: Error) => void };

function setup() {
  const pending: Pending[] = [];
  let runtime = 'runtime-a';
  const store = createUsageStatsStore(
    (request) => new Promise<UsageStats>((resolve, reject) => pending.push({ request, resolve, reject })),
    () => runtime,
    () => 1000,
  );
  return { store, pending, setRuntime: (next: string) => { runtime = next; } };
}

const A: UsageStatsRequest = { range: '7d', projectDirectory: null };
const B: UsageStatsRequest = { range: '30d', projectDirectory: '/code/app' };
const entry = (ctx: ReturnType<typeof setup>, request: UsageStatsRequest, runtime = 'runtime-a') =>
  ctx.store.getState().entries[usageStatsKey(runtime, request)];

describe('usage stats cache', () => {
  test('keys by runtime, range and project', () => {
    expect(usageStatsKey('r', A)).not.toBe(usageStatsKey('r', { ...A, range: '30d' }));
    expect(usageStatsKey('r', A)).not.toBe(usageStatsKey('r', { ...A, projectDirectory: '/x' }));
    expect(usageStatsKey('r', A)).not.toBe(usageStatsKey('s', A));
  });

  test('fetches a key once and serves it from cache until forced', async () => {
    const ctx = setup();
    const first = ctx.store.getState().load(A);
    ctx.pending[0].resolve(report(3));
    await first;
    expect(entry(ctx, A)).toEqual({ stats: report(3), fetchedAt: 1000, loading: false, error: null });

    await ctx.store.getState().load(A);
    expect(ctx.pending).toHaveLength(1);

    void ctx.store.getState().load(A, { force: true });
    expect(ctx.pending).toHaveLength(2);
    expect(entry(ctx, A)?.stats).toEqual(report(3));
    expect(entry(ctx, A)?.loading).toBe(true);
  });

  test('a failed refresh keeps the cached report', async () => {
    const ctx = setup();
    const first = ctx.store.getState().load(A);
    ctx.pending[0].resolve(report(3));
    await first;
    const refresh = ctx.store.getState().load(A, { force: true });
    ctx.pending[1].reject(new Error('offline'));
    await refresh;
    expect(entry(ctx, A)).toEqual({ stats: report(3), fetchedAt: 1000, loading: false, error: 'offline' });
  });

  test('a read that finishes after switching filters lands on its own key only', async () => {
    const ctx = setup();
    const a = ctx.store.getState().load(A);
    const b = ctx.store.getState().load(B);
    ctx.pending[1].resolve(report(2));
    await b;
    ctx.pending[0].resolve(report(9));
    await a;
    expect(entry(ctx, A)?.stats).toEqual(report(9));
    expect(entry(ctx, B)?.stats).toEqual(report(2));
  });

  test('a runtime switch clears the cache and drops reads in flight', async () => {
    const ctx = setup();
    const a = ctx.store.getState().load(A);
    ctx.store.getState().reset();
    ctx.setRuntime('runtime-b');
    ctx.pending[0].resolve(report(9));
    await a;
    expect(ctx.store.getState().entries).toEqual({});
  });
});
