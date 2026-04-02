import { describe, it, expect } from 'bun:test';
import { resolveFallbackTaskSessionId } from '../resolveFallbackTaskSessionId';

const busyStatus = { type: 'busy' };
const retryStatus = { type: 'retry', attempt: 1, message: '', next: Date.now() + 5000 };

const makeSession = (overrides) => ({
  slug: overrides.id,
  projectID: 'proj',
  directory: '/test',
  title: overrides.title ?? `Session ${overrides.id}`,
  version: '1',
  time: {
    created: overrides.time?.created ?? Date.now(),
    updated: overrides.time?.updated ?? Date.now(),
  },
  ...overrides,
});

describe('resolveFallbackTaskSessionId', () => {
  const parentSessionId = 'parent-session-1';
  const taskStartTime = 1000000;

  it('returns undefined when not a task tool', () => {
    const result = resolveFallbackTaskSessionId({
      isTaskTool: false,
      parentSessionId,
      taskStartTime,
      sessions: [],
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when task is finalized', () => {
    const result = resolveFallbackTaskSessionId({
      isTaskTool: true,
      parentSessionId,
      taskStartTime,
      sessions: [],
      isTaskFinalized: true,
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when parentSessionId is missing', () => {
    const result = resolveFallbackTaskSessionId({
      isTaskTool: true,
      parentSessionId: undefined,
      taskStartTime,
      sessions: [],
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when no sessions exist', () => {
    const result = resolveFallbackTaskSessionId({
      isTaskTool: true,
      parentSessionId,
      taskStartTime,
      sessions: [],
    });
    expect(result).toBeUndefined();
  });

  it('returns the child session id when exactly one child matches parent and time', () => {
    const child = makeSession({
      id: 'child-1',
      parentID: parentSessionId,
      time: { created: taskStartTime + 100, updated: taskStartTime + 100 },
    });

    const result = resolveFallbackTaskSessionId({
      isTaskTool: true,
      parentSessionId,
      taskStartTime,
      sessions: [child],
    });
    expect(result).toBe('child-1');
  });

  it('returns undefined when child was created before task start', () => {
    const child = makeSession({
      id: 'child-1',
      parentID: parentSessionId,
      time: { created: taskStartTime - 1, updated: taskStartTime - 1 },
    });

    const result = resolveFallbackTaskSessionId({
      isTaskTool: true,
      parentSessionId,
      taskStartTime,
      sessions: [child],
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when child was created too long after task start', () => {
    const child = makeSession({
      id: 'child-1',
      parentID: parentSessionId,
      time: { created: taskStartTime + 5000, updated: taskStartTime + 5000 },
    });

    const result = resolveFallbackTaskSessionId({
      isTaskTool: true,
      parentSessionId,
      taskStartTime,
      sessions: [child],
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when multiple children match and are ambiguous', () => {
    const child1 = makeSession({
      id: 'child-1',
      parentID: parentSessionId,
      time: { created: taskStartTime + 100, updated: taskStartTime + 100 },
    });
    const child2 = makeSession({
      id: 'child-2',
      parentID: parentSessionId,
      time: { created: taskStartTime + 200, updated: taskStartTime + 200 },
    });

    const result = resolveFallbackTaskSessionId({
      isTaskTool: true,
      parentSessionId,
      taskStartTime,
      sessions: [child1, child2],
    });
    expect(result).toBeUndefined();
  });

  it('returns the busy child when multiple children match but only one is busy', () => {
    const child1 = makeSession({
      id: 'child-1',
      parentID: parentSessionId,
      time: { created: taskStartTime + 100, updated: taskStartTime + 100 },
    });
    const child2 = makeSession({
      id: 'child-2',
      parentID: parentSessionId,
      time: { created: taskStartTime + 200, updated: taskStartTime + 200 },
    });

    const result = resolveFallbackTaskSessionId({
      isTaskTool: true,
      parentSessionId,
      taskStartTime,
      sessions: [child1, child2],
      sessionStatusMap: {
        'child-2': busyStatus,
      },
    });
    expect(result).toBe('child-2');
  });

  it('returns undefined when multiple children are both busy (ambiguous)', () => {
    const child1 = makeSession({
      id: 'child-1',
      parentID: parentSessionId,
      time: { created: taskStartTime + 100, updated: taskStartTime + 100 },
    });
    const child2 = makeSession({
      id: 'child-2',
      parentID: parentSessionId,
      time: { created: taskStartTime + 200, updated: taskStartTime + 200 },
    });

    const result = resolveFallbackTaskSessionId({
      isTaskTool: true,
      parentSessionId,
      taskStartTime,
      sessions: [child1, child2],
      sessionStatusMap: {
        'child-1': busyStatus,
        'child-2': busyStatus,
      },
    });
    expect(result).toBeUndefined();
  });

  it('ignores sessions with different parentID', () => {
    const child = makeSession({
      id: 'child-1',
      parentID: 'other-parent',
      time: { created: taskStartTime + 100, updated: taskStartTime + 100 },
    });

    const result = resolveFallbackTaskSessionId({
      isTaskTool: true,
      parentSessionId,
      taskStartTime,
      sessions: [child],
    });
    expect(result).toBeUndefined();
  });

  it('ignores sessions without parentID', () => {
    const child = makeSession({
      id: 'child-1',
      time: { created: taskStartTime + 100, updated: taskStartTime + 100 },
    });

    const result = resolveFallbackTaskSessionId({
      isTaskTool: true,
      parentSessionId,
      taskStartTime,
      sessions: [child],
    });
    expect(result).toBeUndefined();
  });

  it('prefers exactly one live candidate (retry status) over ambiguous total', () => {
    const child1 = makeSession({
      id: 'child-1',
      parentID: parentSessionId,
      time: { created: taskStartTime + 100, updated: taskStartTime + 100 },
    });
    const child2 = makeSession({
      id: 'child-2',
      parentID: parentSessionId,
      time: { created: taskStartTime + 200, updated: taskStartTime + 200 },
    });

    const result = resolveFallbackTaskSessionId({
      isTaskTool: true,
      parentSessionId,
      taskStartTime,
      sessions: [child1, child2],
      sessionStatusMap: {
        'child-1': retryStatus,
      },
    });
    expect(result).toBe('child-1');
  });

  it('returns undefined when taskStartTime is undefined', () => {
    const child = makeSession({
      id: 'child-1',
      parentID: parentSessionId,
      time: { created: 100, updated: 100 },
    });

    const result = resolveFallbackTaskSessionId({
      isTaskTool: true,
      parentSessionId,
      taskStartTime: undefined,
      sessions: [child],
    });
    expect(result).toBeUndefined();
  });
});
