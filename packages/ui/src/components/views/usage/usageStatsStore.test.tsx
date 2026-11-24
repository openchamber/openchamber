import { describe, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import type { UsageStats, UsageTokens, UsageTools } from '@/lib/opencode/session-stats';

import {
  createUsageStatsStore,
  usageStatsKey,
  usageTokenKey,
  useTodayRollover,
  type UsageStatsRequest,
  type UsageTokenBucket,
} from './usageStatsStore';

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

type PendingToken = {
  bucket: UsageTokenBucket;
  projectID: string | undefined;
  signal: AbortSignal;
  settled: boolean;
  resolve: (tokens: UsageTokens) => void;
  reject: (error: Error) => void;
};

function setup(initialNow = 1000) {
  let clock = initialNow;
  const pending: Pending[] = [];
  const pendingTools: PendingTools[] = [];
  const pendingTokens: PendingToken[] = [];
  const projectLookups: string[] = [];
  const tokenReads = { active: 0, maxActive: 0 };
  let runtime = 'runtime-a';
  const store = createUsageStatsStore(
    (request) => new Promise<UsageStats>((resolve, reject) => pending.push({ request, resolve, reject })),
    () => runtime,
    () => clock,
    (request, window) => new Promise<UsageTools>((resolve, reject) => pendingTools.push({ request, window, resolve, reject })),
    (bucket, projectID, signal) => new Promise<UsageTokens>((resolve, reject) => {
      tokenReads.active += 1;
      tokenReads.maxActive = Math.max(tokenReads.maxActive, tokenReads.active);
      // SAFETY: every field is assigned before the record is pushed.
      const record = {} as PendingToken;
      record.bucket = bucket;
      record.projectID = projectID;
      record.signal = signal;
      record.settled = false;
      record.resolve = (tokens: UsageTokens) => {
        record.settled = true;
        tokenReads.active -= 1;
        resolve(tokens);
      };
      record.reject = (error: Error) => {
        record.settled = true;
        tokenReads.active -= 1;
        reject(error);
      };
      pendingTokens.push(record);
    }),
    async (directory) => {
      projectLookups.push(directory);
      return 'project-1';
    },
  );
  return {
    store,
    pending,
    pendingTools,
    pendingTokens,
    projectLookups,
    tokenReads,
    setRuntime: (next: string) => { runtime = next; },
    setNow: (next: number) => { clock = next; },
  };
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

describe('today across local midnight', () => {
  const TODAY: UsageStatsRequest = { range: '1d', projectDirectory: null };
  const lateEvening = new Date(2026, 10, 7, 23, 59).getTime();
  const afterMidnight = new Date(2026, 10, 8, 0, 1).getTime();

  const loadedToday = async () => {
    const ctx = setup(lateEvening);
    const read = ctx.store.getState().load(TODAY);
    ctx.pending[0].resolve(report(3));
    await read;
    return ctx;
  };

  test('stays cached within the day', async () => {
    const ctx = await loadedToday();
    ctx.setNow(lateEvening + 30_000);
    await ctx.store.getState().load(TODAY);
    expect(ctx.pending).toHaveLength(1);
  });

  test('a report from before midnight leaves the screen and is read again', async () => {
    const ctx = await loadedToday();
    ctx.setNow(afterMidnight);
    const read = ctx.store.getState().load(TODAY);
    expect(ctx.pending).toHaveLength(2);
    expect(entry(ctx, TODAY)).toEqual({ stats: null, fetchedAt: null, loading: true, error: null });

    ctx.pending[1].resolve(report(1));
    await read;
    expect(entry(ctx, TODAY)).toEqual({ stats: report(1), fetchedAt: afterMidnight, loading: false, error: null });

    await ctx.store.getState().load(TODAY);
    expect(ctx.pending).toHaveLength(2);
  });

  test('a failed read after midnight is an error and never yesterday\'s totals', async () => {
    const ctx = await loadedToday();
    ctx.setNow(afterMidnight);
    const read = ctx.store.getState().load(TODAY);
    ctx.pending[1].reject(new Error('offline'));
    await read;
    expect(entry(ctx, TODAY)).toEqual({ stats: null, fetchedAt: null, loading: false, error: 'offline' });

    await ctx.store.getState().load(TODAY);
    expect(ctx.pending).toHaveLength(2);
  });

  test('a failed forced refresh after midnight does not keep yesterday either', async () => {
    const ctx = await loadedToday();
    ctx.setNow(afterMidnight);
    const read = ctx.store.getState().load(TODAY, { force: true });
    ctx.pending[1].reject(new Error('offline'));
    await read;
    expect(entry(ctx, TODAY)?.stats).toBeNull();
  });

  test('a read that crosses midnight counts as the day it started', async () => {
    const ctx = setup(lateEvening);
    const read = ctx.store.getState().load(TODAY);
    ctx.setNow(afterMidnight);
    ctx.pending[0].resolve(report(3));
    await read;

    void ctx.store.getState().load(TODAY);
    expect(ctx.pending).toHaveLength(2);
    expect(entry(ctx, TODAY)?.stats).toBeNull();
  });

  test('tool calls of the old day go with its report', async () => {
    const ctx = await loadedToday();
    const tools = ctx.store.getState().loadTools(TODAY);
    ctx.pendingTools[0].resolve(toolCalls(7));
    await tools;

    ctx.setNow(afterMidnight);
    const read = ctx.store.getState().load(TODAY);
    expect(ctx.store.getState().toolEntries[usageStatsKey('runtime-a', TODAY)]).toBeUndefined();
    ctx.pending[1].resolve({ ...report(1), range: { from: 300, to: 400 } });
    await read;
    expect(ctx.pendingTools[1].window).toEqual({ from: 300, to: 400 });
  });

  test('a tool read of the old day that finishes last leaves the new day\'s tool calls', async () => {
    const ctx = await loadedToday();
    const oldTools = ctx.store.getState().loadTools(TODAY);

    ctx.setNow(afterMidnight);
    const read = ctx.store.getState().load(TODAY);
    ctx.pending[1].resolve(report(1));
    await read;
    ctx.pendingTools[1].resolve(toolCalls(1));
    await Promise.resolve();
    await Promise.resolve();

    ctx.pendingTools[0].resolve(toolCalls(999));
    await oldTools;
    expect(ctx.store.getState().toolEntries[usageStatsKey('runtime-a', TODAY)]).toEqual({ tools: toolCalls(1), loading: false, error: null });
  });

  test('a tool read of the old day that fails does not block the new day\'s tool calls', async () => {
    const ctx = await loadedToday();
    const oldTools = ctx.store.getState().loadTools(TODAY);

    ctx.setNow(afterMidnight);
    const read = ctx.store.getState().load(TODAY);
    ctx.pendingTools[0].reject(new Error('offline'));
    await oldTools;
    expect(ctx.store.getState().toolEntries[usageStatsKey('runtime-a', TODAY)]).toBeUndefined();

    ctx.pending[1].resolve(report(1));
    await read;
    expect(ctx.pendingTools).toHaveLength(2);
  });

  test('other ranges keep their report after midnight', async () => {
    const ctx = setup(lateEvening);
    const read = ctx.store.getState().load(A);
    ctx.pending[0].resolve(report(3));
    await read;

    ctx.setNow(afterMidnight);
    await ctx.store.getState().load(A);
    expect(ctx.pending).toHaveLength(1);
    expect(entry(ctx, A)?.stats).toEqual(report(3));
  });

  test('an open Today page checks every minute and when it becomes visible', async () => {
    const dom = new Window({ url: 'http://localhost' });
    const globals = { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true };
    const originals = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    jest.useFakeTimers();
    const root = createRoot(document.createElement('div'));
    let checks = 0;
    const load = () => { checks += 1; };
    const Page = ({ enabled }: { enabled: boolean }) => { useTodayRollover(enabled, load); return null; };
    const becomeVisible = () => dom.document.dispatchEvent(new dom.Event('visibilitychange'));
    try {
      await act(async () => root.render(<Page enabled={false} />));
      jest.advanceTimersByTime(60_000);
      becomeVisible();
      expect(checks).toBe(0);

      await act(async () => root.render(<Page enabled />));
      jest.advanceTimersByTime(60_000);
      expect(checks).toBe(1);
      becomeVisible();
      expect(checks).toBe(2);

      await act(async () => root.render(<Page enabled={false} />));
      jest.advanceTimersByTime(60_000);
      becomeVisible();
      expect(checks).toBe(2);
    } finally {
      await act(async () => root.unmount());
      jest.useRealTimers();
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
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

describe('activity tokens on request', () => {
  const tokens = (input: number, output: number, cacheRead: number): UsageTokens => ({
    input,
    output,
    reasoning: 0,
    cacheRead,
    cacheWrite: 0,
    total: input + output + cacheRead,
  });
  const first: UsageTokenBucket = { from: 100, to: 200 };
  const second: UsageTokenBucket = { from: 200, to: 300 };
  const tokenEntry = (
    ctx: ReturnType<typeof setup>,
    bucket: UsageTokenBucket,
    projectDirectory: string | null = null,
  ) => ctx.store.getState().tokenEntries[usageTokenKey('runtime-a', projectDirectory, bucket)];

  const drain = async (ctx: ReturnType<typeof setup>) => {
    while (ctx.pendingTokens.some((entry) => !entry.settled)) {
      const next = ctx.pendingTokens.find((entry) => !entry.settled)!;
      next.resolve(tokens(1, 0, 0));
      await Promise.resolve();
      await Promise.resolve();
    }
  };

  test('reads each bucket once and serves the cache', async () => {
    const ctx = setup();
    const read = ctx.store.getState().loadTokens([first, second], null);
    expect(ctx.pendingTokens).toHaveLength(2);
    expect(tokenEntry(ctx, first)).toEqual({ tokens: null, loading: true, error: null });

    ctx.pendingTokens[0].resolve(tokens(10, 2, 5));
    ctx.pendingTokens[1].resolve(tokens(1, 0, 0));
    await read;
    expect(tokenEntry(ctx, first)).toEqual({ tokens: tokens(10, 2, 5), loading: false, error: null });
    expect(tokenEntry(ctx, second)).toEqual({ tokens: tokens(1, 0, 0), loading: false, error: null });

    await ctx.store.getState().loadTokens([first, second], null);
    expect(ctx.pendingTokens).toHaveLength(2);
  });

  test('runs four bucket reads at once and fills each bar as it arrives', async () => {
    const ctx = setup();
    const buckets = Array.from({ length: 10 }, (_, index) => ({ from: index * 100, to: (index + 1) * 100 }));
    const read = ctx.store.getState().loadTokens(buckets, null);
    expect(ctx.pendingTokens).toHaveLength(4);
    expect(ctx.tokenReads.maxActive).toBe(4);
    expect(tokenEntry(ctx, buckets[0])?.loading).toBe(true);

    ctx.pendingTokens[0].resolve(tokens(3, 0, 0));
    await Promise.resolve();
    await Promise.resolve();
    expect(tokenEntry(ctx, buckets[0])).toEqual({ tokens: tokens(3, 0, 0), loading: false, error: null });
    expect(tokenEntry(ctx, buckets[4])?.loading).toBe(true);

    await drain(ctx);
    await read;
    expect(ctx.tokenReads.maxActive).toBe(4);
    expect(ctx.tokenReads.active).toBe(0);
    expect(tokenEntry(ctx, buckets[0])?.tokens?.total).toBe(3);
    expect(buckets.slice(1).every((bucket) => tokenEntry(ctx, bucket)?.tokens?.total === 1)).toBe(true);
  });

  test('a failed bucket stays an error and never becomes zero tokens', async () => {
    const ctx = setup();
    const read = ctx.store.getState().loadTokens([first], null);
    ctx.pendingTokens[0].reject(new Error('offline'));
    await read;
    expect(tokenEntry(ctx, first)).toEqual({ tokens: null, loading: false, error: 'offline' });

    await ctx.store.getState().loadTokens([first], null);
    expect(ctx.pendingTokens).toHaveLength(1);
  });

  test('resolves the project once for the whole batch', async () => {
    const ctx = setup();
    const read = ctx.store.getState().loadTokens([first, second], '/code/app');
    await Promise.resolve();
    expect(ctx.projectLookups).toEqual(['/code/app']);
    expect(ctx.pendingTokens).toHaveLength(2);
    expect(ctx.pendingTokens.map((entry) => entry.projectID)).toEqual(['project-1', 'project-1']);
    ctx.pendingTokens[0].resolve(tokens(1, 0, 0));
    ctx.pendingTokens[1].resolve(tokens(2, 0, 0));
    await read;
    expect(tokenEntry(ctx, first, '/code/app')?.tokens).toEqual(tokens(1, 0, 0));
    expect(tokenEntry(ctx, first)).toBeUndefined();
  });

  test('a new batch drops the old batch results', async () => {
    const ctx = setup();
    const oldRead = ctx.store.getState().loadTokens([first], null);
    const newRead = ctx.store.getState().loadTokens([second], null);
    expect(ctx.pendingTokens[0].signal.aborted).toBe(true);
    expect(ctx.pendingTokens).toHaveLength(2);

    ctx.pendingTokens[0].resolve(tokens(999, 0, 0));
    await oldRead;
    expect(tokenEntry(ctx, first)?.tokens).toBeNull();

    ctx.pendingTokens[1].resolve(tokens(2, 0, 0));
    await newRead;
    expect(tokenEntry(ctx, second)?.tokens).toEqual(tokens(2, 0, 0));
  });

  test('a report refresh drops the token cache and asks the chart to load again', async () => {
    const ctx = setup();
    const read = ctx.store.getState().loadTokens([first], null);
    ctx.pendingTokens[0].resolve(tokens(1, 0, 0));
    await read;
    expect(tokenEntry(ctx, first)?.tokens).toEqual(tokens(1, 0, 0));

    const refresh = ctx.store.getState().load(A, { force: true });
    expect(ctx.store.getState().tokenEntries).toEqual({});
    expect(ctx.store.getState().tokenVersion).toBe(1);
    ctx.pending[0].resolve(report(3));
    await refresh;
  });

  test('reset drops token buckets and reads in flight', async () => {
    const ctx = setup();
    const read = ctx.store.getState().loadTokens([first], null);
    ctx.store.getState().reset();
    ctx.pendingTokens[0].resolve(tokens(1, 0, 0));
    await read;
    expect(ctx.store.getState().tokenEntries).toEqual({});
  });
});
