import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { assertOpenCodeApiResponse } from '../opencode/prompt-response.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';
import { createMessageId, readDispatchOutcome } from '../dispatch-results/runtime.js';

const FILE_NAME = 'auto-review.json';
const FILE_VERSION = 1;
const MAX_RUNS = 100;
export const MAX_ROUNDS = 5;
const QUIET_MS = 500;
const SUBAGENT_RECHECK_MS = 5_000;
const SETTLE_RECHECK_MS = 2_000;
const SETTLE_RECHECKS = 3;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 60_000;
const MAX_SEND_FAILURES = 5;
const FETCH_TIMEOUT_MS = 15_000;
const MESSAGE_PAGE_LIMIT = 50;
const PROMPT_CHAR_LIMIT = 100_000;
const ERROR_CHAR_LIMIT = 500;
const DISPUTE_CHAR_LIMIT = 2_000;

export const FINAL_MARKER_CLEAN = 'FINAL_REVIEW_STATUS: no_remaining_findings';
export const FINAL_MARKER_DISPUTED = 'FINAL_REVIEW_STATUS: disputed';
const DISPUTE_HEADING = 'Disputed findings:';

export const LOOP_RULES = `This review is part of an automatic review loop. End your response with one of these exact final lines when it applies:
${FINAL_MARKER_CLEAN}
when no blocker or non-blocker finding remains open. Nits never keep the loop going: list them if useful and still end with that line.
${FINAL_MARKER_DISPUTED}
when every finding still open is one the implementer declined, you already answered that decline once, and you still disagree. The user decides those, and reads only this part: just above that line, write a line "${DISPUTE_HEADING}" and then, for each such finding, the implementer's position and yours in two or three plain lines each.
While a blocker or non-blocker remains open for any other reason, leave the final line out.`;

const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{4,128}$/);
const messageIdSchema = z.string().regex(/^msg_[A-Za-z0-9]{8,64}$/);
const timeSchema = z.number().finite().nonnegative();
const promptSchema = z.string().max(PROMPT_CHAR_LIMIT);

const STATUSES = ['running', 'clean', 'disputed', 'limit', 'failed', 'stopped'];
const STEPS = ['handoff', 'review', 'implement'];

const templatesSchema = z.object({
  reviewStart: promptSchema,
  reviewRules: promptSchema,
  feedbackToImplementer: promptSchema,
  responseToReviewer: promptSchema,
});

const startInputSchema = z.object({
  originalSessionID: sessionIdSchema,
  reviewSessionID: sessionIdSchema,
  directory: z.string().trim().min(1),
  handoff: z.object({ text: promptSchema.min(1), instructions: promptSchema }).optional(),
  prompts: templatesSchema,
});

const sendSchema = z.object({
  sessionID: sessionIdSchema,
  text: z.string(),
  context: z.array(z.string()),
  messageID: messageIdSchema.optional(),
  contextIDs: z.array(messageIdSchema).optional(),
  afterIdleID: z.string().min(1).nullable().optional(),
  settle: z.literal('clean').optional(),
});

const runSchema = z.object({
  originalSessionID: sessionIdSchema,
  reviewSessionID: sessionIdSchema,
  directory: z.string().min(1),
  status: z.enum(STATUSES),
  step: z.enum(STEPS),
  round: z.number().int().nonnegative(),
  prompts: templatesSchema,
  send: sendSchema.nullable(),
  awaiting: z.object({ sessionID: sessionIdSchema, afterIdleID: z.string().min(1).nullable() }).nullable(),
  error: z.string().optional(),
  dispute: z.string().optional(),
  startedAt: timeSchema,
  updatedAt: timeSchema,
});

const storedFileSchema = z.object({ revision: z.number().int().nonnegative().optional(), runs: z.array(z.unknown()) });
const runIdentitySchema = z.object({ originalSessionID: sessionIdSchema, reviewSessionID: sessionIdSchema, directory: z.string().min(1) });
const recordTypeSchema = z.object({ type: z.string(), id: z.string().optional() });
const messagePageSchema = z.object({ data: z.array(z.unknown()) });
const sessionRecordSchema = z.object({ revert: z.object({}).nullish() });
const statusEventSchema = z.object({
  type: z.literal('session.status'),
  properties: z.object({ sessionID: z.string().min(1), status: z.object({ type: z.string().min(1) }) }),
});
const deletedEventSchema = z.object({
  type: z.literal('session.deleted'),
  properties: z.object({ sessionID: z.string().min(1) }),
});
const errorCodeSchema = z.object({ code: z.string() });

const parse = (schema, value) => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const retryDelay = (failures) => Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(failures - 1, 0), RETRY_MAX_DELAY_MS);

const httpError = (message, status) => Object.assign(new Error(message), { status });

const fill = (template, key, value) => template.replace(
  new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'),
  () => value,
);

export const readReviewVerdict = (text) => {
  const lines = text.trimEnd().split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  const last = lines.at(-1)?.trim().toLowerCase() ?? '';
  const kind = last === FINAL_MARKER_CLEAN.toLowerCase()
    ? 'clean'
    : last === FINAL_MARKER_DISPUTED.toLowerCase() ? 'disputed' : 'open';
  if (kind !== 'open') lines.pop();
  return { kind, feedback: lines.join('\n').trim() };
};

const cut = (text, limit) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

export const readDisputeSummary = (feedback) => {
  const heading = DISPUTE_HEADING.toLowerCase();
  const lines = feedback.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const bare = lines[index].replace(/[#*_`>]/g, '').trim();
    if (!bare.toLowerCase().startsWith(heading)) continue;
    const rest = [bare.slice(heading.length), ...lines.slice(index + 1)].join('\n').trim();
    if (rest) return cut(rest, DISPUTE_CHAR_LIMIT);
  }
  return cut(feedback, DISPUTE_CHAR_LIMIT);
};

const toPublicRun = (run) => {
  const publicRun = {
    originalSessionID: run.originalSessionID,
    reviewSessionID: run.reviewSessionID,
    directory: run.directory,
    status: run.status,
    step: run.step,
    round: run.round,
    maxRounds: MAX_ROUNDS,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
  };
  if (run.error) publicRun.error = run.error;
  if (run.dispute) publicRun.dispute = run.dispute;
  return publicRun;
};

export function createAutoReviewRuntime({
  globalEventHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  sessionKnowledgeRuntime = null,
  broadcastUiEvent,
  onRunSettled,
  onRunEnded = null,
  routeSend = null,
  dataDir,
  fetchImpl = fetch,
  now = Date.now,
  quietMs = QUIET_MS,
  retryDelayMs = retryDelay,
  subagentRecheckMs = SUBAGENT_RECHECK_MS,
  settleRecheckMs = SETTLE_RECHECK_MS,
}) {
  const filePath = path.join(dataDir, FILE_NAME);

  const runs = new Map();
  let revision = 0;
  let loadPromise = null;
  let writePromise = Promise.resolve();
  let stopped = false;
  let startupLoadSettled = false;
  let markStartupLoadSettled = () => {};
  const startupLoad = new Promise((resolve) => { markStartupLoadSettled = resolve; });

  const timers = new Map();
  const readFailures = new Map();
  const sendFailures = new Map();
  const settleChecks = new Map();
  const ticking = new Set();
  const ticksInFlight = new Set();

  const readFile = async () => {
    let raw;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (parse(errorCodeSchema, error)?.code === 'ENOENT') return { runs: [], revision: 0 };
      throw error;
    }
    let stored = null;
    let reason = 'not an auto-review file';
    try {
      stored = parse(storedFileSchema, JSON.parse(raw));
    } catch (error) {
      reason = error?.message ?? String(error);
    }
    if (!stored) {
      const backup = `${filePath}.corrupt-${now()}`;
      await fs.promises.rename(filePath, backup).catch(() => undefined);
      console.warn(`[auto-review] file was unreadable and moved to ${backup}: ${reason}`);
      return { runs: [], revision: 0 };
    }
    const restored = stored.runs.map((value) => parse(runSchema, value) ?? unreadableRun(value)).filter(Boolean);
    return { runs: restored, revision: stored.revision ?? 0 };
  };

  const unreadableRun = (value) => {
    const identity = parse(runIdentitySchema, value);
    if (!identity) return null;
    const at = now();
    return {
      ...identity,
      status: 'failed',
      step: 'review',
      round: 0,
      prompts: { reviewStart: '', reviewRules: '', feedbackToImplementer: '', responseToReviewer: '' },
      send: null,
      awaiting: null,
      error: 'The saved review could not be read after a restart.',
      startedAt: at,
      updatedAt: at,
    };
  };

  const load = () => {
    if (!loadPromise) {
      loadPromise = readFile()
        .then((stored) => {
          for (const run of stored.runs) if (!runs.has(run.originalSessionID)) runs.set(run.originalSessionID, run);
          revision = Math.max(revision, stored.revision);
        })
        .catch((error) => {
          loadPromise = null;
          throw error;
        });
    }
    return loadPromise;
  };

  const persist = () => {
    const payload = JSON.stringify({ version: FILE_VERSION, revision, runs: Array.from(runs.values()) });
    const write = writePromise.then(async () => {
      await fs.promises.mkdir(dataDir, { recursive: true });
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
      await fs.promises.rename(tmpPath, filePath);
    });
    writePromise = write.catch((error) => {
      console.warn('[auto-review] failed to persist runs:', error?.message ?? error);
    });
    return write;
  };

  const commit = (originalSessionID, directory) => {
    revision += 1;
    const run = runs.get(originalSessionID) ?? null;
    broadcastUiEvent?.({
      type: 'openchamber:auto-review.updated',
      properties: { revision, originalSessionID, directory, run: run ? toPublicRun(run) : null },
    });
    return persist();
  };

  const snapshot = () => ({ revision, runs: Array.from(runs.values(), toPublicRun) });

  const isRunning = (sessionID) => runs.get(sessionID)?.status === 'running';

  const speaksFor = (sessionID, turnEndedAt) => {
    for (const run of runs.values()) {
      if (run.originalSessionID !== sessionID && run.reviewSessionID !== sessionID) continue;
      if (run.status === 'running' || run.updatedAt >= turnEndedAt) return true;
    }
    return false;
  };

  const openCodeRequest = async (fetchPath, { method = 'GET', body, query } = {}) => {
    const base = buildOpenCodeUrl(fetchPath, '');
    const search = new URLSearchParams(query || {}).toString();
    const headers = { Accept: 'application/json', ...getOpenCodeAuthHeaders() };
    const init = { method, headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
    if (body) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetchImpl(search ? `${base}?${search}` : base, init);
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw httpError(`OpenCode ${method} ${fetchPath} failed with ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, response.status);
    }
    assertOpenCodeApiResponse(response, `OpenCode ${method} ${fetchPath}`);
    return unwrapOpenCodeResponse(await response.json().catch(() => null));
  };

  const activityProbe = createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders, timeoutMs: FETCH_TIMEOUT_MS, fetchImpl });

  const readSession = async (sessionID) => {
    const statuses = await activityProbe.fetchActiveSessionStatuses();
    if (!statuses) return null;
    if (statuses[sessionID]) return { kind: 'running' };
    const subagentsWorking = await activityProbe.hasWorkingChildren(sessionID, statuses);
    if (subagentsWorking === null) return null;
    if (subagentsWorking) return { kind: 'subagents' };
    try {
      const page = parse(messagePageSchema, await openCodeRequest(`/api/session/${encodeURIComponent(sessionID)}/message`, {
        query: { limit: String(MESSAGE_PAGE_LIMIT), order: 'desc' },
      }));
      if (!page) return null;
      return { kind: 'idle', records: page.data };
    } catch (error) {
      if (error?.status === 404) return { kind: 'deleted' };
      return null;
    }
  };

  const newestIdleID = (records) => {
    const idle = records.map((record) => parse(recordTypeSchema, record)).find((record) => record?.type === 'idle');
    return idle?.id ?? null;
  };

  const admit = async (sessionID, route, body) => {
    try {
      await openCodeRequest(`/api/session/${encodeURIComponent(sessionID)}/${route}`, { method: 'POST', body });
    } catch (error) {
      if (error?.status === 409) return;
      throw error;
    }
  };

  const commitStagedRevert = async (sessionID) => {
    const sessionPath = `/api/session/${encodeURIComponent(sessionID)}`;
    const session = parse(sessionRecordSchema, await openCodeRequest(sessionPath));
    if (!session) throw new Error(`OpenCode returned no record for session ${sessionID}`);
    if (session.revert) await openCodeRequest(`${sessionPath}/revert/commit`, { method: 'POST' });
  };

  const clearTimer = (originalSessionID) => {
    const existing = timers.get(originalSessionID);
    if (existing) {
      clearTimeout(existing);
      timers.delete(originalSessionID);
    }
  };

  const arm = (originalSessionID, delayMs = quietMs) => {
    if (stopped || !isRunning(originalSessionID)) return;
    clearTimer(originalSessionID);
    const timer = setTimeout(() => {
      timers.delete(originalSessionID);
      const work = tick(originalSessionID)
        .catch((error) => {
          console.warn('[auto-review] tick failed:', error?.message ?? error);
        })
        .finally(() => ticksInFlight.delete(work));
      ticksInFlight.add(work);
    }, Math.max(0, delayMs));
    timer.unref?.();
    timers.set(originalSessionID, timer);
  };

  const forgetLoopState = (originalSessionID) => {
    clearTimer(originalSessionID);
    readFailures.delete(originalSessionID);
    sendFailures.delete(originalSessionID);
    settleChecks.delete(originalSessionID);
  };

  const settle = async (run, status, error) => {
    run.status = status;
    run.send = null;
    run.awaiting = null;
    if (error) run.error = cut(error, ERROR_CHAR_LIMIT);
    run.updatedAt = now();
    forgetLoopState(run.originalSessionID);
    await commit(run.originalSessionID, run.directory);
    Promise.resolve().then(() => onRunSettled?.(run.originalSessionID)).catch(() => undefined);
    if (status !== 'stopped') {
      const ended = { sessionId: run.originalSessionID, directory: run.directory, status, error: run.error };
      Promise.resolve().then(() => onRunEnded?.(ended)).catch(() => undefined);
    }
    console.log(`[auto-review] review of ${run.originalSessionID} ended: ${status}${error ? ` (${error})` : ''}`);
  };

  const watchedSessionOf = (run) => run.send?.sessionID ?? run.awaiting?.sessionID ?? null;

  const stillCurrent = (run) => runs.get(run.originalSessionID) === run && run.status === 'running';

  const deliver = async (run, records) => {
    const send = run.send;
    if (!send.messageID) {
      const mintedAt = now();
      send.afterIdleID = newestIdleID(records);
      send.contextIDs = send.context.map((_, index) => createMessageId(mintedAt + index));
      send.messageID = createMessageId(mintedAt + send.context.length);
      await persist();
    }
    if (routeSend) await routeSend({ sessionId: send.sessionID, directory: run.directory, text: send.text });
    if (sessionKnowledgeRuntime) await sessionKnowledgeRuntime.sync(send.sessionID, run.directory);
    const context = send.context.flatMap((text, index) => (text.trim() ? [{ id: send.contextIDs[index], text }] : []));
    if (context.length > 0) await commitStagedRevert(send.sessionID);
    for (const { id, text } of context) await admit(send.sessionID, 'synthetic', { id, text, resume: false });
    await admit(send.sessionID, 'prompt', { id: send.messageID, text: send.text });
    if (!stillCurrent(run)) return;
    sendFailures.delete(run.originalSessionID);
    if (send.settle) {
      await settle(run, send.settle);
      return;
    }
    run.awaiting = { sessionID: send.sessionID, afterIdleID: send.afterIdleID ?? null };
    run.send = null;
    run.updatedAt = now();
    await commit(run.originalSessionID, run.directory);
  };

  const advance = async (run, reply) => {
    run.awaiting = null;
    run.updatedAt = now();
    if (run.step === 'handoff') {
      run.step = 'review';
      run.send = {
        sessionID: run.reviewSessionID,
        text: fill(run.prompts.reviewStart, 'handoff', reply),
        context: [run.prompts.reviewRules, LOOP_RULES],
      };
    } else if (run.step === 'review') {
      const verdict = readReviewVerdict(reply);
      if (verdict.kind === 'disputed') {
        if (verdict.feedback) run.dispute = readDisputeSummary(verdict.feedback);
        return settle(run, 'disputed');
      }
      if (verdict.kind === 'clean' && !verdict.feedback) return settle(run, 'clean');
      run.step = 'implement';
      run.send = {
        sessionID: run.originalSessionID,
        text: fill(run.prompts.feedbackToImplementer, 'review_feedback', verdict.feedback),
        context: [],
      };
      if (verdict.kind === 'clean') run.send.settle = 'clean';
    } else {
      if (run.round >= MAX_ROUNDS) return settle(run, 'limit');
      run.round += 1;
      run.step = 'review';
      run.send = {
        sessionID: run.reviewSessionID,
        text: fill(run.prompts.responseToReviewer, 'implementation_response', reply),
        context: [LOOP_RULES],
      };
    }
    await commit(run.originalSessionID, run.directory);
    arm(run.originalSessionID, 0);
  };

  const WHO = { handoff: 'implementer', review: 'reviewer', implement: 'implementer' };

  async function tick(originalSessionID) {
    if (stopped || !isRunning(originalSessionID)) return;
    if (ticking.has(originalSessionID)) return arm(originalSessionID);
    ticking.add(originalSessionID);
    const run = runs.get(originalSessionID);
    try {
      const sessionID = watchedSessionOf(run);
      if (!sessionID) return;
      const watched = await readSession(sessionID);
      if (!stillCurrent(run)) return;
      if (watched === null) {
        const count = (readFailures.get(originalSessionID) ?? 0) + 1;
        readFailures.set(originalSessionID, count);
        return arm(originalSessionID, retryDelayMs(count));
      }
      readFailures.delete(originalSessionID);
      if (watched.kind === 'deleted') {
        return settle(run, 'failed', sessionID === run.reviewSessionID ? 'The review session was deleted.' : 'The reviewed session was deleted.');
      }
      if (watched.kind === 'running') return;
      if (watched.kind === 'subagents') return arm(originalSessionID, subagentRecheckMs);

      if (run.send) {
        try {
          await deliver(run, watched.records);
        } catch (error) {
          if (!stillCurrent(run)) return;
          const count = (sendFailures.get(originalSessionID) ?? 0) + 1;
          sendFailures.set(originalSessionID, count);
          console.warn(`[auto-review] sending to ${sessionID} failed (attempt ${count}):`, error?.message ?? error);
          if (error?.status === 404) return settle(run, 'failed', `The ${WHO[run.step]} session is gone.`);
          if (count >= MAX_SEND_FAILURES) return settle(run, 'failed', `Could not send to the ${WHO[run.step]}: ${error?.message ?? error}`);
          return arm(originalSessionID, retryDelayMs(count));
        }
        return arm(originalSessionID);
      }

      const outcome = readDispatchOutcome(watched.records, 0, run.awaiting.afterIdleID, { withText: true });
      if (!outcome) {
        const spent = settleChecks.get(originalSessionID) ?? 0;
        if (spent < SETTLE_RECHECKS) {
          settleChecks.set(originalSessionID, spent + 1);
          arm(originalSessionID, settleRecheckMs);
        }
        return;
      }
      settleChecks.delete(originalSessionID);
      if (outcome.state === 'cancelled') return settle(run, 'stopped');
      if (outcome.state === 'error') {
        return settle(run, 'failed', outcome.errorMessage ? `The ${WHO[run.step]}'s turn failed: ${outcome.errorMessage}` : `The ${WHO[run.step]}'s turn failed.`);
      }
      if (!outcome.text) return settle(run, 'failed', `The ${WHO[run.step]} finished without a text reply.`);
      await advance(run, outcome.text);
    } finally {
      ticking.delete(originalSessionID);
    }
  }

  const reconcileAll = () => {
    for (const [originalSessionID, run] of runs) {
      if (run.status === 'running' && !timers.has(originalSessionID)) arm(originalSessionID);
    }
  };

  const start = async (input) => {
    const parsed = startInputSchema.safeParse(input);
    if (!parsed.success) throw new TypeError(`invalid auto-review run: ${parsed.error.issues[0]?.message ?? 'bad input'}`);
    const { originalSessionID, reviewSessionID, directory, handoff, prompts } = parsed.data;
    if (originalSessionID === reviewSessionID) throw new TypeError('a session cannot review itself');
    await load();
    if (isRunning(originalSessionID)) throw httpError('an auto-review is already running for this session', 409);
    const run = {
      originalSessionID,
      reviewSessionID,
      directory,
      status: 'running',
      step: handoff ? 'handoff' : 'review',
      round: 0,
      prompts,
      send: handoff
        ? { sessionID: originalSessionID, text: handoff.text, context: [handoff.instructions] }
        : { sessionID: reviewSessionID, text: prompts.reviewStart, context: [prompts.reviewRules, LOOP_RULES] },
      awaiting: null,
      startedAt: now(),
      updatedAt: now(),
    };
    runs.set(originalSessionID, run);
    if (runs.size > MAX_RUNS) {
      const oldest = Array.from(runs.values())
        .filter((candidate) => candidate.status !== 'running')
        .sort((left, right) => left.updatedAt - right.updatedAt)
        .slice(0, runs.size - MAX_RUNS);
      for (const stale of oldest) runs.delete(stale.originalSessionID);
    }
    forgetLoopState(originalSessionID);
    try {
      await commit(originalSessionID, directory);
    } catch (error) {
      runs.delete(originalSessionID);
      await commit(originalSessionID, directory).catch(() => undefined);
      throw error;
    }
    arm(originalSessionID, 0);
    return { revision, run: toPublicRun(run) };
  };

  async function remove(originalSessionIDInput) {
    const originalSessionID = parse(sessionIdSchema, originalSessionIDInput);
    if (!originalSessionID) throw new TypeError('originalSessionID is invalid');
    await load();
    const run = runs.get(originalSessionID);
    if (!run) return { revision, run: null };
    const wasRunning = run.status === 'running';
    runs.delete(originalSessionID);
    forgetLoopState(originalSessionID);
    await commit(originalSessionID, run.directory);
    if (wasRunning) Promise.resolve().then(() => onRunSettled?.(originalSessionID)).catch(() => undefined);
    return { revision, run: null };
  }

  const processPayload = (payload) => {
    if (stopped) return;

    const deleted = parse(deletedEventSchema, payload);
    if (deleted) {
      const deletedID = deleted.properties.sessionID;
      if (runs.has(deletedID)) {
        void remove(deletedID).catch(() => undefined);
        return;
      }
      for (const run of runs.values()) {
        if (run.reviewSessionID === deletedID && run.status === 'running') arm(run.originalSessionID, 0);
      }
      return;
    }

    const status = parse(statusEventSchema, payload);
    if (!status) return;
    const sessionID = status.properties.sessionID;
    for (const run of runs.values()) {
      if (run.status !== 'running' || watchedSessionOf(run) !== sessionID) continue;
      if (status.properties.status.type === 'idle') {
        settleChecks.delete(run.originalSessionID);
        arm(run.originalSessionID);
      } else {
        clearTimer(run.originalSessionID);
      }
    }
  };

  const processEvent = (event) => {
    for (const payload of event?.translated?.() ?? []) processPayload(payload);
  };

  const startRuntime = () => {
    const unsubscribeEvent = globalEventHub.subscribeEvent(processEvent);
    const unsubscribeStatus = globalEventHub.subscribeStatus((hubStatus) => {
      if (hubStatus?.type === 'connect') reconcileAll();
    });
    void load()
      .then(() => {
        const running = Array.from(runs.values()).filter((run) => run.status === 'running').length;
        if (running > 0) console.log(`[auto-review] resuming ${running} running review(s)`);
        reconcileAll();
      })
      .catch((error) => {
        console.warn('[auto-review] failed to load runs:', error?.message ?? error);
      })
      .finally(() => {
        startupLoadSettled = true;
        markStartupLoadSettled();
      });
    return () => {
      unsubscribeEvent();
      unsubscribeStatus();
    };
  };

  const stop = () => {
    stopped = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };

  return {
    load,
    snapshot,
    startRun: start,
    removeRun: remove,
    isRunning,
    speaksFor,
    holdsDelivery: (sessionID) => !startupLoadSettled || isRunning(sessionID),
    startupLoad,
    processPayload,
    start: startRuntime,
    stop,
    flush: async () => {
      while (ticksInFlight.size > 0) await Promise.all(ticksInFlight);
      await writePromise;
    },
  };
}

export function registerAutoReviewRoutes(app, runtime) {
  const respondError = (res, error, fallback) => {
    const status = error instanceof TypeError ? 400 : (Number.isInteger(error?.status) ? error.status : 500);
    res.status(status).json({ error: error?.message ?? fallback });
  };

  app.get('/api/auto-review', async (_req, res) => {
    try {
      await runtime.load();
      res.json(runtime.snapshot());
    } catch (error) {
      respondError(res, error, 'Failed to load auto-reviews');
    }
  });

  app.post('/api/auto-review/runs', async (req, res) => {
    try {
      res.json(await runtime.startRun(req.body));
    } catch (error) {
      respondError(res, error, 'Failed to start the auto-review');
    }
  });

  app.delete('/api/auto-review/runs/:originalSessionID', async (req, res) => {
    try {
      res.json(await runtime.removeRun(req.params.originalSessionID));
    } catch (error) {
      respondError(res, error, 'Failed to stop the auto-review');
    }
  });
}
