import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeMetadataPatch } from '../openchamber-sessions/session-metadata-store.js';
import { decideAssist, decideWrapUp } from './questions.js';
import { createSessionWorkRuntime } from './runtime.js';
import { createSessionLineage } from '../session-lineage.js';

const ENDPOINT = { url: 'https://jev.test', model: 'jev', headers: {} };
const OPEN_RETRY_DELAYS_MS = [5, 5];
const DONE_HINT_DELAY_MS = 5;

// v2 serves a session's messages newest first.
const settledPair = [
  { id: 'msg_a1', type: 'assistant', content: [{ type: 'text', text: 'Here is how it works.' }], finish: 'stop', time: { completed: 2 } },
  { id: 'msg_u1', type: 'user', text: 'How does the sidebar work?', time: { created: 1 } },
];
const answeredTurn = [
  { id: 'msg_idle', type: 'idle', outcome: 'succeeded' },
  { id: 'msg_a2', type: 'assistant', content: [{ type: 'text', text: 'Done, try it.' }], finish: 'stop', time: { completed: 4 } },
  { id: 'msg_u2', type: 'user', text: 'Implement it', time: { created: 3 } },
  ...settledPair,
];

const stubOpenCode = ({ session = {}, records = answeredTurn } = {}) => {
  const fetchMock = vi.fn(async (input) => {
    const url = new URL(String(input));
    let body;
    if (url.pathname === '/api/session/ses_1') body = { data: { id: 'ses_1', ...session } };
    else if (url.pathname === '/api/session/ses_1/message') body = { data: records, cursor: {} };
    else throw new Error(`unexpected ${url.pathname}`);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const makeRuntime = ({
  metadata = {},
  answers = {},
  askError = null,
  settings = {},
  endpoint = ENDPOINT,
  lineage = null,
  isSessionArchived = async () => false,
  isWorktreePinned = async () => false,
  doneHintDelayMs = DONE_HINT_DELAY_MS,
  activityProbe = null,
} = {}) => {
  const records = new Map([['ses_1', metadata]]);
  const written = Promise.withResolvers();
  const readMetadata = vi.fn(async (id) => records.get(id) ?? {});
  const updateMetadata = vi.fn(async (id, decide) => {
    const current = records.get(id) ?? {};
    const patch = decide(current);
    if (!patch) {
      written.resolve();
      return { metadata: current, changed: false };
    }
    const merged = mergeMetadataPatch(current, patch);
    records.set(id, merged);
    written.resolve();
    return { metadata: merged, changed: true };
  });
  const jev = { ask: vi.fn(async () => { if (askError) throw askError; return { answers, ms: 5 }; }) };
  let time = 100;
  const runtime = createSessionWorkRuntime({
    buildOpenCodeUrl: (fetchPath) => `http://opencode.test${fetchPath}`,
    getOpenCodeAuthHeaders: () => ({}),
    getSettings: () => ({ enabled: true, reviewOffer: true, ...settings }),
    classifierEndpoint: async () => endpoint,
    jev,
    readMetadata,
    updateMetadata,
    isSessionArchived,
    isWorktreePinned,
    chatRoots: ['/home/me/.config/openchamber/chats'],
    lineage,
    now: () => time++,
    openRetryDelaysMs: OPEN_RETRY_DELAYS_MS,
    doneHintDelayMs,
    activityProbe,
  });
  return { runtime, jev, readMetadata, updateMetadata, records, written: written.promise };
};

const restored = { type: 'session.unarchived', properties: { sessionID: 'ses_1' } };
const busy = { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } };
const workState = (records) => records.get('ses_1').openchamber?.work?.state;

const sent = (id = 'msg_new', text = 'Now fix the header') => ({
  type: 'message.updated',
  properties: { sessionID: 'ses_1', info: { id, role: 'user', text, time: { created: 50 } } },
});

/** Jev's answers to the looks-done signs: a report with nothing going on, waited for or offered. */
const looksDone = { report: { noul: 0.9 }, agent_continues: { noul: 0.1 }, waits_reader: { noul: 0.1 }, offers_agent: { noul: 0.1 } };
const notDone = { ...looksDone, agent_continues: { noul: 0.8 } };

const settle = async (check) => {
  for (let i = 0; i < 50 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('session work decisions', () => {
  it('keeps an assist field Jev did not answer, and drops only a clear no', () => {
    expect(decideAssist({})).toEqual({ recap: true, suggestion: true });
    // Looks done needs every sign answered: an unanswered one never hints.
    expect(decideWrapUp(looksDone)).toBe(true);
    expect(decideWrapUp({ ...looksDone, offers_agent: undefined })).toBe(false);
    expect(decideWrapUp(notDone)).toBe(false);
    expect(decideAssist({ recap: { noul: 0.2 }, agent_continues: { noul: 0.1 }, waits_reader: { noul: 0.1 } })).toEqual({ recap: false, suggestion: false });
    expect(decideAssist({ agent_continues: { noul: 0.9 }, waits_reader: { noul: 0.8 } })).toMatchObject({ suggestion: false });
    expect(decideAssist({ recap: { noul: 0.6 }, agent_continues: { noul: 0.7 }, waits_reader: { noul: 0.2 } })).toEqual({ recap: true, suggestion: true });
  });
});

describe('session work runtime: a message was sent', () => {
  it('opens the session on a sent message without asking Jev', async () => {
    stubOpenCode();
    const { runtime, jev, records, written } = makeRuntime();

    runtime.processPayload(sent());
    await written;

    expect(jev.ask).not.toHaveBeenCalled();
    expect(records.get('ses_1')).toMatchObject({ openchamber: { work: { state: 'open', openedBy: 'auto' } } });
  });

  it('opens nothing in a pinned session or in a session of a pinned worktree', async () => {
    stubOpenCode({ session: { location: { directory: '/repo-wt' } } });
    const pinnedSession = makeRuntime({ metadata: { openchamber: { pinned: { at: 1 } } } });
    pinnedSession.runtime.processPayload(sent());
    await settle(() => pinnedSession.updateMetadata.mock.calls.length > 0);
    expect(pinnedSession.records.get('ses_1')).toEqual({ openchamber: { pinned: { at: 1 } } });

    const isWorktreePinned = vi.fn(async () => true);
    const inPinnedWorktree = makeRuntime({ isWorktreePinned });
    inPinnedWorktree.runtime.processPayload(sent());
    await settle(() => isWorktreePinned.mock.calls.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(isWorktreePinned).toHaveBeenCalledWith('/repo-wt');
    expect(inPinnedWorktree.updateMetadata).not.toHaveBeenCalled();
  });

  it('opens the session on a message with only an attachment or attached context', async () => {
    stubOpenCode();
    const { runtime, records, written } = makeRuntime();

    runtime.processPayload(sent('msg_files', ''));
    await written;

    expect(records.get('ses_1')).toMatchObject({ openchamber: { work: { state: 'open', openedBy: 'auto' } } });
  });

  it('opens the session on a shell command the user ran', async () => {
    stubOpenCode();
    const { runtime, records, written } = makeRuntime();

    runtime.processPayload({ type: 'session.shell.started', id: 'evt_shell', created: 50, properties: { sessionID: 'ses_1' } });
    await written;

    expect(records.get('ses_1')).toMatchObject({ openchamber: { work: { state: 'open', openedBy: 'auto' } } });
  });

  it('reopens a session closed before the message was sent, and keeps one closed after it', async () => {
    stubOpenCode();
    // `sent()` is created at 50.
    const reopened = makeRuntime({ metadata: { openchamber: { work: { state: 'done', doneAt: 40 } } } });
    reopened.runtime.processPayload(sent());
    await reopened.written;
    expect(reopened.records.get('ses_1').openchamber.work.state).toBe('open');

    const kept = makeRuntime({ metadata: { openchamber: { work: { state: 'done', doneAt: 60 } } } });
    kept.runtime.processPayload(sent());
    await kept.written;
    expect(kept.records.get('ses_1').openchamber.work.state).toBe('done');
  });

  it('reads nothing for a session already in work, and handles a message once', async () => {
    const fetchMock = stubOpenCode();
    const open = makeRuntime({ metadata: { openchamber: { work: { state: 'open' } } } });
    open.runtime.processPayload(sent());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(open.updateMetadata).not.toHaveBeenCalled();

    const fresh = makeRuntime();
    fresh.runtime.processPayload(sent('msg_x'));
    fresh.runtime.processPayload(sent('msg_x'));
    await settle(() => fresh.updateMetadata.mock.calls.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fresh.updateMetadata).toHaveBeenCalledTimes(1);
  });

  it('skips a known subsession without reading it, and learns one it had to read', async () => {
    const lineage = createSessionLineage();
    lineage.remember('ses_1', 'ses_parent');
    const fetchMock = stubOpenCode();
    const known = makeRuntime({ lineage });
    known.runtime.processPayload(sent());
    expect(await known.runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: true, suggestion: true } })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(known.jev.ask).not.toHaveBeenCalled();
    vi.unstubAllGlobals();

    const learning = createSessionLineage();
    stubOpenCode({ session: { parentID: 'ses_parent' } });
    const unknown = makeRuntime({ lineage: learning });
    await unknown.runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: true, suggestion: true } });
    expect(learning.isChild('ses_1')).toBe(true);
  });

  it('opens nothing with In work off, or in a child, review, /btw, scheduled, or chat session', async () => {
    for (const setup of [
      { runtime: { settings: { enabled: false } } },
      { session: { parentID: 'ses_parent' } },
      { session: { metadata: { openchamber: { kind: 'review', originalSessionID: 'ses_0' } } } },
      { session: { metadata: { openchamber: { kind: 'btw', originalSessionID: 'ses_0' } } } },
      { session: { metadata: { openchamber: { kind: 'scheduled' } } } },
      { session: { location: { directory: '/home/me/.config/openchamber/chats/2026-09-27/hello' } } },
    ]) {
      stubOpenCode({ session: setup.session });
      const { runtime, updateMetadata } = makeRuntime(setup.runtime);
      runtime.processPayload(sent());
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(updateMetadata).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  });
});

describe('session work runtime: recovering an open that failed', () => {
  it('opens after a failed metadata read, session read or write, with no second delivery', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const fail of ['metadata', 'session', 'write']) {
      const fetchMock = stubOpenCode();
      const { runtime, readMetadata, updateMetadata, records, written } = makeRuntime();
      if (fail === 'metadata') readMetadata.mockRejectedValueOnce(new Error('store unreadable'));
      if (fail === 'session') fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
      if (fail === 'write') updateMetadata.mockRejectedValueOnce(new Error('write failed'));

      runtime.processPayload(sent('msg_retry'));
      await vi.advanceTimersByTimeAsync(OPEN_RETRY_DELAYS_MS[0]);
      await written;
      expect(workState(records), fail).toBe('open');
      vi.unstubAllGlobals();
    }
  });

  it('gives up after its bounded retries', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubOpenCode();
    const { runtime, updateMetadata } = makeRuntime();
    updateMetadata.mockRejectedValue(new Error('write failed'));

    runtime.processPayload(sent('msg_retry'));
    for (const delay of OPEN_RETRY_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay);
    // The first try and one per retry delay.
    expect(updateMetadata).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('gave up'), 'write failed');
  });

  it('does not retry a session OpenCode no longer has', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ _tag: 'SessionNotFoundError', sessionID: 'ses_1', message: 'Session not found' }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const { runtime } = makeRuntime();

    runtime.processPayload(sent('msg_gone'));
    for (const delay of OPEN_RETRY_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('opens a session a message reached while archived once it is restored', async () => {
    stubOpenCode();
    let archived = true;
    const { runtime, updateMetadata, records } = makeRuntime({ isSessionArchived: async () => archived });

    runtime.processPayload(sent('msg_archived'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(updateMetadata).not.toHaveBeenCalled();

    archived = false;
    runtime.processPayload(restored);
    await settle(() => workState(records) === 'open');
    expect(workState(records)).toBe('open');

    // A later restore owes nothing more.
    runtime.processPayload(restored);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(updateMetadata).toHaveBeenCalledTimes(1);
  });

  it('keeps a session closed when the user closed it after the message, even once restored', async () => {
    stubOpenCode();
    let archived = true;
    const { runtime, records } = makeRuntime({ isSessionArchived: async () => archived });

    runtime.processPayload(sent('msg_archived'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The user marks it done after the message was sent (`sent()` is created at 50).
    records.set('ses_1', { openchamber: { work: { state: 'done', doneAt: 60 } } });
    archived = false;
    runtime.processPayload(restored);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(workState(records)).toBe('done');
  });

  it('opens nothing on a restore once In work was turned off', async () => {
    stubOpenCode();
    let archived = true;
    const settings = { enabled: true };
    const { runtime, records } = makeRuntime({ settings, isSessionArchived: async () => archived });
    runtime.processPayload(sent('msg_archived'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    archived = false;
    settings.enabled = false;
    runtime.processPayload(restored);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(workState(records)).toBeUndefined();
  });

  it('writes nothing once stopped while it read the archive state', async () => {
    stubOpenCode();
    let answerArchived;
    const { runtime, updateMetadata } = makeRuntime({
      isSessionArchived: () => new Promise((resolve) => { answerArchived = resolve; }),
    });
    runtime.processPayload(sent('msg_stop'));
    await settle(() => answerArchived !== undefined);
    runtime.stop();
    answerArchived(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it('does not start another turn when it retries: the current turn still gets its hint', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubOpenCode();
    const { runtime, jev, updateMetadata, records, written } = makeRuntime({ settings: { enabled: true, reviewOffer: true } });
    const asked = Promise.withResolvers();
    let answer;
    jev.ask.mockImplementation(() => new Promise((resolve) => { answer = resolve; asked.resolve(); }));
    updateMetadata.mockRejectedValueOnce(new Error('write failed'));

    runtime.processPayload(sent('msg_turn'));
    runtime.processPayload(busy);
    const pending = runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: false, suggestion: false } });
    await asked.promise;
    await vi.advanceTimersByTimeAsync(OPEN_RETRY_DELAYS_MS[0]);
    await written;
    expect(workState(records)).toBe('open');

    answer({ answers: { review_ready: { noul: 0.9 } }, ms: 5 });
    await pending;
    expect(records.get('ses_1').openchamber.reviewOffer.at).toBeTypeOf('number');
  });
});

describe('session work runtime: a turn ended', () => {
  it('asks only the assist and review questions for a session not in work, and never opens it', async () => {
    stubOpenCode();
    const { runtime, jev, records } = makeRuntime({
      answers: { recap: { noul: 0.9 }, agent_continues: { noul: 0.1 }, waits_reader: { noul: 0.1 } },
    });

    const gate = await runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: true, suggestion: true } });

    expect(jev.ask).toHaveBeenCalledTimes(1);
    expect(Object.keys(jev.ask.mock.calls[0][0].questions).sort()).toEqual(['agent_continues', 'recap', 'review_ready', 'waits_reader']);
    expect(jev.ask.mock.calls[0][0].state).toMatchObject({ request: 'Implement it', answer: 'Done, try it.' });
    expect(gate).toEqual({ recap: true, suggestion: false });
    expect(records.get('ses_1')).toEqual({});
  });

  it('asks only about the end of the work and a review in a session already in work, and a new turn retires the hint', async () => {
    vi.useFakeTimers();
    stubOpenCode();
    const { runtime, jev, records, updateMetadata } = makeRuntime({
      metadata: { openchamber: { work: { state: 'open', openedAt: 1 } } },
      answers: looksDone,
    });

    const gate = await runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: false, suggestion: false } });

    expect(Object.keys(jev.ask.mock.calls[0][0].questions)).toEqual(['report', 'agent_continues', 'waits_reader', 'offers_agent', 'review_ready']);
    expect(gate).toBeNull();
    await vi.advanceTimersByTimeAsync(DONE_HINT_DELAY_MS);
    expect(records.get('ses_1').openchamber.work.suggestDoneAt).toBeTypeOf('number');

    const busy = { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } };
    runtime.processPayload(busy);
    runtime.processPayload(busy);
    await updateMetadata.mock.results.at(-1).value;
    expect(records.get('ses_1').openchamber.work).not.toHaveProperty('suggestDoneAt');
    // One write for the hint, one to retire it: the second busy found nothing to retire.
    expect(updateMetadata).toHaveBeenCalledTimes(2);
  });

  it('offers a review at once, and looks done replaces it after the quiet pause', async () => {
    vi.useFakeTimers();
    stubOpenCode();
    const open = { openchamber: { work: { state: 'open', openedAt: 1 } } };
    const review = makeRuntime({ metadata: open, answers: { ...notDone, review_ready: { noul: 0.75 } } });
    await review.runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: false, suggestion: false } });
    expect(review.records.get('ses_1').openchamber.reviewOffer.at).toBeTypeOf('number');
    expect(review.records.get('ses_1').openchamber.work).not.toHaveProperty('suggestDoneAt');

    const both = makeRuntime({ metadata: open, answers: { ...looksDone, review_ready: { noul: 0.9 } }, doneHintDelayMs: 20 });
    await both.runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: false, suggestion: false } });
    expect(both.records.get('ses_1').openchamber.reviewOffer.at).toBeTypeOf('number');
    await vi.advanceTimersByTimeAsync(19);
    expect(both.records.get('ses_1').openchamber.work).not.toHaveProperty('suggestDoneAt');
    await vi.advanceTimersByTimeAsync(1);
    expect(both.records.get('ses_1').openchamber.work.suggestDoneAt).toBeTypeOf('number');
    expect(both.records.get('ses_1').openchamber).not.toHaveProperty('reviewOffer');
  });

  it('shows no done hint when the user writes again within the pause, or the runtime stops', async () => {
    vi.useFakeTimers();
    const doneHintDelayMs = 30;
    stubOpenCode();
    const open = { openchamber: { work: { state: 'open', openedAt: 1 } } };
    const replied = makeRuntime({ metadata: open, answers: looksDone, doneHintDelayMs });
    await replied.runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: false, suggestion: false } });
    replied.runtime.processPayload(sent('msg_next'));
    await vi.advanceTimersByTimeAsync(doneHintDelayMs);
    expect(replied.records.get('ses_1').openchamber.work).not.toHaveProperty('suggestDoneAt');

    // A late answer about an older turn leaves the newer turn's pending hint alone.
    const late = makeRuntime({ metadata: open, doneHintDelayMs });
    const answers = [];
    const asked = [Promise.withResolvers(), Promise.withResolvers()];
    late.jev.ask.mockImplementation(() => new Promise((resolve) => {
      answers.push(resolve);
      asked[answers.length - 1].resolve();
    }));
    const older = late.runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: false, suggestion: false } });
    await asked[0].promise;
    late.runtime.processPayload(busy);
    const newer = late.runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: false, suggestion: false } });
    await asked[1].promise;
    answers[1]({ answers: looksDone, ms: 5 });
    await newer;
    answers[0]({ answers: looksDone, ms: 5 });
    await older;
    await vi.advanceTimersByTimeAsync(doneHintDelayMs);
    expect(late.records.get('ses_1').openchamber.work.suggestDoneAt).toBeTypeOf('number');

    const stopped = makeRuntime({ metadata: open, answers: looksDone, doneHintDelayMs });
    await stopped.runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: false, suggestion: false } });
    stopped.runtime.stop();
    await vi.advanceTimersByTimeAsync(doneHintDelayMs);
    expect(stopped.updateMetadata).not.toHaveBeenCalled();
  });

  it('offers a review without In work, asks nothing about it when it is off, and a new turn retires it', async () => {
    stubOpenCode();
    const solo = makeRuntime({ settings: { enabled: false }, answers: { review_ready: { noul: 0.8 } } });
    await solo.runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: false, suggestion: false } });
    expect(Object.keys(solo.jev.ask.mock.calls[0][0].questions)).toEqual(['review_ready']);
    expect(solo.records.get('ses_1')).toEqual({ openchamber: { reviewOffer: { at: expect.any(Number) } } });
    solo.runtime.processPayload({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
    await solo.updateMetadata.mock.results.at(-1).value;
    expect(solo.records.get('ses_1').openchamber).not.toHaveProperty('reviewOffer');

    const off = makeRuntime({ settings: { reviewOffer: false }, answers: { recap: { noul: 0.1 } } });
    await off.runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: true, suggestion: false } });
    expect(Object.keys(off.jev.ask.mock.calls[0][0].questions)).toEqual(['recap']);
  });

  it('drops a late done answer once the next turn started', async () => {
    vi.useFakeTimers();
    stubOpenCode();
    const { runtime, jev, records } = makeRuntime({
      metadata: { openchamber: { work: { state: 'open', openedAt: 1 } } },
    });
    let answer;
    jev.ask.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));

    const busy = { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } };
    // The ordinary lifecycle, several turns in a row: every turn starts with a
    // busy, ends, gets checked, and the user moves on before Jev answers.
    for (let turn = 0; turn < 3; turn += 1) {
      answer = undefined;
      runtime.processPayload(busy);
      const pending = runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: false, suggestion: false } });
      await vi.advanceTimersByTimeAsync(0);
      runtime.processPayload(busy);
      answer({ answers: looksDone, ms: 5 });
      await pending;
      await vi.advanceTimersByTimeAsync(5);
      expect(records.get('ses_1').openchamber.work).not.toHaveProperty('suggestDoneAt');
    }

    // A check nobody overtook still writes its hint.
    answer = undefined;
    const current = runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: false, suggestion: false } });
    await vi.advanceTimersByTimeAsync(0);
    answer({ answers: looksDone, ms: 5 });
    await current;
    await vi.advanceTimersByTimeAsync(5);
    expect(records.get('ses_1').openchamber.work.suggestDoneAt).toBeTypeOf('number');
  });

  it('neither hints done nor suggests a next step while the agent waits on its own background work', async () => {
    vi.useFakeTimers();
    stubOpenCode();
    const open = { openchamber: { work: { state: 'open', openedAt: 1 } } };
    const probe = (jobs, children = false) => ({
      fetchRunningBackgroundJobs: vi.fn(async () => jobs),
      fetchActiveSessionStatuses: vi.fn(async () => ({})),
      hasWorkingChildren: vi.fn(async () => children),
    });
    const continues = { ...looksDone, agent_continues: { noul: 0.9 } };
    const assist = { recap: false, suggestion: true };
    // The turn's user message was sent at 3; `now` starts at 100.
    const waiting = [
      [{ kind: 'subagent', sessionID: 'ses_child', startedAt: 1 }],
      [{ kind: 'shell', sessionID: 'ses_1', command: 'bun test', startedAt: 50 }],
      [],
    ];
    for (const [index, jobs] of waiting.entries()) {
      const done = makeRuntime({ metadata: open, answers: looksDone, activityProbe: probe(jobs, index === 2) });
      expect(await done.runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist })).toMatchObject({ suggestion: false });
      const next = makeRuntime({ answers: continues, activityProbe: probe(jobs, index === 2) });
      expect(await next.runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist })).toMatchObject({ suggestion: false });
      await vi.advanceTimersByTimeAsync(DONE_HINT_DELAY_MS);
      expect(done.records.get('ses_1').openchamber.work).not.toHaveProperty('suggestDoneAt');
    }

    // Known background work still rules out a next step when Jev fails.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failed = makeRuntime({ askError: new Error('Jev timed out'), activityProbe: probe(waiting[0]) });
    expect(await failed.runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist })).toEqual({ recap: true, suggestion: false });

    // A dev server started before this turn is not work the agent waits on.
    const server = [{ kind: 'shell', sessionID: 'ses_1', command: 'bun run dev', startedAt: 1 }];
    const free = makeRuntime({ answers: continues, activityProbe: probe(server) });
    expect(await free.runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist })).toMatchObject({ suggestion: true });
    const finished = makeRuntime({ metadata: open, answers: looksDone, activityProbe: probe(server) });
    await finished.runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist });
    await vi.advanceTimersByTimeAsync(DONE_HINT_DELAY_MS);
    expect(finished.records.get('ses_1').openchamber.work.suggestDoneAt).toBeTypeOf('number');
  });

  it('asks about a review only when the turn changed files on disk, or when OpenCode took no snapshot', async () => {
    const withSnapshot = (files) => [
      answeredTurn[0],
      { ...answeredTurn[1], snapshot: { start: 'a', end: 'b', files } },
      { id: 'msg_step', type: 'assistant', content: [], finish: 'tool-calls', snapshot: { start: 'a', end: 'a', files: [] } },
      ...answeredTurn.slice(2),
    ];
    const questionsFor = async (records) => {
      stubOpenCode({ records });
      const { runtime, jev } = makeRuntime({ settings: { enabled: false }, answers: { review_ready: { noul: 0.9 } } });
      await runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: true, suggestion: false } });
      return Object.keys(jev.ask.mock.calls[0][0].questions);
    };
    expect(await questionsFor(withSnapshot([]))).toEqual(['recap']);
    expect(await questionsFor(withSnapshot(['src/app.ts']))).toEqual(['review_ready', 'recap']);
    expect(await questionsFor(answeredTurn)).toEqual(['review_ready', 'recap']);
  });

  it('answers unknown on a Jev failure and changes nothing', async () => {
    stubOpenCode();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtime, updateMetadata } = makeRuntime({ askError: new Error('Jev timed out after 4000ms') });

    const gate = await runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: true, suggestion: true } });

    expect(gate).toBeNull();
    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it('makes no call when In work, the review offer and both assist fields are off', async () => {
    const fetchMock = stubOpenCode();
    const { runtime, jev } = makeRuntime({ settings: { enabled: false, reviewOffer: false } });
    expect(await runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: false, suggestion: false } })).toBeNull();
    expect(jev.ask).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
