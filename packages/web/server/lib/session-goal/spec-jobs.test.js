import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMessageQueueRuntime } from '../message-queue/runtime.js';
import { RESTART_UNKNOWN_REASON, buildGoalItem, createGoalSpecJobRuntime } from './spec-jobs.js';

const SESSION = 'ses_goal_job_1';
const DIRECTORY = '/repo';
const SPEC = '## Objective\nShip the parser.';

const tempDirs = [];
const makeDataDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-goal-jobs-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const item = (overrides = {}) => ({
  content: 'build the parser',
  text: 'build the parser',
  attachments: [{ id: 'a1', filename: 'notes.txt', mimeType: 'text/plain', size: 5, source: 'local', dataUrl: 'data:text/plain;base64,aGVsbG8=' }],
  sendConfig: { providerID: 'anthropic', modelID: 'claude', agent: 'build' },
  ...overrides,
});

const createInput = (overrides = {}) => ({
  sessionId: SESSION,
  directory: DIRECTORY,
  sendMode: 'with-message',
  tokenBudget: 5000,
  writer: { request: 'build the parser', writerModelID: 'haiku', writerProviderID: 'anthropic' },
  item: item(),
  ...overrides,
});

/** A deferred spec per write call, so a test decides when each one lands. */
const controlledWriter = ({ ignoreAbort = false } = {}) => {
  const calls = [];
  const writeSpec = vi.fn((input) => new Promise((resolve, reject) => {
    calls.push({ input, resolve, reject });
    if (!ignoreAbort) input.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  return { calls, writeSpec };
};

/** The message queue as the job runtime uses it: enqueue by id, once. */
const fakeQueue = () => {
  const items = [];
  const enqueued = [];
  let failNext = null;
  return {
    items,
    enqueued,
    failNextEnqueue: (error) => { failNext = error; },
    load: async () => undefined,
    flush: async () => undefined,
    hasItem: (sessionId, itemId) => items.some((entry) => entry.sessionId === sessionId && entry.id === itemId),
    enqueue: vi.fn(async (sessionId, directory, queued, options) => {
      if (failNext) {
        const error = failNext;
        failNext = null;
        throw error;
      }
      enqueued.push({ sessionId, directory, item: queued, itemId: options?.itemId });
      if (!items.some((entry) => entry.id === options?.itemId)) items.push({ sessionId, id: options?.itemId, item: queued });
      return { itemId: options?.itemId };
    }),
  };
};

const createRuntime = ({ dataDir = makeDataDir(), queue = fakeQueue(), writer = controlledWriter(), fsImpl = fs.promises } = {}) => {
  let eventHandler = () => {};
  const broadcasts = [];
  let counter = 0;
  const runtime = createGoalSpecJobRuntime({
    messageQueue: queue,
    globalEventHub: { subscribeEvent(handler) { eventHandler = handler; return () => {}; } },
    broadcastGlobalUiEvent: (event) => broadcasts.push(event),
    dataDir,
    writeSpec: writer.writeSpec,
    createId: () => `job-${(counter += 1)}`,
    fs: fsImpl,
  });
  return {
    runtime,
    queue,
    writer,
    dataDir,
    broadcasts,
    emit: (payload) => eventHandler({ payload, translated: () => [payload] }),
  };
};

const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const readFile = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, 'goal-spec-jobs.json'), 'utf8'));

describe('goal spec jobs', () => {
  it('writes the spec and queues the held message with it as a settled goal, once', async () => {
    const { runtime, queue, writer, dataDir } = createRuntime();
    await runtime.start();
    const job = await runtime.create(createInput());
    expect(job).toMatchObject({ status: 'writing', content: 'build the parser', attachmentCount: 1 });
    // Saved before the writer has answered.
    expect(readFile(dataDir).jobs.map((entry) => entry.status)).toEqual(['writing']);
    expect(writer.calls[0].input).toMatchObject({ request: 'build the parser', directory: DIRECTORY, writerModelID: 'haiku' });

    writer.calls[0].resolve({ spec: SPEC });
    await settle();
    expect(queue.enqueued).toEqual([{
      sessionId: SESSION,
      directory: DIRECTORY,
      itemId: 'job-1',
      item: { ...item(), goal: { objective: SPEC, tokenBudget: 5000, settled: true, briefAgent: true } },
    }]);
    expect(await runtime.list()).toEqual([]);
    expect(readFile(dataDir).jobs).toEqual([]);
    runtime.stop();
  });

  it('sends the spec as the message, literally, in goal-as-message mode', () => {
    const queued = buildGoalItem({ ...createInput({ sendMode: 'goal-as-message' }), writer: { request: 'x', ignoreLimit: true } }, '/summarize this');
    expect(queued).toMatchObject({ content: '/summarize this', text: '/summarize this', promptOnly: true, goal: { objective: '/summarize this', settled: true, ignoreLimit: true } });
    expect(queued.goal.briefAgent).toBeUndefined();
  });

  it('keeps the job file readable by the owner only', async () => {
    const { runtime, dataDir } = createRuntime();
    await runtime.start();
    await runtime.create(createInput());
    expect(fs.statSync(path.join(dataDir, 'goal-spec-jobs.json')).mode & 0o777).toBe(0o600);
    runtime.stop();
  });

  it('refuses a message the queue could not send, and a client-supplied goal', async () => {
    const { runtime } = createRuntime();
    await runtime.start();
    await expect(runtime.create(createInput({ item: item({ sendConfig: undefined }) }))).rejects.toThrow(TypeError);
    await expect(runtime.create(createInput({ item: item({ goal: { tokenBudget: null } }) }))).rejects.toThrow(TypeError);
    await expect(runtime.create(createInput({ item: item({ content: '', text: '' }) }))).rejects.toThrow(TypeError);
    expect(await runtime.list()).toEqual([]);
    runtime.stop();
  });

  it('a failed write keeps the message, attachments included, for its composer to take back', async () => {
    const { runtime, queue, writer, broadcasts } = createRuntime();
    await runtime.start();
    await runtime.create(createInput());
    writer.calls[0].reject(new Error('No small model available'));
    await settle();
    expect(queue.enqueued).toEqual([]);
    expect(await runtime.list()).toMatchObject([{ id: 'job-1', status: 'failed', error: 'No small model available' }]);
    expect(broadcasts.at(-1)).toMatchObject({ type: 'openchamber:goal-spec-job.updated', properties: { job: { status: 'failed' } } });

    const taken = await runtime.take('job-1');
    expect(taken).toMatchObject({ sessionId: SESSION, directory: DIRECTORY, item: item() });
    expect(await runtime.list()).toEqual([]);
    await expect(runtime.take('job-1')).rejects.toMatchObject({ status: 404 });
    runtime.stop();
  });

  it('cancel stops the write and keeps the message for its composer, and a late spec is never queued', async () => {
    const { runtime, queue, writer, dataDir } = createRuntime();
    await runtime.start();
    await runtime.create(createInput());
    expect(await runtime.cancel('job-1')).toMatchObject({ status: 'failed', cancelled: true, error: null });
    expect(writer.calls[0].input.signal.aborted).toBe(true);
    writer.calls[0].resolve({ spec: SPEC });
    await settle();
    expect(queue.enqueued).toEqual([]);
    expect(readFile(dataDir).jobs).toMatchObject([{ status: 'failed', cancelled: true }]);
    expect((await runtime.take('job-1')).item).toEqual(item());
    runtime.stop();
  });

  it('a spec that lands after a cancel, from a writer deaf to its signal, is never queued', async () => {
    const { runtime, queue, writer } = createRuntime({ writer: controlledWriter({ ignoreAbort: true }) });
    await runtime.start();
    await runtime.create(createInput());
    await runtime.cancel('job-1');
    writer.calls[0].resolve({ spec: SPEC });
    await settle();
    expect(queue.enqueued).toEqual([]);
    expect(await runtime.list()).toMatchObject([{ status: 'failed', cancelled: true }]);
    runtime.stop();
  });

  it('taking a job back while it is written stops it, and a late spec is never queued', async () => {
    const { runtime, queue, writer } = createRuntime();
    await runtime.start();
    await runtime.create(createInput());
    await runtime.take('job-1');
    writer.calls[0].resolve({ spec: SPEC });
    await settle();
    expect(queue.enqueued).toEqual([]);
    runtime.stop();
  });

  it('a queue that refuses the message fails the job and keeps the message', async () => {
    const { runtime, queue, writer } = createRuntime();
    await runtime.start();
    await runtime.create(createInput());
    queue.failNextEnqueue(Object.assign(new Error('message queue is full'), { status: 409 }));
    writer.calls[0].resolve({ spec: SPEC });
    await settle();
    expect(await runtime.list()).toMatchObject([{ status: 'failed', error: 'message queue is full' }]);
    expect((await runtime.take('job-1')).item).toEqual(item());
    runtime.stop();
  });

  it('a job that cannot be saved is refused and leaves nothing behind', async () => {
    const failingFs = { ...fs.promises, rename: async () => { throw new Error('disk full'); } };
    const { runtime, writer } = createRuntime({ fsImpl: failingFs });
    await runtime.start();
    await expect(runtime.create(createInput())).rejects.toMatchObject({ status: 500 });
    expect(await runtime.list()).toEqual([]);
    expect(writer.calls).toEqual([]);
    runtime.stop();
  });

  it('follows its session to a new directory', async () => {
    const { runtime, queue, writer, emit } = createRuntime();
    await runtime.start();
    await runtime.create(createInput());
    emit({ type: 'session.updated', properties: { info: { id: SESSION, directory: '/repo-moved' } } });
    writer.calls[0].resolve({ spec: SPEC });
    await settle();
    expect(queue.enqueued[0].directory).toBe('/repo-moved');
    runtime.stop();
  });

  it('drops the job of a deleted session without queueing it', async () => {
    const { runtime, queue, writer, emit } = createRuntime();
    await runtime.start();
    await runtime.create(createInput());
    emit({ type: 'session.deleted', properties: { info: { id: SESSION } } });
    writer.calls[0].resolve({ spec: SPEC });
    await settle();
    expect(queue.enqueued).toEqual([]);
    expect(await runtime.list()).toEqual([]);
    runtime.stop();
  });
});

describe('goal spec jobs across a restart', () => {
  it('a job still being written when OpenChamber stopped is written again and queued once', async () => {
    const dataDir = makeDataDir();
    const queue = fakeQueue();
    const first = createRuntime({ dataDir, queue });
    await first.runtime.start();
    await first.runtime.create(createInput());
    first.runtime.stop();
    await first.runtime.flush();

    const second = createRuntime({ dataDir, queue });
    await second.runtime.start();
    expect(second.writer.calls).toHaveLength(1);
    second.writer.calls[0].resolve({ spec: SPEC });
    await settle();
    expect(queue.enqueued.map((entry) => entry.itemId)).toEqual(['job-1']);
    expect(readFile(dataDir).jobs).toEqual([]);
    second.runtime.stop();
  });

  it('a job resumed at start waits for OpenCode before writing', async () => {
    const dataDir = makeDataDir();
    const first = createRuntime({ dataDir });
    await first.runtime.start();
    await first.runtime.create(createInput());
    first.runtime.stop();
    await first.runtime.flush();

    let ready;
    const writer = controlledWriter();
    const second = createGoalSpecJobRuntime({
      messageQueue: fakeQueue(),
      dataDir,
      writeSpec: writer.writeSpec,
      waitForOpenCode: () => new Promise((resolve) => { ready = resolve; }),
    });
    const starting = second.start();
    await settle();
    expect(writer.calls).toEqual([]);
    // The held job is listed while it waits.
    expect(await second.list()).toMatchObject([{ status: 'writing' }]);
    ready();
    await starting;
    expect(writer.calls).toHaveLength(1);
    second.stop();
  });

  it('a session deleted while the jobs load is applied before anything resumes', async () => {
    const dataDir = makeDataDir();
    const first = createRuntime({ dataDir });
    await first.runtime.start();
    await first.runtime.create(createInput());
    first.runtime.stop();
    await first.runtime.flush();

    const second = createRuntime({ dataDir });
    const starting = second.runtime.start();
    // The file is still being read when the deletion arrives.
    second.emit({ type: 'session.deleted', properties: { sessionID: SESSION } });
    await starting;
    expect(second.writer.calls).toEqual([]);
    expect(await second.runtime.list()).toEqual([]);
    second.runtime.stop();
  });

  const storedEnqueuing = (dataDir) => {
    fs.writeFileSync(path.join(dataDir, 'goal-spec-jobs.json'), JSON.stringify({
      version: 1,
      jobs: [{
        id: 'job-9', sessionId: SESSION, directory: DIRECTORY, status: 'enqueuing', sendMode: 'with-message',
        tokenBudget: null, writer: { request: 'build the parser' }, item: item(), spec: SPEC, error: null, createdAt: 1, updatedAt: 1,
      }],
    }));
  };

  it('a job the queue already holds is left to the queue', async () => {
    const dataDir = makeDataDir();
    storedEnqueuing(dataDir);
    const queue = fakeQueue();
    queue.items.push({ sessionId: SESSION, id: 'job-9' });
    const { runtime, writer } = createRuntime({ dataDir, queue });
    await runtime.start();
    expect(queue.enqueued).toEqual([]);
    expect(writer.calls).toEqual([]);
    expect(await runtime.list()).toEqual([]);
    runtime.stop();
  });

  it('a job that may already have been sent is never sent again, and its message is kept', async () => {
    const dataDir = makeDataDir();
    storedEnqueuing(dataDir);
    const { runtime, queue, writer } = createRuntime({ dataDir });
    await runtime.start();
    expect(queue.enqueued).toEqual([]);
    expect(writer.calls).toEqual([]);
    expect(await runtime.list()).toMatchObject([{ id: 'job-9', status: 'failed', error: RESTART_UNKNOWN_REASON }]);
    expect((await runtime.take('job-9')).item).toEqual(item());
    runtime.stop();
  });

  // Oracle: conservation across a crash at any point. A model of the server
  // (job file, queue file, and what OpenCode received) is driven through the
  // real runtime, crashed after each successive write, and restarted. Every
  // message ends up exactly once in OpenCode or the queue, or is still held
  // as a job the user can take back. Never in two places, never in none.
  it('a crash after any write leaves each message delivered once or held, never both or neither', async () => {
    // crashAfter counts the job-file writes that land before the process dies.
    for (let crashAfter = 1; crashAfter < 6; crashAfter += 1) {
      const dataDir = makeDataDir();
      const queue = fakeQueue();
      let writes = 0;
      let crashed = false;
      const crashingFs = {
        ...fs.promises,
        rename: async (...args) => {
          if (crashed) throw new Error('crashed');
          await fs.promises.rename(...args);
          writes += 1;
          if (writes >= crashAfter) crashed = true;
        },
      };
      const first = createRuntime({ dataDir, queue, fsImpl: crashingFs });
      await first.runtime.start();
      await first.runtime.create(createInput()).catch(() => undefined);
      first.writer.calls[0]?.resolve({ spec: SPEC });
      await settle();
      first.runtime.stop();

      const second = createRuntime({ dataDir, queue });
      await second.runtime.start();
      second.writer.calls[0]?.resolve({ spec: SPEC });
      await settle();
      const held = await second.runtime.list();
      const queuedCount = queue.items.length;
      expect({ crashAfter, total: queuedCount + held.length }).toEqual({ crashAfter, total: 1 });
      // Enqueueing by id is idempotent, so a repeated call never adds a second item.
      expect(new Set(queue.enqueued.map((entry) => entry.itemId)).size).toBe(queuedCount);
      second.runtime.stop();
    }
  });
});

describe('goal spec jobs with the real message queue', () => {
  it('delivers the message with its goal through the queue, with no window open', async () => {
    const dataDir = makeDataDir();
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    const sent = [];
    const persisted = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const { pathname } = new URL(url);
      const method = init.method ?? 'GET';
      if (pathname === '/api/session/active') return Response.json({ data: {} });
      if (pathname === '/api/session' && method === 'GET') return Response.json({ data: [], cursor: {} });
      if (/^\/api\/session\/[^/]+$/.test(pathname) && method === 'GET') return Response.json({ location: { directory: DIRECTORY }, data: { id: decodeURIComponent(pathname.split('/').at(-1)) } });
      if (pathname.endsWith('/message')) return Response.json({ data: [], cursor: {} });
      if (pathname === '/api/command') return Response.json({ location: { directory: DIRECTORY }, data: [{ name: 'summarize' }] });
      if (method === 'POST' && (pathname.endsWith('/model') || pathname.endsWith('/agent'))) return new Response(null, { status: 204 });
      if (method === 'POST') {
        sent.push({ path: pathname, body: JSON.parse(init.body) });
        return Response.json({ location: { directory: DIRECTORY }, data: { id: `msg_${sent.length}` } });
      }
      return new Response('not found', { status: 404 });
    });
    const queue = createMessageQueueRuntime({
      globalEventHub: { subscribeEvent: () => () => {}, subscribeStatus: () => () => {} },
      buildOpenCodeUrl: (fetchPath) => `http://opencode.test${fetchPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      broadcastGlobalUiEvent: () => {},
      persistSessionGoal: async (sessionID, directory, goal) => { persisted.push({ sessionID, goal }); },
      dataDir,
      fetchImpl,
      dispatchQuietMs: 0,
    });
    queue.start();
    const writer = controlledWriter();
    const { runtime } = createRuntime({ dataDir, queue, writer });
    await runtime.start();
    await runtime.create(createInput({ sendMode: 'goal-as-message', item: item({ attachments: [] }) }));
    writer.calls[0].resolve({ spec: '/summarize the parser work' });
    await settle(80);

    const prompts = sent.filter((entry) => entry.path.endsWith('/prompt'));
    // Literal text, never the `summarize` command, and exactly once.
    expect(sent.filter((entry) => entry.path.endsWith('/command'))).toEqual([]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].body.text).toBe('/summarize the parser work');
    expect(persisted).toHaveLength(1);
    expect(queue.sessionSnapshot(SESSION).items).toEqual([]);
    runtime.stop();
    queue.stop();
    await queue.flush();
  });
});
