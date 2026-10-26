import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import type { ToolPart } from '@/lib/opencode/model';
import { sessionEvents } from './sessionEvents';

type Hint = { directory: string; paths?: string[] };

const toolPart = (id: string, tool: string, status: 'running' | 'completed'): ToolPart => ({
  id,
  sessionID: 'ses',
  messageID: 'msg',
  type: 'tool',
  callID: id,
  tool,
  state: status === 'running'
    ? { status, input: {}, time: { start: 1 } }
    : { status, input: {}, output: '', time: { start: 1, end: 2 } },
});

const finishTool = (directory: string, id: string, tool = 'write') => {
  sessionEvents.requestGitRefreshForToolTransition(directory, toolPart(id, tool, 'running'), toolPart(id, tool, 'completed'));
};

describe('sessionEvents Git refresh hints', () => {
  let hints: Hint[];
  let unsubscribe: () => void;

  beforeEach(() => {
    jest.useFakeTimers();
    hints = [];
    unsubscribe = sessionEvents.onGitRefreshHint((hint) => hints.push(hint));
  });

  afterEach(() => {
    unsubscribe();
    sessionEvents.cancelPendingGitRefreshes();
    jest.useRealTimers();
  });

  test('a burst of tool completions in one directory refreshes it once, after the window', () => {
    for (let index = 0; index < 6; index += 1) finishTool('/repo', `prt_${index}`);
    expect(hints).toEqual([]);

    jest.advanceTimersByTime(249);
    expect(hints).toEqual([]);

    jest.advanceTimersByTime(1);
    expect(hints).toEqual([{ directory: '/repo' }]);

    // The next burst opens a new window.
    finishTool('/repo', 'prt_late');
    jest.advanceTimersByTime(250);
    expect(hints).toEqual([{ directory: '/repo' }, { directory: '/repo' }]);
  });

  test('directories refresh independently', () => {
    finishTool('/repo-a', 'prt_a');
    finishTool('/repo-b', 'prt_b');
    finishTool('/repo-a', 'prt_a2');
    jest.advanceTimersByTime(250);
    expect(hints).toEqual([{ directory: '/repo-a' }, { directory: '/repo-b' }]);
  });

  test('read-only tools and repeated final states start no refresh', () => {
    finishTool('/repo', 'prt_read', 'read');
    sessionEvents.requestGitRefreshForToolTransition('/repo', toolPart('prt_done', 'write', 'completed'), toolPart('prt_done', 'write', 'completed'));
    jest.advanceTimersByTime(250);
    expect(hints).toEqual([]);
  });

  test('a direct refresh is delivered at once with its paths', () => {
    finishTool('/repo', 'prt_tool');
    sessionEvents.requestGitRefresh({ directory: '/repo', paths: ['src/a.ts'] });
    expect(hints).toEqual([{ directory: '/repo', paths: ['src/a.ts'] }]);

    jest.advanceTimersByTime(250);
    expect(hints).toEqual([{ directory: '/repo', paths: ['src/a.ts'] }, { directory: '/repo' }]);
  });

  test('a runtime switch drops refreshes still waiting out their window', () => {
    finishTool('/repo', 'prt_tool');
    sessionEvents.cancelPendingGitRefreshes();
    jest.advanceTimersByTime(250);
    expect(hints).toEqual([]);

    // Coalescing keeps working for the new runtime.
    finishTool('/repo', 'prt_next');
    jest.advanceTimersByTime(250);
    expect(hints).toEqual([{ directory: '/repo' }]);
  });
});
