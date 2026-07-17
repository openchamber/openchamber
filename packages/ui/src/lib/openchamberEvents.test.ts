import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  resetOpenchamberEventsForTests,
  setOpenchamberEventsDependenciesForTests,
  subscribeOpenchamberEvents,
} from './openchamberEvents';

let tunnelActive = false;
let fetchImplementation: (signal: AbortSignal) => Promise<Response>;
const runtimeFetchCalls: Array<{ path: string; init: RequestInit }> = [];
let runtimeChangeListener: (() => void) | null = null;

class FakeEventSource {
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
}

type StreamHandle = {
  response: Response;
  enqueue(text: string): void;
  close(): void;
  error(reason: Error): void;
};

const createStream = (): StreamHandle => {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
    },
  });
  const encoder = new TextEncoder();
  return {
    response: new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }),
    enqueue(text) {
      controller?.enqueue(encoder.encode(text));
    },
    close() {
      controller?.close();
    },
    error(reason) {
      controller?.error(reason);
    },
  };
};

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

type ScheduledTimer = { at: number; callback: () => void };
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
let currentTime = 0;
const timers = new Map<ReturnType<typeof setTimeout>, ScheduledTimer>();
const advanceTimersByTime = async (duration: number): Promise<void> => {
  const target = currentTime + duration;
  while (true) {
    const next = Array.from(timers.entries())
      .filter(([, timer]) => timer.at <= target)
      .sort((left, right) => left[1].at - right[1].at)[0];
    if (!next) break;
    const [id, timer] = next;
    timers.delete(id);
    currentTime = timer.at;
    timer.callback();
    await flushPromises();
  }
  currentTime = target;
};

let unsubscribe: (() => void) | null = null;

beforeEach(() => {
  currentTime = 0;
  timers.clear();
  setOpenchamberEventsDependenciesForTests({
    isBrowserAvailable: () => true,
    isTunnelActive: () => tunnelActive,
    runtimeFetch: async (path, init) => {
      runtimeFetchCalls.push({ path: String(path), init: init ?? {} });
      if (!init?.signal) throw new Error('Expected an abort signal');
      return fetchImplementation(init.signal);
    },
    getSseUrl: (path) => `https://runtime.test${path}`,
    subscribeRuntimeSwitch: (listener) => {
      runtimeChangeListener = listener;
      return () => {
        runtimeChangeListener = null;
      };
    },
    createEventSource: (url) => new FakeEventSource(url),
    eventSourceClosedState: FakeEventSource.CLOSED,
    setTimer: (callback, delay) => {
      const handle = nativeSetTimeout(() => {}, 2_147_483_647);
      nativeClearTimeout(handle);
      timers.set(handle, { at: currentTime + delay, callback });
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle);
    },
  });
  tunnelActive = false;
  runtimeFetchCalls.length = 0;
  runtimeChangeListener = null;
  FakeEventSource.instances = [];
  fetchImplementation = async () => new Response(null, { status: 500 });
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  resetOpenchamberEventsForTests();
});

describe('subscribeOpenchamberEvents transport', () => {
  test('keeps native EventSource behavior when no tunnel is active', () => {
    unsubscribe = subscribeOpenchamberEvents(() => {});

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe('https://runtime.test/api/openchamber/events');
  });

  test('uses runtimeFetch in tunnel mode and dispatches fragmented frames in order', async () => {
    tunnelActive = true;
    const stream = createStream();
    const signals: AbortSignal[] = [];
    fetchImplementation = async (signal) => {
      signals.push(signal);
      return stream.response;
    };
    const events: Array<{ taskId: string }> = [];
    unsubscribe = subscribeOpenchamberEvents((event) => events.push(event));
    await flushPromises();

    stream.enqueue('data: {"type":"openchamber:scheduled-task-ran","pro');
    stream.enqueue('perties":{"projectId":"p","taskId":"one","ranAt":1,"status":"success"}}\n\n');
    stream.enqueue('data: {"type":"openchamber:scheduled-task-ran","properties":{"projectId":"p","taskId":"two","ranAt":2,"status":"success"}}\r\n\r\n');
    await flushPromises();

    expect(events.map((event) => event.taskId)).toEqual(['one', 'two']);
    expect(runtimeFetchCalls).toHaveLength(1);
    expect(runtimeFetchCalls[0]?.path).toBe('/api/openchamber/events');
    expect(new Headers(runtimeFetchCalls[0]?.init.headers).get('accept')).toBe('text/event-stream');
    expect(runtimeFetchCalls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  test('heartbeat watchdog aborts silent streams and complete heartbeat frames reset it', async () => {
    tunnelActive = true;
    const silentStream = createStream();
    const heartbeatStream = createStream();
    const streams = [silentStream, heartbeatStream];
    const signals: AbortSignal[] = [];
    let calls = 0;
    fetchImplementation = async (signal) => {
      signals.push(signal);
      return streams[calls++]!.response;
    };
    unsubscribe = subscribeOpenchamberEvents(() => {});
    await flushPromises();

    await advanceTimersByTime(44_999);
    expect(signals[0]?.aborted).toBe(false);
    await advanceTimersByTime(1);
    expect(signals[0]?.aborted).toBe(true);
    await advanceTimersByTime(999);
    expect(calls).toBe(1);
    await advanceTimersByTime(1);
    expect(calls).toBe(2);

    await advanceTimersByTime(44_000);
    heartbeatStream.enqueue('data: {"type":"openchamber:heartbeat","properties":{}}\n\n');
    await flushPromises();
    await advanceTimersByTime(44_999);
    expect(signals[1]?.aborted).toBe(false);
    await advanceTimersByTime(1);
    expect(signals[1]?.aborted).toBe(true);
  });

  test('reconnects after invalid responses and EOF without falling back to EventSource', async () => {
    tunnelActive = true;
    const stream = createStream();
    let calls = 0;
    fetchImplementation = async () => {
      calls += 1;
      return calls === 1
        ? new Response('wrong', { headers: { 'Content-Type': 'text/html' } })
        : stream.response;
    };
    unsubscribe = subscribeOpenchamberEvents(() => {});
    await flushPromises();

    expect(calls).toBe(1);
    await advanceTimersByTime(1_000);
    expect(calls).toBe(2);
    stream.close();
    await flushPromises();
    await advanceTimersByTime(2_000);

    expect(calls).toBe(3);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  test('reconnects after parser overflow without falling back to EventSource', async () => {
    tunnelActive = true;
    const overflowingStream = createStream();
    const recoveredStream = createStream();
    let calls = 0;
    fetchImplementation = async () => {
      calls += 1;
      return calls === 1 ? overflowingStream.response : recoveredStream.response;
    };
    unsubscribe = subscribeOpenchamberEvents(() => {});
    await flushPromises();

    overflowingStream.enqueue(`data: ${'x'.repeat(64 * 1024)}x`);
    await flushPromises();
    await advanceTimersByTime(1_000);

    expect(calls).toBe(2);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  test('last unsubscribe aborts the active tunnel reader and prevents reconnect', async () => {
    tunnelActive = true;
    const stream = createStream();
    const signals: AbortSignal[] = [];
    let calls = 0;
    fetchImplementation = async (nextSignal) => {
      calls += 1;
      signals.push(nextSignal);
      return stream.response;
    };
    unsubscribe = subscribeOpenchamberEvents(() => {});
    await flushPromises();

    unsubscribe();
    unsubscribe = null;
    stream.error(new Error('late failure'));
    await flushPromises();
    await advanceTimersByTime(30_000);

    expect(signals[0]?.aborted).toBe(true);
    expect(calls).toBe(1);
  });

  test('runtime switch suppresses stale chunks and starts a new tunnel reader', async () => {
    tunnelActive = true;
    const oldStream = createStream();
    const newStream = createStream();
    const streams = [oldStream, newStream];
    let calls = 0;
    fetchImplementation = async () => streams[calls++]!.response;
    const taskIds: string[] = [];
    unsubscribe = subscribeOpenchamberEvents((event) => taskIds.push(event.taskId));
    await flushPromises();

    runtimeChangeListener?.();
    await flushPromises();
    oldStream.enqueue('data: {"type":"openchamber:scheduled-task-ran","properties":{"projectId":"p","taskId":"stale","ranAt":1,"status":"success"}}\n\n');
    newStream.enqueue('data: {"type":"openchamber:scheduled-task-ran","properties":{"projectId":"p","taskId":"fresh","ranAt":1,"status":"success"}}\n\n');
    await flushPromises();

    expect(calls).toBe(2);
    expect(taskIds).toEqual(['fresh']);
  });

  test('ready frame resets reconnect backoff', async () => {
    tunnelActive = true;
    const readyStream = createStream();
    const finalStream = createStream();
    let calls = 0;
    fetchImplementation = async () => {
      calls += 1;
      if (calls === 1) return new Response(null, { status: 503 });
      return calls === 2 ? readyStream.response : finalStream.response;
    };
    unsubscribe = subscribeOpenchamberEvents(() => {});
    await flushPromises();
    await advanceTimersByTime(1_000);

    readyStream.enqueue('data: {"type":"openchamber:event-stream-ready","properties":{}}\n\n');
    await flushPromises();
    readyStream.close();
    await flushPromises();
    await advanceTimersByTime(999);
    expect(calls).toBe(2);
    await advanceTimersByTime(1);
    expect(calls).toBe(3);
  });
});
