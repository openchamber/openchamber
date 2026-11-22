import { beforeEach, describe, expect, test } from 'bun:test';

import { createQuestionTimeoutRunner, type PendingQuestionForm, useQuestionTimeoutStore } from './question-timeouts';

const MINUTE = 60_000;

const reset = () => useQuestionTimeoutStore.setState({ seenAt: {}, closed: {} });

const messageFor = (reason: 'timeout' | 'later', minutes: number) => `${reason}:${minutes}`;

/** A small deterministic generator (mulberry32), so a failing case reproduces from its seed. */
const random = (seed: number) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('question timeouts', () => {
  beforeEach(() => {
    reset();
  });

  test('a form is closed once it has waited the set minutes, and its question is marked timed out', async () => {
    let now = 1_000;
    const cancelled: string[] = [];
    const messages: string[] = [];
    const forms: PendingQuestionForm[] = [{ id: 'form_1', sessionId: 'ses_1', call: 'msg_1:call_1' }];
    const tick = createQuestionTimeoutRunner({
      now: () => now,
      timeoutMinutes: () => 5,
      inBackground: () => false,
      message: messageFor,
      pendingForms: () => forms,
      cancel: async (_sessionId, formId, message) => {
        cancelled.push(formId);
        messages.push(message);
      },
    });

    await tick();
    expect(useQuestionTimeoutStore.getState().seenAt).toEqual({ form_1: 1_000 });

    now += 5 * MINUTE - 1;
    await tick();
    expect(cancelled).toEqual([]);
    expect(useQuestionTimeoutStore.getState().closed).toEqual({});

    now += 1;
    await tick();
    expect(cancelled).toEqual(['form_1']);
    // A timeout always carries a message, which lets the agent go on; Dismiss sends none.
    expect(messages).toEqual(['timeout:5']);
    expect(useQuestionTimeoutStore.getState().closed).toEqual({ 'msg_1:call_1': { reason: 'timeout', at: now } });
  });

  test('0 minutes never closes a form', async () => {
    const cancelled: string[] = [];
    let now = 0;
    const tick = createQuestionTimeoutRunner({
      now: () => now,
      timeoutMinutes: () => 0,
      inBackground: () => false,
      message: messageFor,
      pendingForms: () => [{ id: 'form_1', sessionId: 'ses_1' }],
      cancel: async (_sessionId, formId) => {
        cancelled.push(formId);
      },
    });
    await tick();
    now += 1_000 * MINUTE;
    await tick();
    expect(cancelled).toEqual([]);
  });

  test('a failed cancel leaves the question unmarked and is tried again on the next tick', async () => {
    let fail = true;
    const cancelled: string[] = [];
    const tick = createQuestionTimeoutRunner({
      now: () => 10 * MINUTE,
      timeoutMinutes: () => 1,
      inBackground: () => false,
      message: messageFor,
      pendingForms: () => [{ id: 'form_1', sessionId: 'ses_1', call: 'msg:call' }],
      cancel: async (_sessionId, formId) => {
        cancelled.push(formId);
        if (fail) throw new Error('offline');
      },
    });
    useQuestionTimeoutStore.setState({ seenAt: { form_1: 0 }, closed: {} });

    await tick();
    expect(useQuestionTimeoutStore.getState().closed).toEqual({});
    fail = false;
    await tick();
    expect(cancelled).toEqual(['form_1', 'form_1']);
    expect(useQuestionTimeoutStore.getState().closed).toEqual({ 'msg:call': { reason: 'timeout', at: 10 * MINUTE } });
  });

  test('a cancel still in flight is not started again by an overlapping tick', async () => {
    let release: () => void = () => undefined;
    const cancelled: string[] = [];
    const tick = createQuestionTimeoutRunner({
      now: () => 10 * MINUTE,
      timeoutMinutes: () => 1,
      inBackground: () => false,
      message: messageFor,
      pendingForms: () => [{ id: 'form_1', sessionId: 'ses_1' }],
      cancel: (_sessionId, formId) => {
        cancelled.push(formId);
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    useQuestionTimeoutStore.setState({ seenAt: { form_1: 0 }, closed: {} });

    const first = tick();
    await tick();
    release();
    await first;
    expect(cancelled).toEqual(['form_1']);
  });

  test('in the background mode an agent question closes as soon as it is seen, with the answer-later message, and other forms keep waiting', async () => {
    const closed: Array<[string, string]> = [];
    const reasons: string[] = [];
    const tick = createQuestionTimeoutRunner({
      now: () => 0,
      timeoutMinutes: () => 0,
      inBackground: () => true,
      message: messageFor,
      pendingForms: () => [{ id: 'question', sessionId: 'ses', call: 'msg:call' }, { id: 'mcp', sessionId: 'global' }],
      cancel: async (_sessionId, formId, message) => {
        closed.push([formId, message]);
      },
      onClosed: (_form, reason) => {
        reasons.push(reason);
      },
    });
    await tick();
    expect(closed).toEqual([['question', 'later:0']]);
    expect(reasons).toEqual(['later']);
    expect(useQuestionTimeoutStore.getState().closed['msg:call']?.reason).toBe('later');
  });

  // Oracle: the rule the runner implements, restated. Each form is first seen
  // at the tick it appears; after a tick at time `now` with `minutes` set, a
  // form is cancelled exactly when minutes > 0 and now >= seenAt + minutes,
  // and only its successful cancel marks its question timed out.
  test('generated schedules: closes exactly the forms past their deadline', async () => {
    // Positive control: the generated cases must include both outcomes.
    let closed = 0;
    let kept = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      reset();
      const next = random(seed);
      const minutes = Math.floor(next() * 4);
      const forms: Array<PendingQuestionForm & { appearsAt: number; fails: boolean }> = Array.from(
        { length: 1 + Math.floor(next() * 5) },
        (_, index) => ({
          id: `form_${index}`,
          sessionId: 'ses',
          call: next() < 0.7 ? `msg:call_${index}` : undefined,
          appearsAt: Math.floor(next() * 6) * MINUTE,
          fails: next() < 0.2,
        }),
      );
      let now = 0;
      const cancelled = new Set<string>();
      const tick = createQuestionTimeoutRunner({
        now: () => now,
        timeoutMinutes: () => minutes,
        inBackground: () => false,
        message: messageFor,
        pendingForms: () => forms.filter((form) => form.appearsAt <= now && !cancelled.has(form.id)),
        cancel: async (_sessionId, formId) => {
          if (forms.find((form) => form.id === formId)?.fails) throw new Error('offline');
          cancelled.add(formId);
        },
      });
      const ticks = Array.from({ length: 12 }, (_, index) => index * MINUTE);
      for (const at of ticks) {
        now = at;
        await tick();
      }

      const lastTick = ticks[ticks.length - 1];
      for (const form of forms) {
        // Seen at the first tick at or after it appeared.
        const seenAt = ticks.find((at) => at >= form.appearsAt);
        const due = minutes > 0 && seenAt !== undefined && lastTick >= seenAt + minutes * MINUTE;
        const context = `seed ${seed}, ${form.id}, minutes ${minutes}, appears ${form.appearsAt / MINUTE}, fails ${form.fails}`;
        expect(`${context}: ${useQuestionTimeoutStore.getState().seenAt[form.id]}`).toBe(`${context}: ${seenAt}`);
        expect(`${context}: ${cancelled.has(form.id)}`).toBe(`${context}: ${due && !form.fails}`);
        if (cancelled.has(form.id)) closed += 1;
        else kept += 1;
        if (form.call) {
          const marked = useQuestionTimeoutStore.getState().closed[form.call]?.reason === 'timeout';
          expect(`${context}: marked ${marked}`).toBe(`${context}: marked ${due && !form.fails}`);
        }
      }
    }
    expect(closed).toBeGreaterThan(50);
    expect(kept).toBeGreaterThan(50);
  });
});
