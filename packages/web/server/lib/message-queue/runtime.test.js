import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageQueueRuntime, parseQueuedItemInput } from './runtime.js';

const SESSION = 'ses_queue_test_1';
const DIRECTORY = '/repo';

const item = (overrides = {}) => ({
  content: 'follow up',
  text: 'follow up',
  attachments: [],
  context: [],
  sendConfig: { providerID: 'anthropic', modelID: 'claude', agent: 'build' },
  ...overrides,
});

const persistedEnvelope = ({ sessions = {}, ...overrides } = {}) => ({
  version: 2,
  revision: 0,
  sessions,
  sessionLifecycles: {},
  takeReceipts: {},
  completedRestores: {},
  enqueueIdempotency: {},
  ...overrides,
});

const tempDirs = [];
const makeDataDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-message-queue-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake OpenCode: status map, message tail, command list, and a log of every
 * prompt/command it received.
 */
const createOpenCode = () => {
  const state = {
    statuses: {},
    tail: [],
    commands: [],
    sent: [],
    failNext: null,
  };
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? 'GET';
    if (state.failNext && state.failNext.test(pathname)) {
      state.failNext = null;
      return new Response('boom', { status: 500 });
    }
    if (pathname === '/session/status') return Response.json(state.statuses);
    if (pathname.endsWith('/message')) return Response.json(state.tail);
    if (pathname === '/command') return Response.json(state.commands);
    if (method === 'POST' && (pathname.endsWith('/prompt_async') || pathname.endsWith('/command'))) {
      state.sent.push({ path: pathname, body: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    }
    return new Response('not found', { status: 404 });
  });
  return { state, fetchImpl };
};

const createRuntime = ({ dataDir = makeDataDir(), openCode = createOpenCode(), knowledge = null, retryDelayMs, takeReceiptPayloadLimitBytes, dispatchQuietMs = 0, now } = {}) => {
  let eventHandler = () => {};
  let statusHandler = () => {};
  const broadcasts = [];
  const promptSent = [];
  const options = {
    globalEventHub: {
      subscribeEvent(handler) { eventHandler = handler; return () => {}; },
      subscribeStatus(handler) { statusHandler = handler; return () => {}; },
    },
    buildOpenCodeUrl: (fetchPath) => `http://opencode.test${fetchPath}`,
    getOpenCodeAuthHeaders: () => ({}),
    sessionKnowledgeRuntime: knowledge,
    broadcastGlobalUiEvent: (event) => broadcasts.push(event),
    onPromptSent: (sessionId) => promptSent.push(sessionId),
    dataDir,
    fetchImpl: openCode.fetchImpl,
    dispatchQuietMs,
    abortHoldMs: 50,
  };
  if (now !== undefined) options.now = now;
  if (retryDelayMs) options.retryDelayMs = retryDelayMs;
  if (takeReceiptPayloadLimitBytes !== undefined) options.takeReceiptPayloadLimitBytes = takeReceiptPayloadLimitBytes;
  const runtime = createMessageQueueRuntime(options);
  return {
    runtime,
    openCode,
    dataDir,
    broadcasts,
    promptSent,
    emit: (payload, directory = DIRECTORY) => eventHandler({ payload, directory }),
    connect: () => statusHandler({ type: 'connect' }),
  };
};

const settle = async (ms = 30) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

describe('parseQueuedItemInput', () => {
  it('rejects an item the server could not deliver later', () => {
    expect(() => parseQueuedItemInput({ content: 'x' })).toThrow(TypeError);
    expect(() => parseQueuedItemInput(item({ content: '', text: '' }))).toThrow(TypeError);
    expect(() => parseQueuedItemInput(item({ attachments: [{ filename: 'a.png' }] }))).toThrow(TypeError);
  });

  it('keeps delivery fields and trims blank edges of the content', () => {
    const parsed = parseQueuedItemInput(item({ content: '\n\nhello\n', text: 'hello', agentMention: 'reviewer' }));
    expect(parsed).toEqual({
      content: 'hello',
      text: 'hello',
      agentMention: 'reviewer',
      attachments: [],
      context: [],
      sendConfig: { providerID: 'anthropic', modelID: 'claude', agent: 'build' },
    });
  });

  it('keeps captured context and rejects a malformed part', () => {
    const context = [
      { kind: 'context', text: 'Comment on `a.ts`', metadata: { openchamberContext: { kind: 'code-comment' } }, instructions: '' },
      { kind: 'instruction', text: 'use the skill' },
      { kind: 'synthetic', text: 'conflict payload' },
    ];
    expect(parseQueuedItemInput(item({ context })).context).toEqual([
      { kind: 'context', text: 'Comment on `a.ts`', metadata: { openchamberContext: { kind: 'code-comment' } } },
      { kind: 'instruction', text: 'use the skill' },
      { kind: 'synthetic', text: 'conflict payload' },
    ]);
    expect(() => parseQueuedItemInput(item({ context: [{ kind: 'context', text: 'no metadata' }] }))).toThrow(TypeError);
    expect(() => parseQueuedItemInput(item({ context: [{ kind: 'other', text: 'x' }] }))).toThrow(TypeError);
  });

  it('accepts an enqueue idempotency key exactly once', async () => {
    const { runtime } = createRuntime({ dispatchQuietMs: 60_000 });
    const first = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'once' }), 'enqueue-once');
    const replay = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'once' }), 'enqueue-once', first.session.generation);

    expect(replay.itemId).toBe(first.itemId);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
    await expect(runtime.enqueue(SESSION, DIRECTORY, item({ content: 'different' }), 'enqueue-once', first.session.generation)).rejects.toMatchObject({ status: 409 });
  });

  it('establishes a lifecycle barrier for a first enqueue when creation was missed', async () => {
    const { runtime } = createRuntime();
    const accepted = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first incarnation' }));

    expect(accepted.session.generation).toBe(1);
    await expect(runtime.enqueue(SESSION, DIRECTORY, item({ content: 'unguarded stale enqueue' }))).rejects.toMatchObject({ status: 409 });
    await expect(runtime.enqueue(SESSION, DIRECTORY, item({ content: 'guarded follow-up' }), undefined, 1)).resolves.toMatchObject({
      session: { generation: 1 },
    });
  });

  it('restores a taken batch through its durable receipt and makes replay harmless', async () => {
    const { runtime } = createRuntime({ dispatchQuietMs: 60_000 });
    const queued = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'restore me' }));
    const taken = await runtime.take(SESSION, DIRECTORY, queued.itemId, false, 'take-once', queued.session.generation);

    const restored = await runtime.restore(SESSION, DIRECTORY, [taken.item], taken.generation, 'take-once');
    const replay = await runtime.restore(SESSION, DIRECTORY, [taken.item], taken.generation, 'take-once');

    expect(restored.session.items.map((entry) => entry.id)).toEqual([taken.item.id]);
    expect(replay.revision).toBe(restored.revision);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
  });

  it('replays a taken item from its persisted receipt after a runtime restart', async () => {
    const dataDir = makeDataDir();
    const first = createRuntime({ dataDir });
    const queued = await first.runtime.enqueue(SESSION, DIRECTORY, item({ content: 'recover me' }));
    const taken = await first.runtime.take(SESSION, DIRECTORY, queued.itemId, false, 'take-restart', queued.session.generation);
    await first.runtime.flush();

    const second = createRuntime({ dataDir });
    await second.runtime.load();
    expect(second.runtime.snapshot().sessions).toEqual([{
      sessionId: SESSION,
      directory: DIRECTORY,
      items: [],
      sendingId: null,
      generation: 1,
    }]);
    const replay = await second.runtime.take(SESSION, DIRECTORY, queued.itemId, false, 'take-restart', taken.generation);

    expect(replay.item).toEqual(taken.item);
    expect(replay.revision).toBe(taken.revision);
  });

  it('buffers a session event until the durable queue load completes', async () => {
    const dataDir = makeDataDir();
    fs.writeFileSync(path.join(dataDir, 'message-queue.json'), JSON.stringify({
      ...persistedEnvelope({
        revision: 1,
        sessions: { [SESSION]: { directory: DIRECTORY, items: [{ id: 'queued-durable', createdAt: 1, ...item({ content: 'durable' }) }] } },
      }),
    }));
    const originalReadFile = fs.promises.readFile;
    let releaseRead;
    vi.spyOn(fs.promises, 'readFile').mockImplementation((...args) => new Promise((resolve, reject) => {
      releaseRead = () => originalReadFile.apply(fs.promises, args).then(resolve, reject);
    }));
    const { runtime, broadcasts } = createRuntime({ dataDir });
    runtime.start();

    await runtime.processPayload({ type: 'session.deleted', properties: { info: { id: SESSION } } });
    releaseRead();
    await runtime.load();

    expect(runtime.snapshot().sessions).toEqual([]);
    expect(broadcasts.at(-1).properties.session).toMatchObject({ sessionId: SESSION, items: [], deleted: true });
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'message-queue.json'), 'utf8'));
    expect(persisted.sessions[SESSION]).toBeUndefined();
    expect(persisted.sessionLifecycles[SESSION].deleted).toBe(true);
    vi.restoreAllMocks();
  });

  it('serializes a delayed public commit before a hub event and assigns unique revisions', async () => {
    const { runtime, broadcasts, dataDir } = createRuntime();
    await runtime.load();
    const originalWriteFile = fs.promises.writeFile;
    let releaseWrite;
    let writeStarted;
    const writeStartedPromise = new Promise((resolve) => { writeStarted = resolve; });
    const writeSpy = vi.spyOn(fs.promises, 'writeFile').mockImplementationOnce((...args) => new Promise((resolve, reject) => {
      writeStarted();
      releaseWrite = () => originalWriteFile.apply(fs.promises, args).then(resolve, reject);
    }));

    try {
      const enqueuePromise = runtime.enqueue(SESSION, DIRECTORY, item({ content: 'before event' }));
      await writeStartedPromise;
      const eventPromise = runtime.processPayload({ type: 'session.deleted', properties: { info: { id: SESSION } } });
      await settle(10);

      expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).toEqual(['before event']);
      expect(broadcasts).toEqual([]);

      releaseWrite();
      const accepted = await enqueuePromise;
      await eventPromise;

      expect(accepted.revision).toBe(1);
      expect(runtime.snapshot().revision).toBe(2);
      expect(broadcasts.map((event) => event.properties.revision)).toEqual([1, 2]);
      expect(new Set(broadcasts.map((event) => event.properties.revision)).size).toBe(2);
      expect(runtime.snapshot().sessions).toEqual([]);
      expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'message-queue.json'), 'utf8'))).toMatchObject({
        revision: 2,
        sessions: {},
        sessionLifecycles: { [SESSION]: { deleted: true } },
      });
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('rolls back a failed hub event and continues with the next public mutation', async () => {
    const { runtime, broadcasts } = createRuntime({ dispatchQuietMs: 60_000 });
    await runtime.load();
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'keep on event failure' }));
    const before = runtime.snapshot();
    const broadcastCount = broadcasts.length;
    const writeSpy = vi.spyOn(fs.promises, 'writeFile').mockRejectedValueOnce(new Error('event write failed'));

    try {
      await expect(runtime.processPayload({ type: 'session.deleted', properties: { info: { id: SESSION } } })).rejects.toThrow('event write failed');
      expect(runtime.snapshot()).toEqual(before);
      expect(broadcasts).toHaveLength(broadcastCount);

      await expect(runtime.enqueue(SESSION, DIRECTORY, item({ content: 'after event failure' }), undefined, before.sessions[0].generation)).resolves.toMatchObject({
        revision: before.revision + 1,
        session: { items: [{ content: 'keep on event failure' }, { content: 'after event failure' }] },
      });
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('fails closed when an atomic queue write fails', async () => {
    const { runtime, broadcasts } = createRuntime();
    const writeSpy = vi.spyOn(fs.promises, 'writeFile').mockRejectedValueOnce(new Error('disk full'));

    await expect(runtime.enqueue(SESSION, DIRECTORY, item())).rejects.toThrow('disk full');
    expect(runtime.snapshot().sessions).toEqual([]);
    expect(broadcasts).toEqual([]);

    writeSpy.mockRestore();
    await expect(runtime.enqueue(SESSION, DIRECTORY, item({ content: 'retry' }))).resolves.toMatchObject({ session: { items: [{ content: 'retry' }] } });
  });

  it('does not report a take receipt until its removal and receipt are durable', async () => {
    const dataDir = makeDataDir();
    const { runtime } = createRuntime({ dataDir, dispatchQuietMs: 60_000 });
    const queued = await runtime.enqueue(SESSION, DIRECTORY, item());
    const writeSpy = vi.spyOn(fs.promises, 'writeFile').mockRejectedValueOnce(new Error('receipt write failed'));

    await expect(runtime.take(SESSION, DIRECTORY, queued.itemId, false, 'durable-take', queued.session.generation)).rejects.toThrow('receipt write failed');
    expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.id)).toEqual([queued.itemId]);

    writeSpy.mockRestore();
    const taken = await runtime.take(SESSION, DIRECTORY, queued.itemId, false, 'durable-take', queued.session.generation);
    await runtime.flush();
    const restarted = createRuntime({ dataDir, dispatchQuietMs: 60_000 });
    await restarted.runtime.load();
    await expect(restarted.runtime.take(SESSION, DIRECTORY, queued.itemId, false, 'durable-take', taken.generation)).resolves.toMatchObject({ item: taken.item });
  });

  it('keeps a sent item retryable when its removal write fails', async () => {
    const { runtime, openCode, emit } = createRuntime({ retryDelayMs: () => 10 });
    runtime.start();
    const queued = await runtime.enqueue(SESSION, DIRECTORY, item());
    const writeSpy = vi.spyOn(fs.promises, 'writeFile').mockRejectedValueOnce(new Error('removal write failed'));

    await emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle(150);
    expect(openCode.state.sent).toHaveLength(2);
    expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);

    writeSpy.mockRestore();
    expect(queued.itemId).toBeTruthy();
  });

  it('rejects stale directories after a session move without changing the queue or receipt', async () => {
    const { runtime } = createRuntime({ dispatchQuietMs: 60_000 });
    const queued = await runtime.enqueue(SESSION, DIRECTORY, item());
    await runtime.processPayload({ type: 'session.updated', properties: { info: { id: SESSION, directory: '/moved' } } });
    const before = runtime.snapshot();

    await expect(runtime.enqueue(SESSION, DIRECTORY, item({ content: 'stale' }), undefined, queued.session.generation)).rejects.toMatchObject({ status: 409, directory: '/moved' });
    expect(runtime.snapshot()).toEqual(before);

    const taken = await runtime.take(SESSION, '/moved', queued.itemId, false, 'move-receipt', queued.session.generation);
    await expect(runtime.restore(SESSION, DIRECTORY, [taken.item], taken.generation, 'move-receipt')).rejects.toMatchObject({ status: 409, directory: '/moved' });
    expect(runtime.snapshot().sessions).toEqual([{ sessionId: SESSION, directory: '/moved', items: [], sendingId: null, generation: 1 }]);
    await expect(runtime.restore(SESSION, '/moved', [taken.item], taken.generation, 'move-receipt')).resolves.toMatchObject({ session: { directory: '/moved', items: [{ id: taken.item.id }] } });
  });

  it('rejects a stale directory from remove without changing the queue', async () => {
    const { runtime } = createRuntime({ dispatchQuietMs: 60_000 });
    const queued = await runtime.enqueue(SESSION, DIRECTORY, item());
    await runtime.processPayload({ type: 'session.updated', properties: { info: { id: SESSION, directory: '/moved' } } });
    const before = runtime.snapshot();

    await expect(runtime.remove(SESSION, DIRECTORY, queued.itemId, queued.session.generation)).rejects.toMatchObject({ status: 409, directory: '/moved' });
    expect(runtime.snapshot()).toEqual(before);
  });

  it('rejects a stale directory from take before creating its receipt', async () => {
    const { runtime } = createRuntime({ dispatchQuietMs: 60_000 });
    const queued = await runtime.enqueue(SESSION, DIRECTORY, item());
    await runtime.processPayload({ type: 'session.updated', properties: { info: { id: SESSION, directory: '/moved' } } });
    const before = runtime.snapshot();

    await expect(runtime.take(SESSION, DIRECTORY, queued.itemId, false, 'stale-take', queued.session.generation)).rejects.toMatchObject({ status: 409, directory: '/moved' });
    expect(runtime.snapshot()).toEqual(before);
    await expect(runtime.take(SESSION, '/moved', queued.itemId, false, 'stale-take', queued.session.generation)).resolves.toMatchObject({ item: { id: queued.itemId } });
  });

  it('rejects a stale directory from takeAll before creating its receipt', async () => {
    const { runtime } = createRuntime({ dispatchQuietMs: 60_000 });
    const queued = await runtime.enqueue(SESSION, DIRECTORY, item());
    await runtime.processPayload({ type: 'session.updated', properties: { info: { id: SESSION, directory: '/moved' } } });
    const before = runtime.snapshot();

    await expect(runtime.takeAll(SESSION, DIRECTORY, 'stale-take-all', queued.session.generation)).rejects.toMatchObject({ status: 409, directory: '/moved' });
    expect(runtime.snapshot()).toEqual(before);
    await expect(runtime.takeAll(SESSION, '/moved', 'stale-take-all', queued.session.generation)).resolves.toMatchObject({ items: [{ id: queued.itemId }] });
  });

  it('rejects a stale directory from reorder without changing the queue', async () => {
    const { runtime } = createRuntime({ dispatchQuietMs: 60_000 });
    const first = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first' }));
    const second = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'second' }), undefined, first.session.generation);
    await runtime.processPayload({ type: 'session.updated', properties: { info: { id: SESSION, directory: '/moved' } } });
    const before = runtime.snapshot();

    await expect(runtime.reorder(SESSION, DIRECTORY, [second.itemId, first.itemId], first.session.generation)).rejects.toMatchObject({ status: 409, directory: '/moved' });
    expect(runtime.snapshot()).toEqual(before);
  });

  it('rejects a stale directory from clear without changing the queue', async () => {
    const { runtime } = createRuntime({ dispatchQuietMs: 60_000 });
    const queued = await runtime.enqueue(SESSION, DIRECTORY, item());
    await runtime.processPayload({ type: 'session.updated', properties: { info: { id: SESSION, directory: '/moved' } } });
    const before = runtime.snapshot();

    await expect(runtime.clear(SESSION, DIRECTORY, queued.session.generation)).rejects.toMatchObject({ status: 409, directory: '/moved' });
    expect(runtime.snapshot()).toEqual(before);
  });

  it('rejects a stale directory from setHold without changing the hold', async () => {
    const { runtime, openCode, emit } = createRuntime({ dispatchQuietMs: 0 });
    runtime.start();
    const queued = await runtime.enqueue(SESSION, DIRECTORY, item());
    await runtime.processPayload({ type: 'session.updated', properties: { info: { id: SESSION, directory: '/moved' } } });
    const before = runtime.snapshot();

    expect(() => runtime.setHold(SESSION, DIRECTORY, true, 60_000, queued.session.generation, 1, 'moved-hold')).toThrow(expect.objectContaining({ status: 409, directory: '/moved' }));
    expect(runtime.snapshot()).toEqual(before);
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(1);
  });

  it('rejects a stale directory from receipt acknowledgement until the current directory is used', async () => {
    const { runtime } = createRuntime({ dispatchQuietMs: 60_000 });
    const queued = await runtime.enqueue(SESSION, DIRECTORY, item());
    const taken = await runtime.take(SESSION, DIRECTORY, queued.itemId, false, 'ack-after-move', queued.session.generation);
    await runtime.processPayload({ type: 'session.updated', properties: { info: { id: SESSION, directory: '/moved' } } });

    await expect(runtime.acknowledgeTake(SESSION, DIRECTORY, 'ack-after-move', queued.session.generation)).rejects.toMatchObject({ status: 409, directory: '/moved' });
    await expect(runtime.take(SESSION, '/moved', queued.itemId, false, 'ack-after-move', taken.generation)).resolves.toMatchObject({ item: taken.item });
    await expect(runtime.acknowledgeTake(SESSION, '/moved', 'ack-after-move', queued.session.generation)).resolves.toEqual({ acknowledged: true });
  });

  it('requires a receipt when restoring an old item into a recreated session', async () => {
    const { runtime } = createRuntime({ dispatchQuietMs: 60_000 });
    const first = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'old incarnation' }));
    const taken = await runtime.take(SESSION, DIRECTORY, first.itemId, false, 'old-incarnation-take', first.session.generation);
    await runtime.processPayload({ type: 'session.deleted', properties: { info: { id: SESSION } } });
    await runtime.processPayload({ type: 'session.created', properties: { info: { id: SESSION, directory: DIRECTORY } } });
    const before = runtime.snapshot();

    await expect(runtime.restore(SESSION, DIRECTORY, [taken.item], 3)).rejects.toMatchObject({ status: 409 });
    expect(runtime.snapshot()).toEqual(before);

    const current = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'new incarnation' }), undefined, 3);
    const currentTake = await runtime.take(SESSION, DIRECTORY, current.itemId, false, 'new-incarnation-take', 3);
    await expect(runtime.restore(SESSION, DIRECTORY, [currentTake.item], 3, 'new-incarnation-take')).resolves.toMatchObject({
      session: { generation: 3, items: [{ id: currentTake.item.id }] },
    });
  });

  it('persists receipt protection across restart after delete and recreate', async () => {
    const dataDir = makeDataDir();
    const firstRuntime = createRuntime({ dataDir, dispatchQuietMs: 60_000 });
    const first = await firstRuntime.runtime.enqueue(SESSION, DIRECTORY, item({ content: 'old incarnation' }));
    const oldTake = await firstRuntime.runtime.take(SESSION, DIRECTORY, first.itemId, false, 'old-restart-take', first.session.generation);
    await firstRuntime.runtime.processPayload({ type: 'session.deleted', properties: { info: { id: SESSION } } });
    await firstRuntime.runtime.processPayload({ type: 'session.created', properties: { info: { id: SESSION, directory: DIRECTORY } } });
    await firstRuntime.runtime.flush();

    const restarted = createRuntime({ dataDir, dispatchQuietMs: 60_000 });
    await restarted.runtime.load();
    expect(restarted.runtime.snapshot().sessionLifecycles[SESSION]).toMatchObject({ generation: 3, deleted: false, restoreRequiresReceipt: true });
    await expect(restarted.runtime.restore(SESSION, DIRECTORY, [oldTake.item], 3)).rejects.toMatchObject({ status: 409 });
    expect(restarted.runtime.sessionSnapshot(SESSION).items).toEqual([]);

    const current = await restarted.runtime.enqueue(SESSION, DIRECTORY, item({ content: 'recover after restart' }), undefined, 3);
    const currentTake = await restarted.runtime.take(SESSION, DIRECTORY, current.itemId, false, 'new-restart-take', 3);
    await expect(restarted.runtime.restore(SESSION, DIRECTORY, [currentTake.item], 3, 'new-restart-take')).resolves.toMatchObject({
      session: { generation: 3, items: [{ id: currentTake.item.id }] },
    });
  });

  it('rejects a restore when all 50 existing queues are receipt-protected, then retains the receipt for retry', async () => {
    const { runtime } = createRuntime({ dispatchQuietMs: 60_000 });
    const target = 'ses_cap_target';
    const queued = await runtime.enqueue(target, '/target', item({ content: 'restore-target' }));
    const taken = await runtime.take(target, '/target', queued.itemId, false, 'cap-target-receipt', queued.session.generation);
    const protectedSessions = [];
    for (let index = 0; index < 50; index += 1) {
      const sessionId = `ses_cap_${String(index).padStart(2, '0')}`;
      const directory = `/repo/${index}`;
      const first = await runtime.enqueue(sessionId, directory, item({ content: `first-${index}` }));
      await runtime.enqueue(sessionId, directory, item({ content: `second-${index}` }), undefined, first.session.generation);
       await runtime.take(sessionId, directory, first.itemId, false, `cap-receipt-${index}`, first.session.generation);
       protectedSessions.push({ sessionId, directory, generation: first.session.generation, operationId: `cap-receipt-${index}` });
    }
    await expect(runtime.restore(target, '/target', [taken.item], taken.generation, 'cap-target-receipt')).rejects.toMatchObject({ status: 409 });
    const rejectedSnapshot = runtime.snapshot().sessions;
    expect(rejectedSnapshot.filter((session) => session.items.length > 0)).toHaveLength(50);
    expect(rejectedSnapshot.find((session) => session.sessionId === target).items).toEqual([]);

    await runtime.acknowledgeTake(protectedSessions[0].sessionId, protectedSessions[0].directory, protectedSessions[0].operationId, protectedSessions[0].generation);
    await expect(runtime.restore(target, '/target', [taken.item], taken.generation, 'cap-target-receipt')).resolves.toMatchObject({
      session: { sessionId: target, items: [{ id: taken.item.id }] },
    });
    expect(runtime.snapshot().sessions).toHaveLength(50);
    expect(runtime.sessionSnapshot(target).items).toHaveLength(1);
  });

  it('rejects an enqueue when all 50 existing queues are protected, without changing memory, disk, revision, or broadcasts', async () => {
    const { runtime, broadcasts, dataDir } = createRuntime({ dispatchQuietMs: 60_000 });
    for (let index = 0; index < 50; index += 1) {
      const sessionId = `ses_enqueue_cap_${String(index).padStart(2, '0')}`;
      const directory = `/repo/enqueue-cap/${index}`;
      const first = await runtime.enqueue(sessionId, directory, item({ content: `first-${index}` }));
      await runtime.enqueue(sessionId, directory, item({ content: `second-${index}` }), undefined, first.session.generation);
      await runtime.take(sessionId, directory, first.itemId, false, `enqueue-cap-receipt-${index}`, first.session.generation);
    }
    const before = runtime.snapshot();
    const filePath = path.join(dataDir, 'message-queue.json');
    const persistedBefore = fs.readFileSync(filePath, 'utf8');
    const broadcastCount = broadcasts.length;

    await expect(runtime.enqueue('ses_enqueue_cap_target', '/repo/enqueue-cap/target', item({ content: 'must reject' }))).rejects.toMatchObject({ status: 409 });

    expect(runtime.snapshot()).toEqual(before);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(persistedBefore);
    expect(broadcasts).toHaveLength(broadcastCount);
  });

  it('evicts the oldest safe queue when enqueueing past the session cap', async () => {
    let clock = 0;
    const { runtime } = createRuntime({ dispatchQuietMs: 60_000, now: () => ++clock });
    const oldest = await runtime.enqueue('ses_enqueue_oldest', '/repo/enqueue-cap/oldest', item({ content: 'oldest' }));
    for (let index = 1; index < 50; index += 1) {
      await runtime.enqueue(`ses_enqueue_safe_${String(index).padStart(2, '0')}`, `/repo/enqueue-cap/${index}`, item({ content: `safe-${index}` }));
    }

    const newest = await runtime.enqueue('ses_enqueue_newest', '/repo/enqueue-cap/newest', item({ content: 'newest' }));

    expect(runtime.snapshot().sessions).toHaveLength(50);
    expect(runtime.sessionSnapshot(oldest.session.sessionId).items).toEqual([]);
    expect(runtime.sessionSnapshot(newest.session.sessionId).items.map((entry) => entry.content)).toEqual(['newest']);
  });

  it('rejects an oversized take receipt before removing the queued item', async () => {
    const { runtime } = createRuntime({ takeReceiptPayloadLimitBytes: 100, dispatchQuietMs: 60_000 });
    const queued = await runtime.enqueue(SESSION, DIRECTORY, item({
      attachments: [{ id: 'large', filename: 'large.txt', mimeType: 'text/plain', size: 1000, source: 'local', dataUrl: `data:text/plain,${'x'.repeat(200)}` }],
    }));

    await expect(runtime.take(SESSION, DIRECTORY, queued.itemId, false, 'take-too-large', queued.session.generation)).rejects.toMatchObject({ status: 413 });
    expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.id)).toEqual([queued.itemId]);
  });

  it('accepts an item that is only context', () => {
    const parsed = parseQueuedItemInput(item({ content: '', text: '', context: [{ kind: 'synthetic', text: 'just context' }] }));
    expect(parsed.text).toBe('');
    expect(parsed.context).toHaveLength(1);
  });
});

describe('message queue runtime', () => {
  it('keeps a newer hold authoritative when a queue write rolls back', async () => {
    const { runtime, openCode, emit, dataDir } = createRuntime({ dispatchQuietMs: 0 });
    runtime.start();
    await runtime.load();
    openCode.state.statuses = { [SESSION]: { type: 'busy' } };
    const first = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'durable queue' }));
    await settle();

    let rejectWrite;
    let writeStarted;
    const writeStartedPromise = new Promise((resolve) => { writeStarted = resolve; });
    const writeSpy = vi.spyOn(fs.promises, 'writeFile').mockImplementationOnce(() => new Promise((_resolve, reject) => {
      writeStarted();
      rejectWrite = reject;
    }));

    try {
      const failedEnqueue = runtime.enqueue(SESSION, DIRECTORY, item({ content: 'rolled back' }), undefined, first.session.generation);
      await writeStartedPromise;
      expect(runtime.setHold(SESSION, DIRECTORY, true, 60_000, first.session.generation, 1, 'newer-hold')).toMatchObject({ held: true, sequence: 1 });

      rejectWrite(new Error('queue write failed'));
      await expect(failedEnqueue).rejects.toThrow('queue write failed');

      expect(runtime.sessionSnapshot(SESSION).items.map((queued) => queued.content)).toEqual(['durable queue']);
      expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'message-queue.json'), 'utf8')).sessions[SESSION].items).toHaveLength(1);
      expect(runtime.setHold(SESSION, DIRECTORY, false, 60_000, first.session.generation, 1, 'stale-hold')).toMatchObject({ held: true, sequence: 1 });

      openCode.state.statuses = {};
      emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
      await settle();
      expect(openCode.state.sent).toHaveLength(0);

      runtime.setHold(SESSION, DIRECTORY, false, 60_000, first.session.generation, 2, 'newer-hold');
      await settle();
      expect(openCode.state.sent).toHaveLength(1);
      expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('delivers the head of the queue when the session goes idle, in order', async () => {
    const { runtime, openCode, emit, promptSent, broadcasts } = createRuntime();
    runtime.start();
    openCode.state.statuses = { [SESSION]: { type: 'busy' } };

    const first = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first', text: 'first' }));
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'second', text: 'second' }), undefined, first.session.generation);
    await settle();
    expect(openCode.state.sent).toHaveLength(0);

    openCode.state.statuses = {};
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(openCode.state.sent).toHaveLength(1);
    expect(openCode.state.sent[0].path).toBe(`/session/${SESSION}/prompt_async`);
    expect(openCode.state.sent[0].body).toEqual({
      model: { providerID: 'anthropic', modelID: 'claude' },
      agent: 'build',
      parts: [{ type: 'text', text: 'first' }],
    });
    expect(promptSent).toEqual([SESSION]);
    expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).toEqual(['second']);
    // Clients learned about the in-flight item and then the removal.
    expect(broadcasts.at(-1)).toMatchObject({
      type: 'openchamber:message-queue.updated',
      properties: { session: { sessionId: SESSION, sendingId: null } },
    });

    // The next turn: busy, then idle again — the second message goes out.
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'busy' } } });
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(2);
    expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
  });

  it('does not send into a running turn even when the status event says idle', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    openCode.state.tail = [{ info: { role: 'assistant', time: { created: 1 } } }];
    await runtime.enqueue(SESSION, DIRECTORY, item());
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(0);

    // The reply completes: that alone drains the queue (a missed idle event
    // must not strand it).
    openCode.state.tail = [{ info: { role: 'assistant', time: { created: 1, completed: 2 } } }];
    emit({ type: 'message.updated', properties: { info: { role: 'assistant', sessionID: SESSION, time: { created: 1, completed: 2 } } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(1);
  });

  it('re-checks a hold asserted while live idleness is awaiting OpenCode', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    const queued = await runtime.enqueue(SESSION, DIRECTORY, item());
    let resolveStatus;
    openCode.fetchImpl
      .mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve; }))
      .mockImplementationOnce(async () => Response.json([]));

    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle(10);
    expect(resolveStatus).toBeDefined();

    runtime.setHold(SESSION, DIRECTORY, true, 60_000, queued.session.generation, 1, 'hold-during-idle');
    resolveStatus(Response.json({}));
    await settle();

    expect(openCode.state.sent).toHaveLength(0);
    runtime.setHold(SESSION, DIRECTORY, false, 60_000, queued.session.generation, 2, 'hold-during-idle');
    await settle();
    expect(openCode.state.sent).toHaveLength(1);
  });

  it('wakes a queued session when its hold expires', async () => {
    const { runtime, openCode } = createRuntime();
    runtime.start();
    const queued = await runtime.enqueue(SESSION, DIRECTORY, item());
    runtime.setHold(SESSION, DIRECTORY, true, 20, queued.session.generation, 1, 'expiring-hold');

    await settle(10);
    expect(openCode.state.sent).toHaveLength(0);
    await settle(80);
    expect(openCode.state.sent).toHaveLength(1);
  });

  it('treats an unreachable OpenCode as unknown, not idle', async () => {
    const { runtime, openCode, emit } = createRuntime({ retryDelayMs: () => 10 });
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    openCode.state.failNext = /\/session\/status$/;
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle(5);
    expect(openCode.state.sent).toHaveLength(0);
    // Retried after the status fetch recovers.
    await settle(40);
    expect(openCode.state.sent).toHaveLength(1);
  });

  it('keeps a failed item and retries with backoff', async () => {
    const { runtime, openCode, emit, broadcasts } = createRuntime({ retryDelayMs: () => 20 });
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    openCode.state.failNext = /prompt_async$/;
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle(10);
    expect(openCode.state.sent).toHaveLength(0);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
    expect(runtime.sessionSnapshot(SESSION).sendingId).toBeNull();
    expect(broadcasts.at(-1).properties.session.sendingId).toBeNull();
    await settle(40);
    expect(openCode.state.sent).toHaveLength(1);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(0);
  });

  it('holds delivery briefly after a user abort', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    emit({ type: 'message.updated', properties: { info: { role: 'assistant', sessionID: SESSION, error: { name: 'MessageAbortedError' } } } });
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle(10);
    expect(openCode.state.sent).toHaveLength(0);
    await settle(80);
    expect(openCode.state.sent).toHaveLength(1);
  });

  it('honors a hold until it is released', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    runtime.setHold(SESSION, DIRECTORY, true, 60_000, 1, 1, 'incarnation-a');
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(0);

    runtime.setHold(SESSION, DIRECTORY, false, 60_000, 1, 2, 'incarnation-a');
    await settle();
    expect(openCode.state.sent).toHaveLength(1);
  });

  it('does not let a delayed first assertion replace an active hold owner', async () => {
    const { runtime } = createRuntime();
    await runtime.enqueue(SESSION, DIRECTORY, item());

    expect(runtime.setHold(SESSION, DIRECTORY, true, 60_000, 1, 1, 'token-b')).toMatchObject({ held: true, sequence: 1 });
    expect(runtime.setHold(SESSION, DIRECTORY, true, 60_000, 1, 1, 'token-a')).toMatchObject({ held: true, sequence: 1 });
    expect(runtime.setHold(SESSION, DIRECTORY, false, 60_000, 1, 2, 'token-b')).toMatchObject({ held: false, sequence: 2 });
  });

  it('allows a different token to establish sequence one after release', async () => {
    const { runtime } = createRuntime();
    await runtime.enqueue(SESSION, DIRECTORY, item());

    runtime.setHold(SESSION, DIRECTORY, true, 60_000, 1, 1, 'token-b');
    runtime.setHold(SESSION, DIRECTORY, false, 60_000, 1, 2, 'token-b');

    expect(runtime.setHold(SESSION, DIRECTORY, true, 60_000, 1, 1, 'token-a')).toMatchObject({ held: true, sequence: 1 });
  });

  it('allows a different token to establish sequence one after expiry', async () => {
    let currentTime = 0;
    const { runtime } = createRuntime({ now: () => currentTime });
    await runtime.enqueue(SESSION, DIRECTORY, item());

    expect(runtime.setHold(SESSION, DIRECTORY, true, 20, 1, 1, 'token-b')).toMatchObject({ held: true, expiresAt: 20, sequence: 1 });
    currentTime = 20;

    expect(runtime.setHold(SESSION, DIRECTORY, true, 60_000, 1, 1, 'token-a')).toMatchObject({ held: true, sequence: 1 });
  });

  it('ignores a lower sequence from the active hold token', async () => {
    const { runtime } = createRuntime();
    await runtime.enqueue(SESSION, DIRECTORY, item());

    runtime.setHold(SESSION, DIRECTORY, true, 60_000, 1, 3, 'token-a');

    expect(runtime.setHold(SESSION, DIRECTORY, false, 60_000, 1, 2, 'token-a')).toMatchObject({ held: true, sequence: 3 });
  });

  it('carries a generation-zero hold across the first enqueue for captured cleanup', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    expect(runtime.setHold(SESSION, DIRECTORY, true, 60_000, 0, 1, 'captured-before-enqueue')).toMatchObject({ held: true, sequence: 1 });

    const queued = await runtime.enqueue(SESSION, DIRECTORY, item());
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(0);

    expect(runtime.setHold(SESSION, DIRECTORY, false, 60_000, 0, 2, 'captured-before-enqueue')).toMatchObject({ held: false, sequence: 2 });
    await settle();
    expect(openCode.state.sent).toHaveLength(1);
    expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
    expect(queued.session.generation).toBe(1);
  });

  it('does not let a new incarnation take over an active hold', async () => {
    const { runtime } = createRuntime();
    await runtime.enqueue(SESSION, DIRECTORY, item());

    expect(runtime.setHold(SESSION, DIRECTORY, true, 60_000, 1, 1, 'old-incarnation').held).toBe(true);
    expect(runtime.setHold(SESSION, DIRECTORY, true, 60_000, 1, 1, 'new-incarnation')).toMatchObject({ held: true, sequence: 1 });
    expect(runtime.setHold(SESSION, DIRECTORY, false, 60_000, 1, 2, 'old-incarnation')).toMatchObject({ held: false, sequence: 2 });
    expect(runtime.setHold(SESSION, DIRECTORY, true, 60_000, 1, 1, 'new-incarnation')).toMatchObject({ held: true, sequence: 1 });
    expect(runtime.setHold(SESSION, DIRECTORY, false, 60_000, 1, 2, 'new-incarnation')).toMatchObject({ held: false, sequence: 2 });
  });

  it('does not let a different token release an active hold without ordering history', async () => {
    const { runtime } = createRuntime();
    await runtime.enqueue(SESSION, DIRECTORY, item());

    expect(runtime.setHold(SESSION, DIRECTORY, true, 60_000, 1, 1, 'token-b')).toMatchObject({ held: true, sequence: 1 });
    expect(runtime.setHold(SESSION, DIRECTORY, false, 60_000, 1, undefined, 'token-a')).toMatchObject({ held: true, sequence: 1 });
    expect(runtime.setHold(SESSION, DIRECTORY, false, 60_000, 1, 1, 'token-a')).toMatchObject({ held: true, sequence: 1 });
    expect(runtime.setHold(SESSION, DIRECTORY, false, 60_000, 1, 2, 'token-b')).toMatchObject({ held: false, sequence: 2 });
  });

  it('rejects an old hold after deletion and session-id reuse', async () => {
    const { runtime } = createRuntime();
    await runtime.load();
    const first = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first incarnation' }));
    expect(runtime.setHold(SESSION, DIRECTORY, true, 60_000, first.session.generation, 1, 'old-incarnation').held).toBe(true);

    await runtime.processPayload({ type: 'session.deleted', properties: { info: { id: SESSION } } });
    await runtime.processPayload({ type: 'session.created', properties: { info: { id: SESSION, directory: DIRECTORY } } });
    const reused = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'reused session' }), undefined, 3);

    expect(runtime.snapshot().sessionLifecycles[SESSION].generation).toBe(3);
    expect(() => runtime.setHold(SESSION, DIRECTORY, false, 60_000, first.session.generation, 2, 'old-incarnation')).toThrow(expect.objectContaining({ status: 409, generation: 3 }));
    expect(runtime.setHold(SESSION, DIRECTORY, true, 60_000, reused.session.generation, 1, 'new-incarnation')).toMatchObject({ held: true, sequence: 1 });
  });

  it('survives a restart and delivers once OpenCode reconnects', async () => {
    const dataDir = makeDataDir();
    const first = createRuntime({ dataDir });
    first.runtime.start();
    first.openCode.state.statuses = { [SESSION]: { type: 'busy' } };
    await first.runtime.enqueue(SESSION, DIRECTORY, item({ content: 'persisted', text: 'persisted', contextPreview: 'Saved context preview' }));
    await first.runtime.flush();
    first.runtime.stop();

    const second = createRuntime({ dataDir });
    second.runtime.start();
    await second.runtime.load();
    expect(second.runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).toEqual(['persisted']);
    expect(second.runtime.sessionSnapshot(SESSION).items[0].contextPreview).toBe('Saved context preview');
    second.connect();
    await settle();
    expect(second.openCode.state.sent).toHaveLength(1);
    expect(second.openCode.state.sent[0].body.parts).toEqual([{ type: 'text', text: 'persisted' }]);
  });

  it('moves an unreadable queue file aside instead of treating it as empty', async () => {
    const dataDir = makeDataDir();
    fs.writeFileSync(path.join(dataDir, 'message-queue.json'), '{ not json');
    const { runtime } = createRuntime({ dataDir });
    await runtime.load();
    expect(runtime.snapshot().sessions).toEqual([]);
    expect(fs.readdirSync(dataDir).some((name) => name.startsWith('message-queue.json.corrupt-'))).toBe(true);
  });

  it.each([
    ['version', { version: 1 }],
    ['revision', { revision: '1' }],
    ['sessions', { sessions: [] }],
    ['lifecycles', { sessionLifecycles: [] }],
    ['receipts', { takeReceipts: [] }],
    ['restore history', { completedRestores: [] }],
    ['enqueue history', { enqueueIdempotency: [] }],
  ])('quarantines a structurally invalid %s envelope', async (_field, invalidField) => {
    const dataDir = makeDataDir();
    const original = JSON.stringify(persistedEnvelope({ revision: 7, sessions: { [SESSION]: { directory: DIRECTORY, items: [{ id: 'recoverable', createdAt: 1, ...item() }] } }, ...invalidField }));
    const filePath = path.join(dataDir, 'message-queue.json');
    fs.writeFileSync(filePath, original);
    const { runtime } = createRuntime({ dataDir, dispatchQuietMs: 60_000 });

    await runtime.load();

    const backupName = fs.readdirSync(dataDir).find((name) => name.startsWith('message-queue.json.corrupt-'));
    expect(backupName).toBeDefined();
    expect(fs.readFileSync(path.join(dataDir, backupName), 'utf8')).toBe(original);
    expect(runtime.snapshot().sessions).toEqual([]);

    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'after quarantine' }));
    expect(fs.readFileSync(path.join(dataDir, backupName), 'utf8')).toBe(original);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).sessions[SESSION]).toBeDefined();
  });

  it('does not overwrite a structurally invalid file when quarantine fails during load', async () => {
    const dataDir = makeDataDir();
    const original = JSON.stringify(persistedEnvelope({ sessions: [] }));
    const filePath = path.join(dataDir, 'message-queue.json');
    fs.writeFileSync(filePath, original);
    const { runtime } = createRuntime({ dataDir });
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockRejectedValue(new Error('quarantine denied'));

    try {
      await expect(runtime.load()).rejects.toThrow('quarantine denied');
      await expect(runtime.enqueue(SESSION, DIRECTORY, item())).rejects.toThrow('quarantine denied');
      expect(fs.readFileSync(filePath, 'utf8')).toBe(original);
      expect(runtime.snapshot().sessions).toEqual([]);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('keeps valid queue siblings when individual persisted entries are malformed', async () => {
    const dataDir = makeDataDir();
    fs.writeFileSync(path.join(dataDir, 'message-queue.json'), JSON.stringify(persistedEnvelope({
      sessions: {
        [SESSION]: { directory: DIRECTORY, items: [{ id: 'valid-sibling', createdAt: 1, ...item({ content: 'valid' }) }, { id: 'invalid-sibling', createdAt: 1, content: 'cannot send' }] },
        ses_bad_entry: { directory: DIRECTORY, items: 'not-a-list' },
      },
      sessionLifecycles: {
        [SESSION]: { generation: 1, deleted: false, directory: DIRECTORY },
        ses_bad_lifecycle: { generation: 'not-a-number', deleted: false },
      },
      takeReceipts: {
        validReceipt: { operationId: 'validReceipt', sessionId: SESSION, directory: DIRECTORY, kind: 'all', itemId: null, revision: 1, generation: 1, createdAt: 1, items: [] },
        invalidReceipt: { operationId: 'invalidReceipt', sessionId: SESSION, directory: DIRECTORY, kind: 'all', itemId: null, revision: 'not-a-number', generation: 1, createdAt: 1, items: [] },
      },
      completedRestores: {
        validRestore: { operationId: 'validRestore', sessionId: SESSION, directory: DIRECTORY, revision: 1, generation: 1, createdAt: 1, itemIds: ['valid-sibling'], fingerprint: 'fingerprint' },
        invalidRestore: { operationId: 'invalidRestore', sessionId: SESSION, directory: DIRECTORY, revision: 1, generation: 1, createdAt: 'not-a-number', itemIds: ['invalid-sibling'], fingerprint: 'fingerprint' },
      },
      enqueueIdempotency: {
        validEnqueue: { operationId: 'validEnqueue', sessionId: SESSION, idempotencyKey: 'valid', itemId: 'valid-sibling', fingerprint: 'fingerprint', generation: 1, createdAt: 1 },
        invalidEnqueue: { operationId: 'invalidEnqueue', sessionId: SESSION, idempotencyKey: 'invalid', itemId: 'invalid-sibling', fingerprint: 'fingerprint', generation: 'not-a-number', createdAt: 1 },
      },
    })));
    const { runtime } = createRuntime({ dataDir, dispatchQuietMs: 60_000 });

    await runtime.load();

    expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).toEqual(['valid']);
    expect(runtime.snapshot().sessionLifecycles).not.toHaveProperty('ses_bad_lifecycle');
    expect(runtime.snapshot().sessions).toHaveLength(1);
  });

  it('refuses to remove or take the item currently being sent', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    let release;
    // status map, message tail, then the prompt itself (held open until released)
    openCode.fetchImpl.mockImplementationOnce(async () => Response.json({}))
      .mockImplementationOnce(async () => Response.json([]))
      .mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(new Response(null, { status: 204 })); }));
    const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, item());
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(runtime.sessionSnapshot(SESSION).sendingId).toBe(itemId);

    await expect(runtime.remove(SESSION, DIRECTORY, itemId, 1)).rejects.toMatchObject({ status: 409 });
    await expect(runtime.take(SESSION, DIRECTORY, itemId, false, undefined, 1)).rejects.toMatchObject({ status: 409 });
    const taken = await runtime.takeAll(SESSION, DIRECTORY, undefined, 1);
    expect(taken.items).toEqual([]);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);

    release();
    await settle();
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(0);
  });

  it('take hands back the full payload and leaves the rest queued', async () => {
    const { runtime } = createRuntime({ dispatchQuietMs: 60_000 });
    runtime.start();
    const attachment = { id: 'a1', filename: 'shot.png', mimeType: 'image/png', size: 3, source: 'local', dataUrl: 'data:image/png;base64,AAA=' };
    const first = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'with image', attachments: [attachment] }));
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain' }), undefined, first.session.generation);

    expect(runtime.sessionSnapshot(SESSION).items[0].attachments[0]).not.toHaveProperty('dataUrl');
    const taken = await runtime.take(SESSION, DIRECTORY, first.itemId, false, undefined, first.session.generation);
    expect(taken.item.attachments[0].dataUrl).toBe(attachment.dataUrl);
    expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).toEqual(['plain']);

    const all = await runtime.takeAll(SESSION, DIRECTORY, undefined, first.session.generation);
    expect(all.items.map((entry) => entry.content)).toEqual(['plain']);
    expect(runtime.snapshot().sessions).toEqual([{
      sessionId: SESSION,
      directory: DIRECTORY,
      items: [],
      sendingId: null,
      generation: 1,
    }]);
  });

  it('retains a bounded context preview in snapshots and broadcasts without exposing the full payload', async () => {
    const { runtime, broadcasts } = createRuntime({ dispatchQuietMs: 60_000 });
    runtime.start();
    const context = [{ kind: 'context', text: 'Full quoted content', metadata: { openchamberContext: { kind: 'chat-quote', quote: 'Original answer', text: 'Explain this' } } }];
    const { itemId, session } = await runtime.enqueue(SESSION, DIRECTORY, item({ content: '', text: '', context, contextPreview: 'Explain this' }));
    const projected = runtime.sessionSnapshot(SESSION).items[0];
    expect(projected.contextPreview).toBe('Explain this');
    expect(projected.content).toBe('');
    expect(projected.text).toBe('');
    expect(projected).not.toHaveProperty('context');
    expect(broadcasts.at(-1).properties.session.items[0].contextPreview).toBe('Explain this');
    const taken = await runtime.take(SESSION, DIRECTORY, itemId, false, undefined, session.generation);
    expect(taken.item.context).toEqual(context);
    expect(taken.item.content).toBe('');

    await runtime.enqueue(SESSION, DIRECTORY, item({ content: '', text: '', context, contextPreview: 'a'.repeat(5000) }), undefined, session.generation);
    expect(runtime.sessionSnapshot(SESSION).items[0].contextPreview).toBe('a'.repeat(100) + '...');
  });

  it('derives a preview for older queued annotations without a saved summary', async () => {
    const { runtime } = createRuntime({ dispatchQuietMs: 60_000 });
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: '', text: '', context: [
      { kind: 'instruction', text: 'Use the skill' },
      { kind: 'context', text: 'Model-facing wrapper', metadata: { openchamberContext: { kind: 'browser-annotation', text: 'Fix the button\nMore detail' } } },
    ] }));
    expect(runtime.sessionSnapshot(SESSION).items[0].contextPreview).toBe('Fix the button...');
  });

  it('names the directory in the broadcast that empties a queue', async () => {
    // The UI keys its projection by directory; without it the client cannot
    // tell which queue just delivered its last message and keeps showing it.
    const { runtime, emit, broadcasts, openCode } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    openCode.state.statuses = {};
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(openCode.state.sent).toHaveLength(1);
    expect(runtime.snapshot().sessions).toEqual([{
      sessionId: SESSION,
      directory: DIRECTORY,
      items: [],
      sendingId: null,
      generation: 1,
    }]);
    expect(broadcasts.at(-1).properties.session).toEqual({ sessionId: SESSION, directory: DIRECTORY, items: [], sendingId: null, generation: 1 });
  });

  it('reorders only with a complete permutation', async () => {
    const { runtime } = createRuntime({ dispatchQuietMs: 60_000 });
    runtime.start();
    const a = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'a' }));
    const b = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'b' }), undefined, a.session.generation);
    await expect(runtime.reorder(SESSION, DIRECTORY, [b.itemId], a.session.generation)).rejects.toThrow(TypeError);
    await runtime.reorder(SESSION, DIRECTORY, [b.itemId, a.itemId], a.session.generation);
    expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).toEqual(['b', 'a']);
  });

  it('drops the queue of a deleted session', async () => {
    const { runtime, emit, broadcasts } = createRuntime({ dispatchQuietMs: 60_000 });
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    await emit({ type: 'session.deleted', properties: { info: { id: SESSION } } });
    expect(runtime.snapshot().sessions).toEqual([]);
    expect(broadcasts.at(-1).properties.session).toMatchObject({ sessionId: SESSION, items: [] });
  });

  it('rejects stale mutations after deletion until the new incarnation is explicit', async () => {
    const { runtime, emit } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    emit({ type: 'session.deleted', properties: { info: { id: SESSION } } });

    await expect(runtime.enqueue(SESSION, DIRECTORY, item({ content: 'stale' }))).rejects.toMatchObject({ status: 409 });
    runtime.processPayload({ type: 'session.created', properties: { info: { id: SESSION, directory: DIRECTORY } } });
    expect(runtime.sessionSnapshot(SESSION).generation).toBe(3);
    const accepted = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'new incarnation' }), undefined, 3);

    expect(accepted.session.items.map((entry) => entry.content)).toEqual(['new incarnation']);
    expect(accepted.session.generation).toBe(3);
  });

  it('enforces the 50-session cap while restoring persisted queues', async () => {
    const dataDir = makeDataDir();
    const sessions = Object.fromEntries(Array.from({ length: 51 }, (_, index) => {
      const sessionId = `ses_restore_${String(index).padStart(2, '0')}`;
      return [sessionId, { directory: DIRECTORY, items: [{ id: `queued-${index}`, createdAt: index, ...item({ content: `message-${index}` }) }] }];
    }));
    fs.writeFileSync(path.join(dataDir, 'message-queue.json'), JSON.stringify(persistedEnvelope({ revision: 51, sessions })));

    const { runtime } = createRuntime({ dataDir });
    await runtime.load();

    expect(runtime.snapshot().sessions).toHaveLength(50);
    expect(runtime.snapshot().sessions.some((session) => session.sessionId === 'ses_restore_00')).toBe(false);
    expect(runtime.snapshot().sessions.some((session) => session.sessionId === 'ses_restore_50')).toBe(true);
  });

  it('keeps restored items when the queue is full and evicts older queued items first', async () => {
    const { runtime } = createRuntime({ dispatchQuietMs: 60_000 });
    const queued = [];
    for (let index = 0; index < 20; index += 1) {
      const accepted = await runtime.enqueue(SESSION, DIRECTORY, item({ content: `message-${index}` }), undefined, index === 0 ? undefined : 1);
      queued.push(accepted);
    }
    const taken = await runtime.take(SESSION, DIRECTORY, queued[0].itemId, false, 'restore-capacity', 1);
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'newest' }), undefined, 1);

    await runtime.restore(SESSION, DIRECTORY, [taken.item], taken.generation, 'restore-capacity');

    const ids = runtime.sessionSnapshot(SESSION).items.map((entry) => entry.id);
    expect(ids).toHaveLength(20);
    expect(ids).toContain(taken.item.id);
    expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).not.toContain('message-1');
  });

  it('dispatches a queued slash command through the command endpoint', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    openCode.state.commands = [{ name: 'review' }];
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: '/review src', text: '/review src', sendConfig: { providerID: 'p', modelID: 'm', agent: 'build', variant: 'max' } }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(1);
    expect(openCode.state.sent[0].path).toBe(`/session/${SESSION}/command`);
    expect(openCode.state.sent[0].body).toEqual({ command: 'review', arguments: 'src', model: 'p/m', agent: 'build', variant: 'max' });
  });

  it('delivers captured context as synthetic parts, instructions first, before project knowledge', async () => {
    const knowledge = {
      resolvePendingForSession: async () => ({ text: 'pinned notes', signature: 'sig-1' }),
      recordDelivered: async () => {},
    };
    const { runtime, openCode, emit } = createRuntime({ knowledge });
    runtime.start();
    const metadata = { openchamberContext: { kind: 'github-pr', number: 7, title: 'PR', url: 'https://x/pr/7' } };
    await runtime.enqueue(SESSION, DIRECTORY, item({
      agentMention: 'reviewer',
      attachments: [{ id: 'a', filename: 'f.txt', mimeType: 'text/plain', size: 1, source: 'local', dataUrl: 'data:text/plain,hi' }],
      context: [
        { kind: 'context', text: 'the diff', metadata, instructions: 'how to read it' },
        { kind: 'synthetic', text: 'conflict payload' },
        { kind: 'instruction', text: 'use the skill' },
      ],
    }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent[0].body.parts).toEqual([
      { type: 'text', text: 'follow up' },
      { type: 'file', mime: 'text/plain', filename: 'f.txt', url: 'data:text/plain,hi' },
      { type: 'text', text: 'how to read it', synthetic: true },
      { type: 'text', text: 'the diff', synthetic: true, metadata },
      { type: 'text', text: 'conflict payload', synthetic: true },
      { type: 'text', text: 'use the skill', synthetic: true },
      { type: 'text', text: 'pinned notes', synthetic: true },
      { type: 'agent', name: 'reviewer' },
    ]);
  });

  it('keeps files on the command route, which is all that route accepts', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    openCode.state.commands = [{ name: 'review' }];
    await runtime.enqueue(SESSION, DIRECTORY, item({
      content: '/review',
      text: '/review',
      attachments: [{ id: 'a', filename: 'f.txt', mimeType: 'text/plain', size: 1, source: 'local', dataUrl: 'data:text/plain,hi' }],
    }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent[0].path).toBe(`/session/${SESSION}/command`);
    expect(openCode.state.sent[0].body.parts).toEqual([{ type: 'file', mime: 'text/plain', filename: 'f.txt', url: 'data:text/plain,hi' }]);
  });

  it('sends a command queued with context as its expanded prompt, context included', async () => {
    // The command route rejects text parts, so a command with captured
    // context takes the prompt route with the template expanded, exactly as
    // the composer does.
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    openCode.state.commands = [{ name: 'review', source: 'command', template: 'Review $1 with focus on $2' }];
    const metadata = { openchamberContext: { kind: 'chat-quote', quote: 'q', text: 'why?' } };
    await runtime.enqueue(SESSION, DIRECTORY, item({
      content: '/review src "error handling"',
      text: '/review src "error handling"',
      context: [{ kind: 'context', text: 'quoted', metadata }],
    }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent[0].path).toBe(`/session/${SESSION}/prompt_async`);
    expect(openCode.state.sent[0].body.parts).toEqual([
      { type: 'text', text: 'Review src with focus on error handling' },
      { type: 'text', text: 'quoted', synthetic: true, metadata },
    ]);
  });

  it('sends a skill queued with context as an explicit invocation, context included', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    openCode.state.commands = [{ name: 'grill', source: 'skill', template: 'skill body' }];
    await runtime.enqueue(SESSION, DIRECTORY, item({
      content: '/grill auth',
      text: '/grill auth',
      context: [{ kind: 'synthetic', text: 'focus on tests' }],
    }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent[0].path).toBe(`/session/${SESSION}/prompt_async`);
    expect(openCode.state.sent[0].body.parts).toEqual([
      { type: 'text', text: '/grill auth' },
      { type: 'text', text: 'focus on tests', synthetic: true },
      { type: 'text', text: 'The user explicitly invoked the grill skill. Use the corresponding skill tool to handle this request.', synthetic: true },
    ]);
  });

  it('keeps captured context out of snapshots and broadcasts, and hands it back on take', async () => {
    const { runtime, broadcasts } = createRuntime({ dispatchQuietMs: 60_000 });
    runtime.start();
    const context = [{ kind: 'synthetic', text: 'a large diff' }];
    const queued = await runtime.enqueue(SESSION, DIRECTORY, item({ context }));
    expect(runtime.sessionSnapshot(SESSION).items[0]).not.toHaveProperty('context');
    expect(runtime.sessionSnapshot(SESSION).items[0].text).toBe('follow up');
    expect(broadcasts.at(-1).properties.session.items[0]).not.toHaveProperty('context');
    const taken = await runtime.take(SESSION, DIRECTORY, queued.itemId, false, undefined, queued.session.generation);
    expect(taken.item.context).toEqual(context);
  });

  it('attaches pending project knowledge and records its delivery', async () => {
    const recorded = [];
    const knowledge = {
      resolvePendingForSession: async () => ({ text: 'pinned notes', signature: 'sig-1' }),
      recordDelivered: async (sessionId, directory, signature) => { recorded.push({ sessionId, directory, signature }); },
    };
    const { runtime, openCode, emit } = createRuntime({ knowledge });
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item({ agentMention: 'reviewer', attachments: [{ id: 'a', filename: 'f.txt', mimeType: 'text/plain', size: 1, source: 'local', dataUrl: 'data:text/plain,hi' }] }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent[0].body.parts).toEqual([
      { type: 'text', text: 'follow up' },
      { type: 'file', mime: 'text/plain', filename: 'f.txt', url: 'data:text/plain,hi' },
      { type: 'text', text: 'pinned notes', synthetic: true },
      { type: 'agent', name: 'reviewer' },
    ]);
    expect(recorded).toEqual([{ sessionId: SESSION, directory: DIRECTORY, signature: 'sig-1' }]);
  });
});
