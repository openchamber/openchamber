import { describe, expect, test } from 'bun:test';
import { createUiBlockRepair } from './ui-block-repair.js';

const source = 'root = Stack([missing])';
const text = `Before\n\n\`\`\`openui-lang\n${source}\n\`\`\`\nTrailing answer still streaming`;
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function setup({ interrupted = true, deliver } = {}) {
  const calls = [];
  const submissions = [];
  let settle;
  const idle = new Promise((resolve) => { settle = resolve; });
  const client = {
    session: {
      interrupt: async () => { calls.push('interrupt'); return { interrupted }; },
      synthetic: async (input) => { calls.push(input); submissions.push(input); await deliver?.(input); },
    },
    experimental: { session: { wait: async () => { calls.push('wait'); await idle; } } },
  };
  const repair = createUiBlockRepair({ clientFor: () => client });
  const event = (type, data = {}) => repair.onEvent({ directory: '/project', payload: { type, data: { sessionID: 'ses_test', ...data } } });
  const start = (messageId = 'msg_test') => {
    repair.onEvent({ directory: 'global', payload: { type: 'session.execution.started', data: { sessionID: 'ses_test' } } });
    event('session.text.started', { assistantMessageID: messageId, ordinal: 0 });
  };
  const delta = (value = text, messageId = 'msg_test') => event('session.text.delta', { assistantMessageID: messageId, ordinal: 0, delta: value });
  start();
  return { repair, calls, submissions, settle, event, start, delta };
}

describe('event-owned UI block repair', () => {
  test.each(['input', 'disconnect'])('%s cancels a pending continuation', async (reason) => {
    const { repair, submissions, settle, event, delta } = setup();
    delta();
    if (reason === 'disconnect') repair.reset();
    else event('session.inbox.enqueued', { inboxID: 'msg_user' });
    settle();
    await tick();
    expect(submissions).toHaveLength(0);
  });

  test('EOF closure repairs even when execution succeeds before interruption', async () => {
    const { calls, delta, event, settle, repair } = setup({ interrupted: false });
    delta('```openui-lang\nroot = Stack([])\n```\n');
    expect(calls).toEqual([]);
    event('session.text.started', { assistantMessageID: 'msg_test', ordinal: 0 });
    const value = `\`\`\`openui-lang\n${source}\n\`\`\``;
    for (const character of value) delta(character);
    expect(calls).toEqual([]);
    event('session.text.ended', { assistantMessageID: 'msg_test', ordinal: 0, text: value });
    expect(calls).toEqual(['interrupt']);
    expect(event('session.execution.succeeded')).toBe(true);
    settle();
    await tick();
    expect(calls[2]).toMatchObject({ resume: true });
    repair.reset();
  });

  test('repair successors inherit the budget and external input starts a new task', async () => {
    const { calls, settle, event, start, delta } = setup();
    settle();
    for (let attempt = 0; attempt < 2; attempt++) {
      const messageId = attempt ? 'msg_second' : 'msg_test';
      delta(text, messageId);
      event('session.execution.interrupted', { reason: 'user' });
      await tick();
      event('session.inbox.enqueued', { inboxID: calls.at(-1).id });
      start(attempt ? 'msg_third' : 'msg_second');
    }
    delta(text, 'msg_third');
    expect(calls.filter((call) => call === 'interrupt')).toHaveLength(2);
    event('session.inbox.enqueued', { inboxID: 'msg_new_user' });
    start('msg_new');
    delta(text, 'msg_new');
    expect(calls.filter((call) => call === 'interrupt')).toHaveLength(3);
  });

  test.each([false, true])('successor error before admission response is retained; completed = %s', async (completed) => {
    let finishDelivery;
    let harness;
    harness = setup({ deliver: async (input) => {
      if (!finishDelivery) {
        harness.event('session.inbox.enqueued', { inboxID: input.id });
        harness.start('msg_successor');
        harness.delta(text, 'msg_successor');
        if (completed) harness.event('session.execution.succeeded');
        await new Promise((resolve) => { finishDelivery = resolve; });
      }
    } });
    harness.settle();
    harness.delta();
    harness.event('session.execution.interrupted', { reason: 'user' });
    await tick();
    expect(harness.calls.filter((call) => call === 'interrupt')).toHaveLength(2);
    finishDelivery();
    await tick();
    expect(harness.calls.filter((call) => call === 'interrupt')).toHaveLength(2);
    if (completed) expect(harness.submissions).toHaveLength(2);
    harness.repair.reset();
  });
});
