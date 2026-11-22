// Goal writer jobs: "Send when ready" handed to the server. A job holds the
// captured message (a message-queue item) and the writer's input. The server
// writes the spec, then puts the message into the session's message queue
// with the spec as its goal, so the queue delivers it with the goal exactly
// as a queued "run as goal" message: whether or not any window is open, and
// across an OpenChamber restart. Clients follow jobs on the control stream
// (`openchamber:goal-spec-job.updated`) and take a failed job's message back
// into its composer. VS Code has no goal loop and does not use this module.
//
// Exactly once. A job moves writing -> enqueuing -> (removed). `enqueuing` is
// saved, with the spec, before the queue sees the message; the queue item
// carries the job's id, and enqueueing that id again is a no-op. A restart
// finds an `enqueuing` job and asks the queue: still there means the queue
// owns it and the job goes; gone means it was either never queued or already
// sent, and the server cannot tell which, so the job fails with the message
// kept for the user to check and resend. A restart in `writing` writes again:
// nothing has left the server.

import fsPromises from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { parseQueuedItemInput } from '../message-queue/runtime.js';
import {
  isJsonObject,
  preserveMalformedJsonFile,
  readDurableJsonFile,
  writeDurableJsonFile,
} from '../shared/durable-json-store.js';
import { writeGoalSpec } from './spec-writer.js';

const JOBS_FILE_NAME = 'goal-spec-jobs.json';
const JOBS_FILE_VERSION = 1;
// Held messages are conversation content: readable by the owner only.
const JOBS_FILE_MODE = 0o600;
// Attachments ride along as data URLs; the message queue's route allows 50 MB
// per item, so the file is read with room for several such jobs.
const JOBS_FILE_MAX_BYTES = 256 * 1024 * 1024;
// A full table refuses a new job rather than evicting one: an evicted job is a
// message lost.
const MAX_JOBS = 50;
const EVENT_TYPE = 'openchamber:goal-spec-job.updated';

export const RESTART_UNKNOWN_REASON = 'OpenChamber restarted while this message was being handed to the session, so it may already have been sent. Check the session before sending it again.';
const SAVE_FAILED_REASON = 'the goal spec was written, but it could not be saved, so the message was not sent';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;

const optionalText = z.string().optional();
const writerInputSchema = z.object({
  request: z.string().trim().min(1),
  conversation: optionalText,
  openItems: optionalText,
  providerID: optionalText,
  modelID: optionalText,
  writerProviderID: optionalText,
  writerModelID: optionalText,
  writerVariant: optionalText,
  section: optionalText,
  currentSpec: optionalText,
  ignoreLimit: z.boolean().optional(),
});

const sendModeSchema = z.enum(['with-message', 'goal-as-message']);
const tokenBudgetSchema = z.number().int().positive().nullable();

const createInputSchema = z.object({
  sessionId: z.string().regex(SESSION_ID_PATTERN),
  directory: z.string().trim().min(1),
  sendMode: sendModeSchema,
  tokenBudget: tokenBudgetSchema.optional().transform((value) => value ?? null),
  writer: writerInputSchema,
  item: z.unknown(),
});

const storedJobSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().regex(SESSION_ID_PATTERN),
  directory: z.string().min(1),
  status: z.enum(['writing', 'enqueuing', 'failed']),
  sendMode: sendModeSchema,
  tokenBudget: tokenBudgetSchema,
  writer: writerInputSchema,
  item: z.unknown(),
  spec: z.string().nullable(),
  error: z.string().nullable(),
  // Stopped by the user while it was written; the message waits like a failed one's.
  cancelled: z.boolean().default(false),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const storedFileSchema = z.object({
  version: z.literal(JOBS_FILE_VERSION),
  jobs: z.array(z.unknown()),
});

const deletedSessionSchema = z.object({
  type: z.literal('session.deleted'),
  properties: z.object({
    info: z.object({ id: z.string().min(1) }).optional().catch(undefined),
    sessionID: z.string().min(1).optional().catch(undefined),
  }),
});
const movedSessionSchema = z.object({
  type: z.literal('session.updated'),
  properties: z.object({
    info: z.object({ id: z.string().min(1), directory: z.string().trim().min(1) }),
  }),
});

const writtenSpecSchema = z.object({ spec: z.string().trim().min(1) });

const httpError = (message, status) => Object.assign(new Error(message), { status });

/**
 * The client's item, checked as the queue will check it when the spec is
 * ready: a job must never hold a message nobody could send. The goal and the
 * schedule are the server's to set.
 */
const parseJobItem = (value) => {
  const raw = z.record(z.string(), z.unknown()).catch({}).parse(value);
  if (raw.goal !== undefined) throw new TypeError('the goal is written by the server');
  if (raw.scheduledTask !== undefined) throw new TypeError('scheduledTask is server-owned');
  const parsed = parseQueuedItemInput(raw);
  if (!parsed.text.trim()) throw new TypeError('the goal writer needs the message text');
  return raw;
};

/** The queue item a written spec turns the held message into. */
export const buildGoalItem = (job, spec) => {
  const goal = { objective: spec, tokenBudget: job.tokenBudget, settled: true };
  if (job.sendMode === 'with-message') goal.briefAgent = true;
  if (job.writer.ignoreLimit) goal.ignoreLimit = true;
  const item = { ...job.item, goal };
  if (job.sendMode === 'goal-as-message') {
    item.content = spec;
    item.text = spec;
    item.promptOnly = true;
  }
  return item;
};

/** What clients see: no attachment bytes, no captured context. */
const toPublicJob = (job) => {
  const item = parseQueuedItemInput(job.item);
  return {
    id: job.id,
    sessionId: job.sessionId,
    directory: job.directory,
    status: job.status,
    error: job.error,
    cancelled: job.cancelled === true,
    content: item.content,
    attachmentCount: item.attachments.length,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
};

export function createGoalSpecJobRuntime({
  messageQueue,
  globalEventHub = null,
  broadcastGlobalUiEvent = null,
  dataDir,
  writeSpec = writeGoalSpec,
  // Resolves once OpenCode answers: a job resumed at start writes its spec
  // through OpenCode, which the server may still be starting.
  waitForOpenCode = async () => undefined,
  now = Date.now,
  createId = () => `goaljob-${now()}-${Math.random().toString(36).slice(2, 10)}`,
  fs = fsPromises,
}) {
  const filePath = path.join(dataDir, JOBS_FILE_NAME);
  const jobs = new Map();
  const controllers = new Map();
  let loadPromise = null;
  let loaded = false;
  let writeChain = Promise.resolve();
  let stopped = false;
  // Session deletions that arrive while the file is still loading: applied
  // to the loaded jobs before any of them resumes.
  const deletedWhileLoading = new Set();

  const durableOptions = () => ({ fs, validateValue: isJsonObject, maxBytes: JOBS_FILE_MAX_BYTES });

  const readFile = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await readDurableJsonFile(filePath, durableOptions());
      if (result.state === 'missing') return [];
      if (result.state === 'malformed') {
        const preservation = await preserveMalformedJsonFile(filePath, durableOptions());
        if (preservation.outcome === 'failed') throw new Error('failed to preserve the unreadable goal job file; refusing to treat it as empty');
        if (preservation.outcome === 'replaced') continue;
        if (preservation.preserved) console.warn(`[goal-spec-jobs] job file was unreadable and moved to ${preservation.preservedPath}`);
        return [];
      }
      const stored = storedFileSchema.safeParse(result.value);
      if (!stored.success) return [];
      // One malformed job is dropped alone.
      return stored.data.jobs.flatMap((value) => {
        const job = storedJobSchema.safeParse(value);
        if (!job.success) return [];
        try {
          parseJobItem(job.data.item);
          return [job.data];
        } catch {
          return [];
        }
      });
    }
    return [];
  };

  /**
   * Saves the current table. Unlike the queue, a failed save rejects: a job
   * is accepted, or moved on, only once it is on disk.
   */
  const persist = () => {
    const payload = JSON.stringify({ version: JOBS_FILE_VERSION, jobs: Array.from(jobs.values()) });
    const write = writeChain.then(async () => {
      const preservation = await preserveMalformedJsonFile(filePath, durableOptions());
      if (preservation.outcome === 'failed') throw new Error('failed to preserve the unreadable goal job file; refusing to overwrite it');
      await writeDurableJsonFile(filePath, payload, { fs, mode: JOBS_FILE_MODE });
    });
    writeChain = write.catch(() => undefined);
    return write;
  };

  const broadcast = (properties) => {
    broadcastGlobalUiEvent?.({ type: EVENT_TYPE, properties });
  };
  const publish = (job) => broadcast({ job: toPublicJob(job) });
  const publishRemoved = (job, outcome) => broadcast({ removed: { id: job.id, sessionId: job.sessionId, directory: job.directory, outcome } });

  const fail = async (job, reason) => {
    job.status = 'failed';
    job.error = reason;
    job.updatedAt = now();
    await persist().catch((error) => {
      console.warn('[goal-spec-jobs] failed to save a failed job:', error?.message ?? error);
    });
    if (jobs.get(job.id) === job) publish(job);
  };

  /** Hands a job with a written spec to the queue, once. */
  const enqueue = async (job) => {
    if (jobs.get(job.id) !== job || stopped) return;
    try {
      await messageQueue.enqueue(job.sessionId, job.directory, buildGoalItem(job, job.spec), { itemId: job.id });
      await messageQueue.flush?.();
    } catch (error) {
      await fail(job, error instanceof Error && error.message ? error.message : 'the message could not be queued');
      return;
    }
    jobs.delete(job.id);
    await persist().catch((error) => {
      // The queue holds the message; a stale `enqueuing` entry on disk is
      // resolved at the next start by asking the queue.
      console.warn('[goal-spec-jobs] failed to save a queued job:', error?.message ?? error);
    });
    publishRemoved(job, 'queued');
  };

  const run = async (job) => {
    const controller = new AbortController();
    controllers.set(job.id, controller);
    let spec;
    try {
      const result = writtenSpecSchema.safeParse(await writeSpec({ ...job.writer, directory: job.directory, signal: controller.signal }));
      if (!result.success) throw new Error('The goal writer returned no spec');
      spec = result.data.spec;
    } catch (error) {
      if (controller.signal.aborted || jobs.get(job.id) !== job) return;
      await fail(job, error instanceof Error && error.message ? error.message : 'The goal writer could not write a spec');
      return;
    } finally {
      if (controllers.get(job.id) === controller) controllers.delete(job.id);
    }
    // Taken back or its session deleted while the spec was being written.
    if (controller.signal.aborted || jobs.get(job.id) !== job || stopped) return;
    job.status = 'enqueuing';
    job.spec = spec;
    job.updatedAt = now();
    try {
      await persist();
    } catch (error) {
      console.warn('[goal-spec-jobs] failed to save a written spec:', error?.message ?? error);
      // Not saved as `enqueuing`, so it must not be queued: a restart would
      // write it again and queue it a second time.
      await fail(job, SAVE_FAILED_REASON);
      return;
    }
    await enqueue(job);
  };

  const resume = async () => {
    for (const job of Array.from(jobs.values())) {
      if (job.status === 'writing') {
        void run(job);
      } else if (job.status === 'enqueuing') {
        await messageQueue.load?.().catch(() => undefined);
        if (messageQueue.hasItem(job.sessionId, job.id)) {
          jobs.delete(job.id);
          await persist().catch(() => undefined);
          publishRemoved(job, 'queued');
        } else {
          await fail(job, RESTART_UNKNOWN_REASON);
        }
      }
    }
  };

  const load = () => {
    if (!loadPromise) {
      loadPromise = readFile()
        .then(async (stored) => {
          for (const job of stored) {
            if (deletedWhileLoading.has(job.sessionId)) continue;
            jobs.set(job.id, job);
          }
          const dropped = stored.length !== jobs.size;
          deletedWhileLoading.clear();
          loaded = true;
          if (dropped) await persist().catch(() => undefined);
        })
        .catch((error) => {
          // A failed read is not "no jobs": writes stay off until a load succeeds.
          loadPromise = null;
          throw error;
        });
    }
    return loadPromise;
  };

  const create = async (input) => {
    const parsed = createInputSchema.parse(input);
    const item = parseJobItem(parsed.item);
    await load();
    if (jobs.size >= MAX_JOBS) throw httpError('too many goal specs are being written; wait for one to finish', 409);
    const at = now();
    const job = {
      id: createId(),
      sessionId: parsed.sessionId,
      directory: parsed.directory,
      status: 'writing',
      sendMode: parsed.sendMode,
      tokenBudget: parsed.tokenBudget,
      writer: parsed.writer,
      item,
      spec: null,
      error: null,
      cancelled: false,
      createdAt: at,
      updatedAt: at,
    };
    jobs.set(job.id, job);
    try {
      await persist();
    } catch (error) {
      // Only this job is rolled back: anything else changed since stays.
      if (jobs.get(job.id) === job) jobs.delete(job.id);
      throw httpError(`the message could not be saved: ${error?.message ?? error}`, 500);
    }
    publish(job);
    void run(job);
    return toPublicJob(job);
  };

  /**
   * Stops a job being written. Its message stays on the server, as a failed
   * job's does, until its composer takes it back: whichever window the user
   * pressed Cancel in, the message reaches the chat it was written for.
   */
  const cancel = async (id) => {
    await load();
    const job = jobs.get(id);
    if (!job) throw httpError('goal job not found', 404);
    if (job.status !== 'writing') return toPublicJob(job);
    controllers.get(id)?.abort();
    controllers.delete(id);
    job.status = 'failed';
    job.cancelled = true;
    job.error = null;
    job.updatedAt = now();
    try {
      await persist();
    } catch (error) {
      // Not saved: put it back to writing, so memory matches the file.
      job.status = 'writing';
      job.cancelled = false;
      void run(job);
      throw httpError(`the goal job could not be stopped: ${error?.message ?? error}`, 500);
    }
    publish(job);
    return toPublicJob(job);
  };

  /**
   * Takes a job back: Cancel while writing, or a failed job's message for its
   * composer. Returns the full item, attachments and context included. A job
   * already being handed to the queue cannot be taken.
   */
  const take = async (id) => {
    await load();
    const job = jobs.get(id);
    if (!job) throw httpError('goal job not found', 404);
    if (job.status === 'enqueuing') throw httpError('the message is being handed to the session', 409);
    jobs.delete(id);
    try {
      await persist();
    } catch (error) {
      if (!jobs.has(id)) jobs.set(id, job);
      throw httpError(`the goal job could not be removed: ${error?.message ?? error}`, 500);
    }
    controllers.get(id)?.abort();
    controllers.delete(id);
    publishRemoved(job, 'taken');
    return { id: job.id, sessionId: job.sessionId, directory: job.directory, item: job.item, error: job.error };
  };

  const list = async () => {
    await load();
    return Array.from(jobs.values()).map(toPublicJob);
  };

  const processPayload = (value) => {
    if (stopped) return;
    const deleted = deletedSessionSchema.safeParse(value);
    if (deleted.success) {
      const sessionId = deleted.data.properties.info?.id ?? deleted.data.properties.sessionID;
      if (!sessionId) return;
      if (!loaded) {
        deletedWhileLoading.add(sessionId);
        return;
      }
      const ended = Array.from(jobs.values()).filter((job) => job.sessionId === sessionId && job.status !== 'enqueuing');
      if (ended.length === 0) return;
      for (const job of ended) {
        jobs.delete(job.id);
        controllers.get(job.id)?.abort();
        controllers.delete(job.id);
      }
      void persist().catch(() => undefined);
      for (const job of ended) publishRemoved(job, 'session-deleted');
      return;
    }
    const moved = movedSessionSchema.safeParse(value);
    if (moved.success) {
      const { id, directory } = moved.data.properties.info;
      let changed = false;
      for (const job of jobs.values()) {
        if (job.sessionId !== id || job.directory === directory) continue;
        job.directory = directory;
        changed = true;
      }
      if (changed) void persist().catch(() => undefined);
    }
  };

  let unsubscribe = null;
  const start = () => {
    if (globalEventHub) {
      unsubscribe = globalEventHub.subscribeEvent((event) => {
        for (const payload of event?.translated?.() ?? []) processPayload(payload);
      });
    }
    return load()
      .then(() => (jobs.size > 0 ? waitForOpenCode() : undefined))
      .then(() => {
        if (stopped) return undefined;
        const pending = Array.from(jobs.values()).filter((job) => job.status !== 'failed').length;
        if (pending > 0) console.log(`[goal-spec-jobs] resuming ${pending} goal job(s)`);
        return resume();
      })
      .catch((error) => {
        console.warn('[goal-spec-jobs] failed to load goal jobs:', error?.message ?? error);
      });
  };

  const stop = () => {
    stopped = true;
    unsubscribe?.();
    // A write in progress is left to finish: the restart writes it again.
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
  };

  return {
    load,
    create,
    cancel,
    take,
    list,
    processPayload,
    start,
    stop,
    /** Drains the pending write; tests and shutdown use it. */
    flush: () => writeChain,
  };
}

export function registerGoalSpecJobRoutes(app, runtime) {
  const respondError = (res, error, fallback) => {
    const status = error instanceof TypeError || error instanceof z.ZodError
      ? 400
      : (Number.isInteger(error?.status) ? error.status : 500);
    res.status(status).json({ error: error instanceof z.ZodError ? 'invalid goal job' : (error?.message ?? fallback) });
  };

  app.get('/api/goals/spec-jobs', async (_req, res) => {
    try {
      res.json({ jobs: await runtime.list() });
    } catch (error) {
      respondError(res, error, 'Failed to read goal jobs');
    }
  });

  app.post('/api/goals/spec-jobs', async (req, res) => {
    try {
      res.json({ job: await runtime.create(req.body) });
    } catch (error) {
      respondError(res, error, 'Failed to start the goal job');
    }
  });

  app.post('/api/goals/spec-jobs/:jobId/cancel', async (req, res) => {
    try {
      res.json({ job: await runtime.cancel(req.params.jobId) });
    } catch (error) {
      respondError(res, error, 'Failed to stop the goal job');
    }
  });

  app.post('/api/goals/spec-jobs/:jobId/take', async (req, res) => {
    try {
      res.json(await runtime.take(req.params.jobId));
    } catch (error) {
      respondError(res, error, 'Failed to take the goal job');
    }
  });
}
