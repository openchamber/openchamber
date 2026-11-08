import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeMetadataPatch } from '../openchamber-sessions/session-metadata-store.js';
import { decideAssist } from './questions.js';
import { createSessionWorkRuntime } from './runtime.js';
import { createSessionLineage } from '../session-lineage.js';

const ENDPOINT = { url: 'https://jev.test', model: 'jev', headers: {} };

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
} = {}) => {
  const records = new Map([['ses_1', metadata]]);
  const readMetadata = vi.fn(async (id) => records.get(id) ?? {});
  const updateMetadata = vi.fn(async (id, decide) => {
    const current = records.get(id) ?? {};
    const patch = decide(current);
    if (!patch) return { metadata: current, changed: false };
    const merged = mergeMetadataPatch(current, patch);
    records.set(id, merged);
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
    chatRoots: ['/home/me/.config/openchamber/chats'],
    lineage,
    now: () => time++,
    openRetryDelaysMs: [5, 5],
  });
  return { runtime, jev, readMetadata, updateMetadata, records };
};

const restored = { type: 'session.unarchived', properties: { sessionID: 'ses_1' } };
const busy = { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } };
const workState = (records) => records.get('ses_1').openchamber?.work?.state;

const sent = (id = 'msg_new', text = 'Now fix the header') => ({
  type: 'message.updated',
  properties: { sessionID: 'ses_1', info: { id, role: 'user', text, time: { created: 50 } } },
});

const settle = async (check) => {
  for (let i = 0; i < 50 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('session work decisions', () => {
  it('keeps an assist field Jev did not answer, and drops only a clear no', () => {
    expect(decideAssist({})).toEqual({ recap: true, suggestion: true });
    expect(decideAssist({ recap: { noul: 0.2 }, next_step: { noul: 0.1 } })).toEqual({ recap: false, suggestion: false });
    expect(decideAssist({ recap: { noul: 0.6 }, next_step: { noul: 0.7 } })).toEqual({ recap: true, suggestion: true });
  });
});

describe('session work runtime: a message was sent', () => {
  it('opens the session on a sent message without asking Jev', async () => {
    stubOpenCode();
    const { runtime, jev, records } = makeRuntime();

    runtime.processPayload(sent());
    await settle(() => records.get('ses_1').openchamber);

    expect(jev.ask).not.toHaveBeenCalled();
    expect(records.get('ses_1')).toMatchObject({ openchamber: { work: { state: 'open', openedBy: 'auto' } } });
  });

  it('opens the session on a message with only an attachment or attached context', async () => {
    stubOpenCode();
    const { runtime, records } = makeRuntime();

    runtime.processPayload(sent('msg_files', ''));
    await settle(() => records.get('ses_1').openchamber);

    expect(records.get('ses_1')).toMatchObject({ openchamber: { work: { state: 'open', openedBy: 'auto' } } });
  });

  it('opens the session on a shell command the user ran', async () => {
    stubOpenCode();
    const { runtime, records } = makeRuntime();

    runtime.processPayload({ type: 'session.shell.started', id: 'evt_shell', created: 50, properties: { sessionID: 'ses_1' } });
    await settle(() => records.get('ses_1').openchamber);

    expect(records.get('ses_1')).toMatchObject({ openchamber: { work: { state: 'open', openedBy: 'auto' } } });
  });

  it('reopens a session closed before the message was sent, and keeps one closed after it', async () => {
    stubOpenCode();
    // `sent()` is created at 50.
    const reopened = makeRuntime({ metadata: { openchamber: { work: { state: 'done', doneAt: 40 } } } });
    reopened.runtime.processPayload(sent());
    await settle(() => reopened.records.get('ses_1').openchamber.work.state === 'open');
    expect(reopened.records.get('ses_1').openchamber.work.state).toBe('open');

    const kept = makeRuntime({ metadata: { openchamber: { work: { state: 'done', doneAt: 60 } } } });
    kept.runtime.processPayload(sent());
    await settle(() => kept.updateMetadata.mock.calls.length > 0);
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
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const fail of ['metadata', 'session', 'write']) {
      const fetchMock = stubOpenCode();
      const { runtime, readMetadata, updateMetadata, records } = makeRuntime();
      if (fail === 'metadata') readMetadata.mockRejectedValueOnce(new Error('store unreadable'));
      if (fail === 'session') fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
      if (fail === 'write') updateMetadata.mockRejectedValueOnce(new Error('write failed'));

      runtime.processPayload(sent('msg_retry'));
      await settle(() => workState(records) === 'open');
      expect(workState(records), fail).toBe('open');
      vi.unstubAllGlobals();
    }
  });

  it('gives up after its bounded retries', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubOpenCode();
    const { runtime, updateMetadata } = makeRuntime();
    updateMetadata.mockRejectedValue(new Error('write failed'));

    runtime.processPayload(sent('msg_retry'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The first try and one per retry delay.
    expect(updateMetadata).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('gave up'), 'write failed');
  });

  it('does not retry a session OpenCode no longer has', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ _tag: 'SessionNotFoundError', sessionID: 'ses_1', message: 'Session not found' }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const { runtime } = makeRuntime();

    runtime.processPayload(sent('msg_gone'));
    await new Promise((resolve) => setTimeout(resolve, 60));
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
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubOpenCode();
    const { runtime, jev, updateMetadata, records } = makeRuntime({ settings: { enabled: true, reviewOffer: true } });
    let answer;
    jev.ask.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    updateMetadata.mockRejectedValueOnce(new Error('write failed'));

    runtime.processPayload(sent('msg_turn'));
    runtime.processPayload(busy);
    const pending = runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: false, suggestion: false } });
    await settle(() => answer !== undefined && workState(records) === 'open');
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
      answers: { recap: { noul: 0.9 }, next_step: { noul: 0.1 } },
    });

    const gate = await runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: true, suggestion: true } });

    expect(jev.ask).toHaveBeenCalledTimes(1);
    expect(Object.keys(jev.ask.mock.calls[0][0].questions).sort()).toEqual(['next_step', 'recap', 'review_ready']);
    expect(jev.ask.mock.calls[0][0].state).toMatchObject({ request: 'Implement it', answer: 'Done, try it.' });
    expect(gate).toEqual({ recap: true, suggestion: false });
    expect(records.get('ses_1')).toEqual({});
  });

  it('asks only about the end of the work and a review in a session already in work, and a new turn retires the hint', async () => {
    stubOpenCode();
    const { runtime, jev, records, updateMetadata } = makeRuntime({
      metadata: { openchamber: { work: { state: 'open', openedAt: 1 } } },
      answers: { wrap_up: { noul: 0.93 } },
    });

    const gate = await runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: false, suggestion: false } });

    expect(Object.keys(jev.ask.mock.calls[0][0].questions)).toEqual(['wrap_up', 'review_ready']);
    expect(gate).toBeNull();
    expect(records.get('ses_1').openchamber.work.suggestDoneAt).toBeTypeOf('number');

    const busy = { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } };
    runtime.processPayload(busy);
    runtime.processPayload(busy);
    await settle(() => records.get('ses_1').openchamber.work.suggestDoneAt === undefined);
    expect(records.get('ses_1').openchamber.work).not.toHaveProperty('suggestDoneAt');
    // One write for the hint, one to retire it: the second busy found nothing to retire.
    expect(updateMetadata).toHaveBeenCalledTimes(2);
  });

  it('offers a review after a turn that changed the project, and looks done wins over it', async () => {
    stubOpenCode();
    const open = { openchamber: { work: { state: 'open', openedAt: 1 } } };
    const review = makeRuntime({ metadata: open, answers: { wrap_up: { noul: 0.2 }, review_ready: { noul: 0.75 } } });
    await review.runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: false, suggestion: false } });
    expect(review.records.get('ses_1').openchamber.reviewOffer.at).toBeTypeOf('number');
    expect(review.records.get('ses_1').openchamber.work).not.toHaveProperty('suggestDoneAt');

    const both = makeRuntime({ metadata: open, answers: { wrap_up: { noul: 0.9 }, review_ready: { noul: 0.9 } } });
    await both.runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: false, suggestion: false } });
    expect(both.records.get('ses_1').openchamber.work.suggestDoneAt).toBeTypeOf('number');
    expect(both.records.get('ses_1').openchamber).not.toHaveProperty('reviewOffer');
  });

  it('offers a review without In work, asks nothing about it when it is off, and a new turn retires it', async () => {
    stubOpenCode();
    const solo = makeRuntime({ settings: { enabled: false }, answers: { review_ready: { noul: 0.8 } } });
    await solo.runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: false, suggestion: false } });
    expect(Object.keys(solo.jev.ask.mock.calls[0][0].questions)).toEqual(['review_ready']);
    expect(solo.records.get('ses_1')).toEqual({ openchamber: { reviewOffer: { at: expect.any(Number) } } });
    solo.runtime.processPayload({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
    await settle(() => !solo.records.get('ses_1').openchamber?.reviewOffer);
    expect(solo.records.get('ses_1').openchamber).not.toHaveProperty('reviewOffer');

    const off = makeRuntime({ settings: { reviewOffer: false }, answers: { recap: { noul: 0.1 } } });
    await off.runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: true, suggestion: false } });
    expect(Object.keys(off.jev.ask.mock.calls[0][0].questions)).toEqual(['recap']);
  });

  it('drops a late done answer once the next turn started', async () => {
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
      await settle(() => answer !== undefined);
      runtime.processPayload(busy);
      answer({ answers: { wrap_up: { noul: 0.99 } }, ms: 5 });
      await pending;
      expect(records.get('ses_1').openchamber.work).not.toHaveProperty('suggestDoneAt');
    }

    // A check nobody overtook still writes its hint.
    answer = undefined;
    const current = runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: false, suggestion: false } });
    await settle(() => answer !== undefined);
    answer({ answers: { wrap_up: { noul: 0.99 } }, ms: 5 });
    await current;
    expect(records.get('ses_1').openchamber.work.suggestDoneAt).toBeTypeOf('number');
  });

  it('never closes: a closing turn in a session in work only hints', async () => {
    stubOpenCode();
    const { runtime, records } = makeRuntime({
      metadata: { openchamber: { work: { state: 'open', openedAt: 1 } } },
      answers: { wrap_up: { noul: 0.99 } },
    });
    await runtime.evaluateTurnEnd({ sessionId: 'ses_1', directory: '/repo', assist: { recap: false, suggestion: false } });
    expect(records.get('ses_1').openchamber.work.state).toBe('open');
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
