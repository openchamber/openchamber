import { describe, expect, test } from 'bun:test';

import type { UsageStats, UsageTools } from '@/lib/opencode/session-stats';

import { createUsageStatsStore, usageStatsKey, type UsageStatsRequest } from './usageStatsStore';

const toolCalls = (calls: number): UsageTools => ({ mode: 'detail', totals: { calls, succeeded: calls, failed: 0, unfinished: 0 }, usage: [] });

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

type PendingTools = {
  request: UsageStatsRequest;
  window: UsageStats['range'];
  resolve: (tools: UsageTools) => void;
  reject: (error: Error) => void;
};

function setup() {
  const pending: Pending[] = [];
  const pendingTools: PendingTools[] = [];
  let runtime = 'runtime-a';
  const store = createUsageStatsStore(
    (request) => new Promise<UsageStats>((resolve, reject) => pending.push({ request, resolve, reject })),
    () => runtime,
    () => 1000,
    (request, window) => new Promise<UsageTools>((resolve, reject) => pendingTools.push({ request, window, resolve, reject })),
  );
  return { store, pending, pendingTools, setRuntime: (next: string) => { runtime = next; } };
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

describe('tool calls on request', () => {
  const tools = (ctx: ReturnType<typeof setup>, request: UsageStatsRequest) =>
    ctx.store.getState().toolEntries[usageStatsKey('runtime-a', request)];

  const loaded = async (ctx: ReturnType<typeof setup>, request: UsageStatsRequest, stats: UsageStats) => {
    const read = ctx.store.getState().load(request);
    ctx.pending.at(-1)!.resolve(stats);
    await read;
  };

  test('the report alone never asks for tool calls', async () => {
    const ctx = setup();
    await loaded(ctx, A, report(3));
    expect(ctx.pendingTools).toHaveLength(0);
  });

  test('counts tool calls over the window of the report on screen', async () => {
    const ctx = setup();
    await loaded(ctx, A, { ...report(3), range: { from: 100, to: 200 } });
    const read = ctx.store.getState().loadTools(A);
    expect(ctx.pendingTools[0].window).toEqual({ from: 100, to: 200 });
    ctx.pendingTools[0].resolve(toolCalls(7));
    await read;
    expect(tools(ctx, A)).toEqual({ tools: toolCalls(7), loading: false, error: null });
  });

  test('a failed read keeps the report and never becomes zero calls', async () => {
    const ctx = setup();
    await loaded(ctx, A, report(3));
    const read = ctx.store.getState().loadTools(A);
    ctx.pendingTools[0].reject(new Error('scan failed'));
    await read;
    expect(tools(ctx, A)).toEqual({ tools: null, loading: false, error: 'scan failed' });
    expect(entry(ctx, A)?.stats).toEqual(report(3));
    expect(entry(ctx, A)?.error).toBeNull();
  });

  test('once asked for, a refreshed report brings fresh tool calls for its new window', async () => {
    const ctx = setup();
    await loaded(ctx, A, report(3));
    const first = ctx.store.getState().loadTools(A);
    ctx.pendingTools[0].resolve(toolCalls(1));
    await first;

    const refresh = ctx.store.getState().load(A, { force: true });
    ctx.pending[1].resolve({ ...report(4), range: { from: 300, to: 400 } });
    await refresh;
    expect(ctx.pendingTools).toHaveLength(2);
    expect(ctx.pendingTools[1].window).toEqual({ from: 300, to: 400 });
  });

  test('a runtime switch drops tool reads in flight', async () => {
    const ctx = setup();
    await loaded(ctx, A, report(3));
    const read = ctx.store.getState().loadTools(A);
    ctx.store.getState().reset();
    ctx.pendingTools[0].resolve(toolCalls(5));
    await read;
    expect(ctx.store.getState().toolEntries).toEqual({});
  });
});
