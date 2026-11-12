import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  getStreamPerfSnapshot,
  setStreamPerfEnabled,
  setStreamPerfMemoryDebugEnabled,
  streamPerfCount,
} from './streamDebug';

class TestStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const originalWindow = globalThis.window;
const metric = 'ui.session_sidebar.render';
const expectedEntry = {
  metric,
  count: 1,
  avg: 1,
  max: 1,
  total: 1,
  last: 1,
};

const expectCounterEnabled = (): void => {
  const snapshot = getStreamPerfSnapshot();
  expect(snapshot.enabled).toBe(true);
  expect(snapshot.entries).toEqual([expectedEntry]);
};

beforeEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: new TestStorage() },
  });
  setStreamPerfMemoryDebugEnabled(false);
  setStreamPerfEnabled(false);
});

afterAll(() => {
  setStreamPerfMemoryDebugEnabled(false);
  setStreamPerfEnabled(false);
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
});

describe('stream performance activation', () => {
  test('does not create counter state while disabled', () => {
    streamPerfCount(metric);

    expect(getStreamPerfSnapshot().enabled).toBe(false);
    expect(window.__openchamberStreamPerfState).toBeUndefined();
  });

  test('keeps profiler counters enabled when memory debug is closed', () => {
    setStreamPerfEnabled(true);
    streamPerfCount(metric);

    setStreamPerfMemoryDebugEnabled(false);

    expectCounterEnabled();
    expect(window.localStorage.getItem('openchamber_stream_perf')).toBe('1');
  });

  test('keeps memory debug counters enabled when the profiler is disabled', () => {
    setStreamPerfMemoryDebugEnabled(true);
    streamPerfCount(metric);

    setStreamPerfEnabled(false);

    expectCounterEnabled();
    expect(window.localStorage.getItem('openchamber_stream_perf')).toBeNull();
  });
});
