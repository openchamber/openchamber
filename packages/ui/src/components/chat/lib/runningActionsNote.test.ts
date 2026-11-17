import { describe, expect, test } from 'bun:test';

import { planRunningActionsNote, type RunningAction } from './runningActionsNote';

const dev: RunningAction = {
  executionId: 'exec-1',
  name: 'Dev stack',
  command: './dev-start.sh',
  directory: '/work/app',
  url: 'http://localhost:3000/',
};

describe('running actions note', () => {
  test('a session hears about a running action once', () => {
    const first = planRunningActionsNote('s-once', [dev]);
    expect(first.text).toContain('"Dev stack" (`./dev-start.sh`) in /work/app, open at http://localhost:3000/');
    first.commit('s-once');

    expect(planRunningActionsNote('s-once', [dev]).text).toBeNull();
    // Another session has not heard yet.
    expect(planRunningActionsNote('s-other', [dev]).text).not.toBeNull();
  });

  test('a note that was not delivered is offered again', () => {
    expect(planRunningActionsNote('s-failed', [dev]).text).not.toBeNull();
    expect(planRunningActionsNote('s-failed', [dev]).text).not.toBeNull();
  });

  test('nothing running and nothing told means no note', () => {
    expect(planRunningActionsNote('s-idle', []).text).toBeNull();
    expect(planRunningActionsNote(null, []).text).toBeNull();
  });

  test('a session told about a run hears when it is gone, once', () => {
    planRunningActionsNote('s-stop', [dev]).commit('s-stop');

    const stopped = planRunningActionsNote('s-stop', []);
    expect(stopped.text).toContain('no longer running: "Dev stack"');
    stopped.commit('s-stop');
    expect(planRunningActionsNote('s-stop', []).text).toBeNull();
  });

  test('a restarted action reads as one gone and one started', () => {
    planRunningActionsNote('s-restart', [dev]).commit('s-restart');
    const text = planRunningActionsNote('s-restart', [{ ...dev, executionId: 'exec-2' }]).text ?? '';
    expect(text).toContain('are running now');
    expect(text).toContain('no longer running');
  });

  test('a draft commits under the session its first message created', () => {
    const note = planRunningActionsNote(null, [dev]);
    expect(note.text).not.toBeNull();
    note.commit('s-new');
    expect(planRunningActionsNote('s-new', [dev]).text).toBeNull();
  });

  test('an action with no known command or address still names itself', () => {
    const text = planRunningActionsNote('s-bare', [{ ...dev, command: '', url: null }]).text ?? '';
    expect(text).toContain('- "Dev stack" in /work/app\n');
  });
});
