import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { prepareUserMessageResume } from './user-message-resume';

const session = (archived?: number, parentID?: string): Session => ({
  id: 'session-a', title: 'Archived session', directory: '/repo', projectID: 'project',
  parentID, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2, archived },
});

function fixture(initial = session(10)) {
  const restored: string[] = [];
  const state = { runtime: 'first', session: initial, restored, notices: 0, fail: false };
  const deps = {
    runtimeKey: () => state.runtime,
    session: (id: string) => id === 'session-a' ? state.session : undefined,
    restore: async (id: string, runtime: string) => {
      state.restored.push(`${runtime}/${id}`);
      return !state.fail;
    },
    reportFailure: async () => { state.notices += 1; },
  };
  return { state, resume: prepareUserMessageResume('session-a', 'first', deps) };
}

describe('user message archive restoration', () => {
  test('capture alone leaves archives intact; acceptance restores the captured session', async () => {
    const { state, resume } = fixture();
    expect(state.restored).toEqual([]);
    await resume();
    expect(state.restored).toEqual(['first/session-a']);
  });

  test('active sessions and subsessions are not restored', async () => {
    for (const initial of [session(), session(10, 'parent')]) {
      const { state, resume } = fixture(initial);
      await resume();
      expect(state.restored).toEqual([]);
    }
  });

  test('a runtime switch or a later archive supersedes the captured send', async () => {
    const runtime = fixture();
    runtime.state.runtime = 'second';
    await runtime.resume();
    expect(runtime.state.restored).toEqual([]);
    const archive = fixture();
    archive.state.session = session(20);
    await archive.resume();
    expect(archive.state.restored).toEqual([]);
    const restored = fixture();
    restored.state.session = session();
    await restored.resume();
    expect(restored.state.restored).toEqual([]);
  });

  test('restore failure is reported without failing the accepted message', async () => {
    const { state, resume } = fixture();
    state.fail = true;
    await resume();
    expect(state.notices).toBe(1);
  });
});
