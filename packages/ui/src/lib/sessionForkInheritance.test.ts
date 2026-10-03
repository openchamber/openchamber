import { describe, expect, test } from 'bun:test';
import type { Metadata, Session } from '@/lib/opencode/model';
import { applyForkInheritance, withoutSourceOwnedLinks, type ForkInheritanceDeps } from './sessionForkInheritance';

const goal = (objectiveFile: boolean) => ({
  id: 'goal_1',
  objective: objectiveFile ? '' : 'Ship it',
  objectiveFile,
  status: 'paused',
  tokensUsed: 10,
  turnsUsed: 2,
});

const forkWith = (metadata: Metadata): Session => ({
  id: 'ses_fork',
  projectID: 'proj_1',
  directory: '/repo',
  title: 'Forked',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  metadata,
});

const harness = (fork: Session, overrides: Partial<ForkInheritanceDeps> = {}) => {
  const reads: string[] = [];
  const writes: Array<[string, string]> = [];
  const patches: Metadata[] = [];
  const deps: ForkInheritanceDeps = {
    readGoalId: async () => 'goal_1',
    readObjective: async (sessionId) => {
      reads.push(sessionId);
      return 'Objective from file';
    },
    writeObjective: async (sessionId, content) => {
      writes.push([sessionId, content]);
      return true;
    },
    patchMetadata: async (_sessionId, updater) => {
      patches.push(updater(fork.metadata ?? {}));
    },
    ...overrides,
  };
  return { deps, reads, writes, patches };
};

describe('withoutSourceOwnedLinks', () => {
  test('pauses an active goal so the fork does not pursue it in parallel', () => {
    const result = withoutSourceOwnedLinks({ openchamber: { goal: { ...goal(false), status: 'active' } } });
    expect(result).toEqual({ openchamber: { goal: { ...goal(false), status: 'paused', statusReason: 'paused in fork' } } });
  });

  test('keeps the goal and drops the source btw and review links', () => {
    const metadata: Metadata = {
      other: 1,
      openchamber: { goal: goal(false), btwSessionID: 'ses_btw', reviewSessionID: 'ses_review' },
    };
    expect(withoutSourceOwnedLinks(metadata)).toEqual({ other: 1, openchamber: { goal: goal(false) } });
  });

  test('drops the btw marker when the source is a btw thread', () => {
    const metadata: Metadata = {
      openchamber: { kind: 'btw', originalSessionID: 'ses_parent', btwBoundaryMessageID: 'msg_1' },
    };
    expect(withoutSourceOwnedLinks(metadata)).toEqual({});
  });

  test('keeps a review marker and returns the same object when nothing changes', () => {
    const metadata: Metadata = { openchamber: { kind: 'review', originalSessionID: 'ses_parent', goal: goal(false) } };
    expect(withoutSourceOwnedLinks(metadata)).toBe(metadata);
  });
});

describe('applyForkInheritance', () => {
  test('does nothing for a fork with an inline goal and no source links', async () => {
    const h = harness(forkWith({ openchamber: { goal: goal(false) } }));
    await applyForkInheritance('ses_source', forkWith({ openchamber: { goal: goal(false) } }), h.deps);
    expect(h.reads).toEqual([]);
    expect(h.patches).toEqual([]);
  });

  test('copies a file-backed objective to the fork', async () => {
    const fork = forkWith({ openchamber: { goal: goal(true) } });
    const h = harness(fork);
    await applyForkInheritance('ses_source', fork, h.deps);
    expect(h.reads).toEqual(['ses_source']);
    expect(h.writes).toEqual([['ses_fork', 'Objective from file']]);
    expect(h.patches).toEqual([]);
  });

  test('skips the copy when the fork got a new goal meanwhile', async () => {
    const fork = forkWith({ openchamber: { goal: goal(true) } });
    const h = harness(fork, { readGoalId: async () => 'goal_new' });
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      await applyForkInheritance('ses_source', fork, h.deps);
    } finally {
      console.warn = warn;
    }
    expect(h.writes).toEqual([]);
    expect(h.patches).toEqual([]);
  });

  test('inlines the objective when the file write fails', async () => {
    const fork = forkWith({ openchamber: { goal: goal(true), btwSessionID: 'ses_btw' } });
    const h = harness(fork, { writeObjective: async () => false });
    await applyForkInheritance('ses_source', fork, h.deps);
    expect(h.patches).toEqual([{
      openchamber: { goal: { ...goal(true), objective: 'Objective from file', objectiveFile: false } },
    }]);
  });

  test('a failed copy or patch never throws', async () => {
    const fork = forkWith({ openchamber: { goal: goal(true), btwSessionID: 'ses_btw' } });
    const h = harness(fork, {
      readObjective: async () => { throw new Error('offline'); },
      patchMetadata: async () => { throw new Error('offline'); },
    });
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      await applyForkInheritance('ses_source', fork, h.deps);
    } finally {
      console.warn = warn;
    }
    expect(h.writes).toEqual([]);
  });
});
