import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FINAL_MARKER_CLEAN,
  FINAL_MARKER_DISPUTED,
  LOOP_RULES,
  MAX_ROUNDS,
  createAutoReviewRuntime,
  readDisputeSummary,
  readReviewVerdict,
} from './runtime.js';
import { createAutomationAdmission, reviewOwner } from '../session-automation/runtime.js';

const ORIGINAL = 'ses_original';
const REVIEW = 'ses_review';
const DIRECTORY = '/repo';

const temporaryDirectories = [];
const runtimes = [];

afterEach(async () => {
  const stopping = runtimes.splice(0);
  for (const runtime of stopping) runtime.stop();
  await Promise.all(stopping.map((runtime) => runtime.flush()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const makeDataDir = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-auto-review-'));
  temporaryDirectories.push(directory);
  return directory;
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A stand-in for the OpenCode routes the runtime uses. A prompt admitted to a
 * session runs a turn at once when a reply is scripted for it: the reply and
 * the run's `idle` record are appended, as OpenCode does when a run ends.
 * Records are kept oldest first and served newest first.
 */
const createOpenCode = () => {
  const state = {
    active: {},
    records: { [ORIGINAL]: [], [REVIEW]: [] },
    // Scripted turns per session: a reply text, or `{ outcome, text?, error? }`.
    replies: { [ORIGINAL]: [], [REVIEW]: [] },
    prompts: [],
    synthetic: [],
    seenIds: new Set(),
    failPrompts: 0,
    counter: 0,
  };
  const runTurn = (sessionID) => {
    const scripted = state.replies[sessionID].shift();
    if (scripted === undefined) return;
    const turn = typeof scripted === 'string' ? { outcome: 'succeeded', text: scripted } : scripted;
    state.counter += 1;
    const created = state.counter;
    if (turn.text !== undefined || turn.error) {
      const reply = {
        type: 'assistant',
        id: `msg_reply${created}`,
        content: turn.text ? [{ type: 'text', text: turn.text }] : [],
        time: { created, completed: created },
      };
      if (turn.error) reply.error = { message: turn.error };
      state.records[sessionID].push(reply);
    }
    state.records[sessionID].push({ type: 'idle', id: `msg_idle${created}`, outcome: turn.outcome, time: { created } });
  };
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    const method = init.method ?? 'GET';
    if (pathname === '/api/session/active') return json({ data: state.active });
    if (pathname === '/api/session' && method === 'GET') return json({ data: [], cursor: {} });
    const match = pathname.match(/^\/api\/session\/([^/]+)\/(message|prompt|synthetic)$/);
    if (!match) return json({ error: 'not found' }, 404);
    const sessionID = decodeURIComponent(match[1]);
    if (!state.records[sessionID]) return json({ error: 'not found' }, 404);
    if (match[2] === 'message') return json({ data: [...state.records[sessionID]].reverse().slice(0, Number(searchParams.get('limit') ?? 50)), cursor: {} });
    const body = JSON.parse(init.body);
    if (match[2] === 'prompt' && state.failPrompts > 0) {
      state.failPrompts -= 1;
      return json({ error: 'boom' }, 500);
    }
    if (state.seenIds.has(body.id)) return json({ error: 'conflict' }, 409);
    state.seenIds.add(body.id);
    if (match[2] === 'synthetic') {
      state.synthetic.push({ sessionID, ...body });
      state.records[sessionID].push({ type: 'synthetic', id: body.id, text: body.text });
      return json({ data: { id: body.id } });
    }
    state.prompts.push({ sessionID, ...body });
    state.records[sessionID].push({ type: 'user', id: body.id, text: body.text });
    runTurn(sessionID);
    return json({ data: { id: body.id } });
  });
  return { state, fetchImpl };
};

const createRuntime = async ({ dataDir, openCode = createOpenCode(), retryDelayMs = () => 5, routeSend = null, automation = null } = {}) => {
  let eventHandler = () => {};
  const broadcasts = [];
  const settled = [];
  const ended = [];
  const runtime = createAutoReviewRuntime({
    globalEventHub: {
      subscribeEvent(handler) { eventHandler = handler; return () => {}; },
      subscribeStatus() { return () => {}; },
    },
    buildOpenCodeUrl: (fetchPath) => `http://opencode.test${fetchPath}`,
    getOpenCodeAuthHeaders: () => ({}),
    broadcastUiEvent: (event) => broadcasts.push(event),
    onRunSettled: (sessionID) => settled.push(sessionID),
    onRunEnded: (run) => ended.push(run),
    routeSend,
    automation,
    dataDir: dataDir ?? await makeDataDir(),
    fetchImpl: openCode.fetchImpl,
    quietMs: 0,
    retryDelayMs,
    subagentRecheckMs: 5,
    settleRecheckMs: 5,
  });
  runtimes.push(runtime);
  return {
    runtime,
    openCode,
    broadcasts,
    settled,
    ended,
    emit: (payload) => eventHandler({ payload, translated: () => [payload] }),
  };
};

const prompts = {
  reviewStart: 'Review this.\n\n{{handoff}}',
  reviewRules: 'Review rules.',
  feedbackToImplementer: 'Feedback:\n{{review_feedback}}',
  responseToReviewer: 'Response:\n{{implementation_response}}',
};

const startInput = (extra = {}) => ({
  originalSessionID: ORIGINAL,
  reviewSessionID: REVIEW,
  directory: DIRECTORY,
  handoff: { text: 'Write a handoff.', instructions: 'Handoff rules.' },
  prompts,
  ...extra,
});

const until = async (check, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return check();
};

const runOf = (runtime) => runtime.snapshot().runs.find((run) => run.originalSessionID === ORIGINAL) ?? null;

describe('readReviewVerdict', () => {
  it('reads the final line and leaves it out of the feedback', () => {
    expect(readReviewVerdict(`Nit: rename x.\n${FINAL_MARKER_CLEAN}\n\n`)).toEqual({ kind: 'clean', feedback: 'Nit: rename x.' });
    expect(readReviewVerdict(`Still disagree on 2.\n${FINAL_MARKER_DISPUTED.toUpperCase()}`)).toEqual({ kind: 'disputed', feedback: 'Still disagree on 2.' });
    expect(readReviewVerdict(`1. Blocker.\n${FINAL_MARKER_CLEAN} because`)).toEqual({ kind: 'open', feedback: `1. Blocker.\n${FINAL_MARKER_CLEAN} because` });
  });
});

describe('readDisputeSummary', () => {
  it('takes what follows the last heading, else the whole review cut short', () => {
    expect(readDisputeSummary('Intro.\n## Disputed findings: 3 is wrong\nbecause X')).toBe('3 is wrong\nbecause X');
    expect(readDisputeSummary('No heading here.')).toBe('No heading here.');
    expect(readDisputeSummary('x'.repeat(3_000))).toHaveLength(2_000);
  });
});

describe('createAutoReviewRuntime', () => {
  it('fails visibly when a long turn moves its saved prompt outside the bounded message page', async () => {
    const { runtime, openCode, emit } = await createRuntime();
    runtime.start();
    await runtime.startRun(startInput());
    expect(await until(() => openCode.state.prompts.length === 1)).toBe(true);
    for (let index = 0; index < 55; index += 1) openCode.state.records[ORIGINAL].push({ type: 'tool', id: `msg_tool${index}` });
    openCode.state.records[ORIGINAL].push({ type: 'idle', id: 'msg_longidle1234', outcome: 'succeeded', time: { created: 100 } });
    emit({ type: 'session.status', properties: { sessionID: ORIGINAL, status: { type: 'idle' } } });
    expect(await until(() => runOf(runtime)?.status === 'failed')).toBe(true);
    expect(openCode.state.prompts).toHaveLength(1);
    expect(runtime.holdsDelivery(REVIEW)).toBe(false);
  });

  it('serializes removal and replacement so the old removal cannot release the new reservation', async () => {
    const automation = createAutomationAdmission();
    const { runtime, openCode } = await createRuntime({ automation });
    openCode.state.active = { [ORIGINAL]: { type: 'running' } };
    runtime.start();
    await runtime.startRun(startInput());
    await new Promise((resolve) => setTimeout(resolve, 30));
    let entered;
    let finish;
    const started = new Promise((resolve) => { entered = resolve; });
    const waiting = new Promise((resolve) => { finish = resolve; });
    const rename = fs.rename.bind(fs);
    let held = false;
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!held && String(to).endsWith('auto-review.json')) { held = true; entered(); await waiting; }
      return rename(from, to);
    });
    try {
      const removing = runtime.removeRun(ORIGINAL);
      await started;
      const replacement = runtime.startRun(startInput({ reviewSessionID: 'ses_replacement' }));
      await new Promise((resolve) => setTimeout(resolve, 5));
      finish();
      await removing;
      await replacement;
      expect(automation.owns(reviewOwner(ORIGINAL))).toBe(true);
    } finally { finish(); spy.mockRestore(); }
  });
  it('a restored send cannot target a session outside its owned participants', async () => {
    const dataDir = await makeDataDir();
    const initial = await createRuntime({ dataDir });
    await initial.runtime.startRun(startInput());
    initial.runtime.stop();
    await initial.runtime.flush();
    const file = path.join(dataDir, 'auto-review.json');
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    saved.runs[0].send.sessionID = 'ses_outside';
    await fs.writeFile(file, JSON.stringify(saved));
    const openCode = createOpenCode();
    openCode.state.records.ses_outside = [];
    const restored = await createRuntime({ dataDir, openCode });
    restored.runtime.start();
    expect(await until(() => restored.runtime.snapshot().runs.length === 1)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(openCode.state.synthetic).toEqual([]);
    expect(restored.runtime.snapshot().runs[0].status).toBe('failed');
  });

  it('preserves an unreadable restore and keeps admission held until ownership is known', async () => {
    const dataDir = await makeDataDir();
    const file = path.join(dataDir, 'auto-review.json');
    await fs.writeFile(file, '{broken');
    const { runtime, openCode } = await createRuntime({ dataDir });
    await expect(runtime.load()).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe('{broken');
    expect(runtime.holdsDelivery(ORIGINAL)).toBe(true);
    expect(openCode.state.prompts).toEqual([]);
  });

  it('holds both sessions and refuses another run that reuses either participant', async () => {
    const { runtime } = await createRuntime();
    runtime.start();
    await runtime.startRun(startInput());
    expect(runtime.holdsDelivery(REVIEW)).toBe(true);
    await expect(runtime.startRun(startInput({ originalSessionID: REVIEW, reviewSessionID: 'ses_another' }))).rejects.toThrow();
  });

  it('a stop during routing admits no context or prompt', async () => {
    let entered;
    let finish;
    const routed = new Promise((resolve) => { entered = resolve; });
    const routing = new Promise((resolve) => { finish = resolve; });
    const { runtime, openCode } = await createRuntime({ routeSend: async () => { entered(); await routing; } });
    runtime.start();
    await runtime.startRun(startInput());
    await routed;
    await runtime.removeRun(ORIGINAL);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(openCode.state.synthetic).toEqual([]);
    expect(openCode.state.prompts).toEqual([]);
  });

  it.each(['user', 'synthetic'])('does not attribute a later foreign %s turn to its own pending prompt', async (type) => {
    const { runtime, openCode, emit } = await createRuntime();
    runtime.start();
    await runtime.startRun(startInput());
    expect(await until(() => openCode.state.prompts.length === 1)).toBe(true);
    openCode.state.records[ORIGINAL].push(
      { type, id: 'msg_foreign1234', text: 'unrelated request' },
      { type: 'assistant', id: 'msg_foreignreply', content: [{ type: 'text', text: 'FOREIGN RESPONSE' }], time: { created: 100, completed: 101 } },
      { type: 'idle', id: 'msg_foreignidle', outcome: 'succeeded', time: { created: 102 } },
    );
    emit({ type: 'session.status', properties: { sessionID: ORIGINAL, status: { type: 'idle' } } });
    expect(await until(() => runOf(runtime)?.status !== 'running' || openCode.state.prompts.length > 1)).toBe(true);
    expect(openCode.state.prompts).toHaveLength(1);
    expect(runOf(runtime)?.status).toBe('failed');
  });

  it('carries a handoff, the review, the fixes and the re-review until nothing is left', async () => {
    const { runtime, openCode, settled, ended } = await createRuntime();
    openCode.state.replies[ORIGINAL].push('The handoff.', 'Fixed the blocker.');
    openCode.state.replies[REVIEW].push('1. Blocker: X breaks.', `Nit: a name.\n${FINAL_MARKER_CLEAN}`);
    runtime.start();
    await runtime.startRun(startInput());

    expect(await until(() => runOf(runtime)?.status === 'clean')).toBe(true);
    expect(openCode.state.prompts.map((prompt) => [prompt.sessionID, prompt.text])).toEqual([
      [ORIGINAL, 'Write a handoff.'],
      [REVIEW, 'Review this.\n\nThe handoff.'],
      [ORIGINAL, 'Feedback:\n1. Blocker: X breaks.'],
      [REVIEW, 'Response:\nFixed the blocker.'],
      [ORIGINAL, 'Feedback:\nNit: a name.'],
    ]);
    expect(openCode.state.synthetic.map((item) => [item.sessionID, item.text])).toEqual([
      [ORIGINAL, 'Handoff rules.'],
      [REVIEW, 'Review rules.'],
      [REVIEW, LOOP_RULES],
      [REVIEW, LOOP_RULES],
    ]);
    // Context is admitted ahead of its prompt, and its ids sort that way too.
    const reviewStart = openCode.state.prompts[1];
    const [rules, loop] = openCode.state.synthetic.slice(1, 3);
    expect([rules.id, loop.id, reviewStart.id]).toEqual([rules.id, loop.id, reviewStart.id].sort());
    expect(runOf(runtime)).toMatchObject({ status: 'clean', round: 1, maxRounds: MAX_ROUNDS });
    // The queue is released once the settled run is on disk.
    expect(await until(() => settled.length > 0)).toBe(true);
    expect(settled).toEqual([ORIGINAL, REVIEW]);
    // One notification for the whole review, and its steps are its own.
    expect(await until(() => ended.length > 0)).toBe(true);
    expect(ended).toEqual([{ sessionId: ORIGINAL, directory: DIRECTORY, status: 'clean', error: undefined }]);
    // The last step ended before the run settled; a turn after it is the user's.
    const settledAt = runOf(runtime).updatedAt;
    expect(runtime.speaksFor(ORIGINAL, settledAt - 1)).toBe(true);
    expect(runtime.speaksFor(REVIEW, settledAt - 1)).toBe(true);
    expect(runtime.speaksFor(ORIGINAL, settledAt + 1)).toBe(false);
    expect(runtime.speaksFor('ses_someone_else', settledAt - 1)).toBe(false);
  });

  it('settles as disputed and sends nothing more when only contested declines are left', async () => {
    const { runtime, openCode } = await createRuntime();
    openCode.state.replies[REVIEW].push(`Finding 1 is fixed.\n\n**Disputed findings:**\n2. Implementer: the guard is dead code.\nMine: it runs on Windows.\n${FINAL_MARKER_DISPUTED}`);
    runtime.start();
    await runtime.startRun(startInput({ handoff: undefined, prompts: { ...prompts, reviewStart: 'Review the diff.' } }));

    expect(await until(() => runOf(runtime)?.status === 'disputed')).toBe(true);
    expect(openCode.state.prompts.map((prompt) => prompt.sessionID)).toEqual([REVIEW]);
    // The row unfolds what the two sides disagree on, not the whole review.
    expect(runOf(runtime).dispute).toBe('2. Implementer: the guard is dead code.\nMine: it runs on Windows.');
  });

  it('stops at the round limit with its own status', async () => {
    const { runtime, openCode } = await createRuntime();
    for (let round = 0; round <= MAX_ROUNDS; round += 1) {
      openCode.state.replies[REVIEW].push(`Round ${round}: still open.`);
      openCode.state.replies[ORIGINAL].push(`Round ${round}: fixed.`);
    }
    runtime.start();
    await runtime.startRun(startInput({ handoff: undefined }));

    expect(await until(() => runOf(runtime)?.status === 'limit', 5_000)).toBe(true);
    expect(runOf(runtime).round).toBe(MAX_ROUNDS);
    expect(openCode.state.prompts.filter((prompt) => prompt.sessionID === REVIEW)).toHaveLength(MAX_ROUNDS + 1);
  });

  it('waits for a running session before it sends, so nothing steers into a live turn', async () => {
    const { runtime, openCode, emit } = await createRuntime();
    openCode.state.active = { [ORIGINAL]: { type: 'running' } };
    runtime.start();
    await runtime.startRun(startInput());
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(openCode.state.prompts).toEqual([]);

    openCode.state.active = {};
    emit({ type: 'session.status', properties: { sessionID: ORIGINAL, status: { type: 'idle' } } });
    expect(await until(() => openCode.state.prompts.length === 1)).toBe(true);
  });

  it('stops the run when the user stops the turn it waits on, and says so without notifying', async () => {
    const { runtime, openCode, settled, ended } = await createRuntime();
    openCode.state.replies[ORIGINAL].push({ outcome: 'interrupted', text: 'Half a handoff' });
    runtime.start();
    await runtime.startRun(startInput());

    expect(await until(() => runOf(runtime)?.status === 'stopped')).toBe(true);
    expect(await until(() => settled.length > 0)).toBe(true);
    expect(settled).toEqual([ORIGINAL, REVIEW]);
    expect(openCode.state.prompts).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ended).toEqual([]);
  });

  it('reports a failed turn with its error', async () => {
    const { runtime, openCode } = await createRuntime();
    openCode.state.replies[ORIGINAL].push({ outcome: 'failed', error: 'rate limited' });
    runtime.start();
    await runtime.startRun(startInput());

    expect(await until(() => runOf(runtime)?.status === 'failed')).toBe(true);
    expect(runOf(runtime).error).toBe("The implementer's turn failed: rate limited");
  });

  it('retries a failed send with the same ids and never admits a record twice, across a restart', async () => {
    const dataDir = await makeDataDir();
    const openCode = createOpenCode();
    openCode.state.failPrompts = 1;
    // The first server retries only long after it is gone.
    const first = await createRuntime({ dataDir, openCode, retryDelayMs: () => 60_000 });
    first.runtime.start();
    await first.runtime.startRun(startInput());
    expect(await until(() => openCode.fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/prompt')))).toBe(true);
    expect(openCode.state.prompts).toEqual([]);
    first.runtime.stop();
    await first.runtime.flush();

    openCode.state.replies[ORIGINAL].push('The handoff.');
    const second = await createRuntime({ dataDir, openCode });
    second.runtime.start();
    expect(await until(() => openCode.state.prompts.length === 2)).toBe(true);
    expect(openCode.state.prompts.map((prompt) => prompt.text)).toEqual(['Write a handoff.', 'Review this.\n\nThe handoff.']);
    expect(openCode.state.synthetic.filter((item) => item.text === 'Handoff rules.')).toHaveLength(1);
  });

  it('routes a session on Auto before each prompt, and a routing failure sends nothing', async () => {
    const routed = [];
    let failRouting = true;
    const routeSend = async (send) => {
      if (failRouting) throw new Error('no fallback model');
      routed.push(send);
    };
    const { runtime, openCode } = await createRuntime({ routeSend, retryDelayMs: () => 20 });
    openCode.state.replies[ORIGINAL].push('The handoff.');
    runtime.start();
    await runtime.startRun(startInput());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(openCode.state.prompts).toEqual([]);
    expect(openCode.state.synthetic).toEqual([]);

    failRouting = false;
    expect(await until(() => openCode.state.prompts.length === 2)).toBe(true);
    expect(routed).toEqual([
      { sessionId: ORIGINAL, directory: DIRECTORY, text: 'Write a handoff.' },
      { sessionId: REVIEW, directory: DIRECTORY, text: 'Review this.\n\nThe handoff.' },
    ]);
  });

  it('holds the queue until its runs are loaded after a start', async () => {
    const { runtime } = await createRuntime();
    expect(runtime.holdsDelivery(ORIGINAL)).toBe(true);
    runtime.start();
    await runtime.startupLoad;
    expect(runtime.holdsDelivery(ORIGINAL)).toBe(false);
  });

  it('keeps a reply of any length across a restart, and shows a run it cannot read as failed', async () => {
    const dataDir = await makeDataDir();
    const openCode = createOpenCode();
    openCode.state.replies[ORIGINAL].push('h'.repeat(150_000));
    // The reviewer is busy, so the long review prompt waits on disk.
    openCode.state.active = { [REVIEW]: { type: 'running' } };
    const first = await createRuntime({ dataDir, openCode });
    first.runtime.start();
    await first.runtime.startRun(startInput());
    expect(await until(() => runOf(first.runtime)?.step === 'review')).toBe(true);
    first.runtime.stop();
    await first.runtime.flush();

    const file = path.join(dataDir, 'auto-review.json');
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    stored.runs.push({ originalSessionID: 'ses_broken', reviewSessionID: 'ses_broken_review', directory: DIRECTORY, status: 'nonsense' });
    await fs.writeFile(file, JSON.stringify(stored));

    openCode.state.active = {};
    const second = await createRuntime({ dataDir, openCode });
    second.runtime.start();
    expect(await until(() => openCode.state.prompts.length === 2)).toBe(true);
    expect(openCode.state.prompts[1].text).toHaveLength('Review this.\n\n'.length + 150_000);
    expect(second.runtime.snapshot().runs.find((run) => run.originalSessionID === 'ses_broken')).toMatchObject({
      status: 'failed',
      error: 'The saved review could not be read after a restart.',
    });
  });

  it('cuts a long failure to one line for the row', async () => {
    const { runtime, openCode } = await createRuntime();
    openCode.state.replies[ORIGINAL].push({ outcome: 'failed', error: 'e'.repeat(3_000) });
    runtime.start();
    await runtime.startRun(startInput());
    expect(await until(() => runOf(runtime)?.status === 'failed')).toBe(true);
    expect(runOf(runtime).error.length).toBe(500);
  });

  it('refuses a second running review of the same session and a session reviewing itself', async () => {
    const { runtime, openCode } = await createRuntime();
    openCode.state.active = { [ORIGINAL]: { type: 'running' } };
    runtime.start();
    await runtime.startRun(startInput());
    await expect(runtime.startRun(startInput())).rejects.toMatchObject({ status: 409 });
    await expect(runtime.startRun(startInput({ reviewSessionID: ORIGINAL }))).rejects.toBeInstanceOf(TypeError);
  });

  it('stops a running review on request, releases the queue and tells the clients', async () => {
    const { runtime, openCode, broadcasts, settled } = await createRuntime();
    openCode.state.active = { [ORIGINAL]: { type: 'running' } };
    runtime.start();
    await runtime.startRun(startInput());
    expect(runtime.isRunning(ORIGINAL)).toBe(true);

    await runtime.removeRun(ORIGINAL);
    expect(runtime.isRunning(ORIGINAL)).toBe(false);
    expect(runtime.snapshot().runs).toEqual([]);
    expect(await until(() => settled.length === 2)).toBe(true);
    expect(broadcasts.at(-1)).toMatchObject({
      type: 'openchamber:auto-review.updated',
      properties: { originalSessionID: ORIGINAL, directory: DIRECTORY, run: null },
    });
  });
});
