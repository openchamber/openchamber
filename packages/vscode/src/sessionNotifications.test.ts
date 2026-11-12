import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionNotifier } from './sessionNotifications';

const setup = (options: { attended?: boolean; pick?: string } = {}) => {
  const shown: Array<{ message: string; actions: string[] }> = [];
  const opened: string[] = [];
  let clock = 1_000;
  const notify = createSessionNotifier({
    isChatAttended: () => options.attended ?? false,
    show: async (message, ...actions) => {
      shown.push({ message, actions });
      return options.pick;
    },
    openSession: (sessionId) => {
      opened.push(sessionId);
    },
    openSessionLabel: 'Open Session',
    now: () => clock,
  });
  return { notify, shown, opened, advance: (ms: number) => { clock += ms; } };
};

const finished = { title: 'Build is ready', body: 'Big Pickle completed the task', sessionId: 'ses_1', requireHidden: true };

describe('createSessionNotifier', () => {
  test('a finished turn shows a VS Code notification with an action that opens the session', async () => {
    const { notify, shown, opened } = setup({ pick: 'Open Session' });

    assert.equal(notify(finished), true);
    assert.deepEqual(shown, [{ message: 'Build is ready: Big Pickle completed the task', actions: ['Open Session'] }]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(opened, ['ses_1']);
  });

  test('dismissing the notification opens nothing', async () => {
    const { notify, opened } = setup();

    notify(finished);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(opened, []);
  });

  test('stays quiet while the chat is in view, unless the user asked to be notified while focused', () => {
    const quiet = setup({ attended: true });
    assert.equal(quiet.notify(finished), false);
    assert.equal(quiet.shown.length, 0);

    const always = setup({ attended: true });
    assert.equal(always.notify({ ...finished, requireHidden: false }), true);
    assert.equal(always.shown.length, 1);
  });

  test('every open chat reports the same event; it shows once', () => {
    const { notify, shown, advance } = setup();

    assert.equal(notify(finished), true);
    assert.equal(notify(finished), false);
    advance(10_001);
    assert.equal(notify(finished), true);
    assert.equal(shown.length, 2);
  });

  test('the settings test notification shows on every press, without an action', () => {
    const { notify, shown } = setup({ attended: true });
    const testNotification = { title: 'Test notification', body: 'This is a test notification from OpenChamber.' };

    assert.equal(notify(testNotification), true);
    assert.equal(notify(testNotification), true);
    assert.deepEqual(shown.map((entry) => entry.actions), [[], []]);
  });
});
