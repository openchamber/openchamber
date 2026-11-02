import { describe, expect, test } from 'bun:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createUiBlockRepair } from './ui-block-repair.js';

const source = 'root = Stack([missing])';
const text = `Before\n\n\`\`\`openui-lang\n${source}\n\`\`\`\nTrailing answer still streaming`;

function setup(delivery) {
  const calls = [];
  const idle = Promise.withResolvers();
  const client = {
    session: {
      interrupt: async () => { calls.push('interrupt'); },
      synthetic: async (input) => { calls.push(input); await delivery; },
    },
    experimental: { session: { wait: async () => { calls.push('wait'); await idle.promise; } } },
  };
  const repair = createUiBlockRepair({ clientFor: () => client });
  const event = (type, data = {}) => repair.onEvent({ directory: '/project', payload: { type, data: { sessionID: 'ses_test', ...data } } });
  const start = (messageId = 'msg_test') => {
    repair.onEvent({ directory: 'global', payload: { type: 'session.execution.started', data: { sessionID: 'ses_test' } } });
    event('session.text.started', { assistantMessageID: messageId, ordinal: 0 });
  };
  const delta = (value = text, messageId = 'msg_test') => event('session.text.delta', { assistantMessageID: messageId, ordinal: 0, delta: value });
  start();
  return { repair, calls, settle: idle.resolve, event, start, delta };
}

describe('event-owned UI block repair', () => {
  test.each(['input', 'disconnect'])('%s cancels a pending continuation', async (reason) => {
    const { repair, calls, settle, event, delta } = setup();
    delta();
    if (reason === 'disconnect') repair.reset();
    else event('session.inbox.enqueued', { inboxID: 'msg_user' });
    settle();
    await tick();
    expect(calls).not.toContainEqual(expect.objectContaining({ resume: true }));
  });

  test('EOF closure repairs even when execution succeeds before interruption', async () => {
    const { calls, delta, event, settle, repair } = setup();
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
    const delivery = Promise.withResolvers();
    const { repair, calls, settle, delta, event, start } = setup(delivery.promise);
    settle();
    delta();
    event('session.execution.interrupted', { reason: 'user' });
    await tick();
    event('session.inbox.enqueued', { inboxID: calls.at(-1).id });
    start('msg_successor');
    delta(text, 'msg_successor');
    expect(calls.filter((call) => call === 'interrupt')).toHaveLength(2);
    if (completed) event('session.execution.succeeded');
    delivery.resolve();
    await tick();
    if (!completed) {
      expect(calls.filter((call) => call.resume)).toHaveLength(1);
      event('session.execution.interrupted', { reason: 'user' });
      await tick();
    }
    expect(calls.filter((call) => call === 'interrupt')).toHaveLength(2);
    expect(calls.filter((call) => call.resume)).toHaveLength(2);
    repair.reset();
  });
});
