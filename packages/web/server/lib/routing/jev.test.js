import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPermissionRequest,
  buildProbeRequest,
  buildRoutingRequest,
  createJevClient,
  toGeminiDecisionsRequest,
} from './jev.js';
import { SAFETY_CRITERIA, SAFETY_INSTRUCTIONS } from './defaults.js';
import { classifierEndpoint } from './classifier.js';
import { buildTurnEndRequest } from '../session-work/questions.js';
import { buildJevAuditRequest } from '../session-goal/audit.js';

const ENDPOINT = { url: 'http://localhost:11434/v1/systemone', model: 'd3:9b', headers: {} };
const ANSWER = { answers: { category: { choice: 'trivial', confidence: 0.9 } } };

// A fetch whose responses the test releases by hand; an abort rejects it the way fetch does.
const pendingFetch = () => {
  const calls = [];
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    const call = {
      signal: init.signal,
      respond: () => resolve({ ok: true, status: 200, text: async () => JSON.stringify(ANSWER) }),
    };
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    calls.push(call);
  });
  return { calls, fetchImpl };
};

const client = (fetchImpl) => createJevClient({ fetchImpl, timeoutMs: 4000, lingerMs: 60_000, lingering: new Set() });

afterEach(() => {
  vi.useRealTimers();
});

describe('jev client timeout', () => {
  it('answers the turn as a timeout but lets the first timed-out request finish loading the model', async () => {
    vi.useFakeTimers();
    const { calls, fetchImpl } = pendingFetch();
    const jev = client(fetchImpl);

    const first = jev.ask({}, ENDPOINT);
    const firstFailed = expect(first).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(4000);
    await firstFailed;
    expect(calls[0].signal.aborted).toBe(false);

    // A second turn while the first still loads is aborted at its own timeout.
    const second = jev.ask({}, ENDPOINT);
    const secondFailed = expect(second).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(4000);
    await secondFailed;
    expect(calls[1].signal.aborted).toBe(true);
    expect(calls[0].signal.aborted).toBe(false);

    // Once the load finishes the slot is free, and a warm model answers in time.
    calls[0].respond();
    await vi.advanceTimersByTimeAsync(0);
    const third = jev.ask({}, ENDPOINT);
    calls[2].respond();
    await expect(third).resolves.toMatchObject({ answers: ANSWER.answers });
  });

  it('aborts a lingering request at the cap and frees the endpoint', async () => {
    vi.useFakeTimers();
    const { calls, fetchImpl } = pendingFetch();
    const jev = client(fetchImpl);

    const first = expect(jev.ask({}, ENDPOINT)).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(4000);
    await first;
    await vi.advanceTimersByTimeAsync(56_000);
    expect(calls[0].signal.aborted).toBe(true);

    // The next timed-out request may linger again.
    const next = expect(jev.ask({}, ENDPOINT)).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(4000);
    await next;
    expect(calls[1].signal.aborted).toBe(false);
  });

  it('keeps one lingering request per endpoint, so another endpoint gets its own', async () => {
    vi.useFakeTimers();
    const { calls, fetchImpl } = pendingFetch();
    const jev = client(fetchImpl);

    const a = expect(jev.ask({}, ENDPOINT)).rejects.toMatchObject({ code: 'timeout' });
    const b = expect(jev.ask({}, { ...ENDPOINT, model: 'other' })).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(4000);
    await Promise.all([a, b]);
    expect(calls.map((call) => call.signal.aborted)).toEqual([false, false]);
  });

  it('reports an HTTP error before the timeout as it is', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, text: async () => '' });
    await expect(client(fetchImpl).ask({}, ENDPOINT)).rejects.toMatchObject({ status: 401 });
  });
});

describe('Google Decisions requests', () => {
  // Fields Google's reference allows on a question (https://aistudio.google.com/docs/decisions-api).
  const QUESTION_FIELDS = new Set(['type', 'instructions', 'criteria']);

  const expectGoogleRequest = (body) => {
    expect(Object.keys(body).sort()).toEqual(['input', 'questions']);
    expect(body.input).toEqual(expect.any(String));
    for (const question of Object.values(body.questions)) {
      expect(Object.keys(question).every((field) => QUESTION_FIELDS.has(field))).toBe(true);
      expect(question.instructions).toEqual(expect.any(String));
      if (question.type === 'noul' && question.criteria) {
        expect(Object.keys(question.criteria).sort()).toEqual(['false_description', 'true_description']);
      }
    }
  };

  it('sends routing state as JSON text and the choice criteria unchanged', () => {
    const categories = [{ id: 'trivial', description: 'Easy.' }, { id: 'hard', description: 'Hard.' }];
    const history = [{ role: 'user', text: 'earlier' }];
    const request = buildRoutingRequest({ categories, history, request: 'fix it' });
    const body = toGeminiDecisionsRequest(request);
    expectGoogleRequest(body);
    expect(JSON.parse(body.input)).toEqual({ history, request: 'fix it' });
    expect(body.questions.category).toEqual(request.questions.category);
  });

  it('maps the safety net yes/no criteria to true_description and false_description, keeping the choice', () => {
    const request = buildPermissionRequest({ action: 'bash', resources: ['rm -rf build'], metadata: { command: 'rm -rf build' } });
    const body = toGeminiDecisionsRequest(request);
    expectGoogleRequest(body);
    expect(JSON.parse(body.input)).toEqual(request.state);
    expect(body.questions.ask).toEqual({
      type: 'noul',
      instructions: SAFETY_INSTRUCTIONS,
      criteria: { true_description: SAFETY_CRITERIA.true, false_description: SAFETY_CRITERIA.false },
    });
    expect(body.questions.kind).toEqual(request.questions.kind);
  });

  it('joins list instructions a line per item for the session-work and goal checks', () => {
    const turnEnd = buildTurnEndRequest({
      history: [], request: 'ship it', answer: 'Done.', ask: { wrapUp: true, reviewReady: true, recap: true, nextStep: true },
    });
    const work = toGeminiDecisionsRequest(turnEnd);
    expectGoogleRequest(work);
    expect(work.questions.report.instructions).toBe(turnEnd.questions.report.instructions.join('\n'));
    expect(work.questions.report.criteria).toBeUndefined();
    expect(work.questions.recap.criteria).toEqual({
      true_description: turnEnd.questions.recap.criteria.true, false_description: turnEnd.questions.recap.criteria.false,
    });

    const audit = buildJevAuditRequest({ objective: 'Add a test', answer: 'Done: test added.' });
    const goal = toGeminiDecisionsRequest(audit);
    expectGoogleRequest(goal);
    expect(JSON.parse(goal.input)).toEqual(audit.state);
    expect(Object.keys(goal.questions)).toEqual(Object.keys(audit.questions));
  });

  it('keeps the Settings probe a plain choice', () => {
    const body = toGeminiDecisionsRequest(buildProbeRequest());
    expectGoogleRequest(body);
    expect(body.questions.probe).toEqual(buildProbeRequest().questions.probe);
  });

  it('leaves the System One shape for every other endpoint', async () => {
    let sent = null;
    const fetchImpl = async (_url, init) => {
      sent = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => JSON.stringify(ANSWER) };
    };
    await client(fetchImpl).ask(buildProbeRequest(), ENDPOINT);
    expect(sent).toEqual({ ...buildProbeRequest(), model: ENDPOINT.model });
    await client(fetchImpl).ask(buildProbeRequest(), { ...ENDPOINT, format: 'gemini' });
    expect(sent).toEqual({ ...toGeminiDecisionsRequest(buildProbeRequest()), model: ENDPOINT.model });
  });

  it('keeps a key out of the error when fetch refuses it as a header value', async () => {
    // Node's own fetch rejects the line break before any connection; the URL is never reached.
    const endpoint = { ...classifierEndpoint('gemini', { geminiKey: 'AIza-fake\nsecret' }), url: 'http://127.0.0.1:9/decisions' };
    const failure = await client(fetch).ask(buildProbeRequest(), endpoint).catch((error) => error);
    expect(failure.message).toBe('Could not reach Google Gemini');
    expect(JSON.stringify({ message: failure.message, cause: String(failure.cause) })).not.toContain('secret');
  });
});
