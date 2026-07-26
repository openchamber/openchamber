import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createClaudeCodeTranslator } from './index.js';
import {
  configureSessionBindings,
  getSessionBinding,
  resetSessionBindings,
} from '../../session-bindings.js';
import { resetHarnessTurnSnapshots } from '../../turn-snapshot.js';

function createControlledStream() {
  const queue = [];
  let done = false;
  let failure;
  let waiter;

  const settle = () => {
    if (!waiter) return;
    const current = waiter;
    waiter = undefined;
    if (queue.length > 0) {
      current.resolve({ done: false, value: queue.shift() });
      return;
    }
    if (failure) {
      current.reject(failure);
      return;
    }
    if (done) {
      current.resolve({ done: true, value: undefined });
    } else {
      waiter = current;
    }
  };

  return {
    stream: {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        if (queue.length > 0) {
          return Promise.resolve({ done: false, value: queue.shift() });
        }
        if (failure) {
          return Promise.reject(failure);
        }
        if (done) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve, reject) => {
          waiter = { resolve, reject };
        });
      },
      return() {
        done = true;
        settle();
        return Promise.resolve({ done: true, value: undefined });
      },
    },
    push(value) {
      queue.push(value);
      settle();
    },
    end() {
      done = true;
      settle();
    },
    fail(error) {
      failure = error;
      settle();
    },
  };
}

function createHarness(handle) {
  const events = [];
  const startQuery = mock(async () => handle);
  const translator = createClaudeCodeTranslator({
    detect: mock(async () => ({ status: 'ready' })),
    startQuery,
    getBroadcast: () => (payload) => events.push(payload),
  });
  return { events, startQuery, translator };
}

function createHandle(controller, options = {}) {
  return {
    stream: controller.stream,
    interrupt: mock(options.interrupt || (async () => {})),
    close: mock(options.close || (() => controller.end())),
  };
}

function basePrompt(sessionId = 'ses_test') {
  return {
    sessionId,
    directory: '/project',
    text: 'hello',
    target: { harnessId: 'claude-code', modelRef: 'sonnet' },
    messageId: `msg_user_${sessionId}`,
    assistantMessageId: `msg_assistant_${sessionId}`,
  };
}

function eventTypes(events) {
  return events.map((event) => event.type);
}

function idleEvents(events, sessionId) {
  return events.filter((event) => (
    event.type === 'session.status'
    && event.properties?.sessionID === sessionId
    && event.properties?.status?.type === 'idle'
  ));
}

async function waitFor(condition) {
  const deadline = Date.now() + 250;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(condition()).toBe(true);
}

beforeEach(() => {
  configureSessionBindings({ persist: false, load: true });
  resetSessionBindings();
  resetHarnessTurnSnapshots();
});

afterEach(() => {
  resetSessionBindings();
  resetHarnessTurnSnapshots();
});

describe('createClaudeCodeTranslator', () => {
  it('rejects a second prompt while a turn is active', async () => {
    const controller = createControlledStream();
    const handle = createHandle(controller);
    const { startQuery, translator } = createHarness(handle);

    await translator.prompt(basePrompt('ses_active'));

    await expect(translator.prompt(basePrompt('ses_active'))).rejects.toMatchObject({
      code: 'TURN_IN_PROGRESS',
      statusCode: 409,
    });
    expect(startQuery).toHaveBeenCalledTimes(1);

    controller.end();
    await waitFor(() => !translator._activeTurns.has('ses_active'));
  });

  it('abort during an active turn emits idle and MessageAbortedError', async () => {
    const controller = createControlledStream();
    const handle = createHandle(controller);
    const { events, translator } = createHarness(handle);

    await translator.prompt(basePrompt('ses_abort'));
    await expect(translator.abort({ sessionId: 'ses_abort' })).resolves.toMatchObject({
      ok: true,
      aborted: true,
    });

    expect(handle.interrupt).toHaveBeenCalledTimes(1);
    expect(handle.close).toHaveBeenCalled();
    expect(translator._activeTurns.has('ses_abort')).toBe(false);
    expect(idleEvents(events, 'ses_abort')).toHaveLength(1);
    expect(events.some((event) => (
      event.type === 'message.updated'
      && event.properties?.info?.error?.name === 'MessageAbortedError'
    ))).toBe(true);
  });

  it('does not emit session.error when an aborting stream fails', async () => {
    const controller = createControlledStream();
    const handle = createHandle(controller, {
      close: () => controller.fail(new Error('stream closed during abort')),
    });
    const { events, translator } = createHarness(handle);

    await translator.prompt(basePrompt('ses_abort_error'));
    await translator.abort({ sessionId: 'ses_abort_error' });
    await waitFor(() => handle.close.mock.calls.length >= 2);

    expect(eventTypes(events)).not.toContain('session.error');
    expect(getSessionBinding('ses_abort_error')?.lastError).toBeUndefined();
    expect(events.some((event) => (
      event.type === 'message.updated'
      && event.properties?.info?.error?.name === 'MessageAbortedError'
    ))).toBe(true);
  });

  it('emits idle from finally when the stream ends without a result', async () => {
    const controller = createControlledStream();
    const handle = createHandle(controller);
    const { events, translator } = createHarness(handle);

    await translator.prompt(basePrompt('ses_no_result'));
    controller.end();
    await waitFor(() => !translator._activeTurns.has('ses_no_result'));

    expect(idleEvents(events, 'ses_no_result')).toHaveLength(1);
    expect(eventTypes(events)).not.toContain('session.error');
  });
});
