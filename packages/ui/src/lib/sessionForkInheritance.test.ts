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
  const permissions: Array<[string, Session['permissions']]> = [];
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
    setPermissions: async (sessionId, rules) => {
      permissions.push([sessionId, rules]);
    },
    readMessages: async () => [],
    isCurrent: () => true,
    ...overrides,
  };
  return { deps, reads, writes, patches, permissions };
};

describe('a fork of an agent\'s worker session', () => {
  test('is the user\'s own session: no link to the agent and the question tool back', async () => {
    const fork = { ...forkWith({ openchamber: { kind: 'operator-child', parentID: 'ses_operator' } }), permissions: [{ action: 'question', resource: '*', effect: 'deny' as const }] };
    const { deps, patches, permissions } = harness(fork);
    await applyForkInheritance('ses_worker', fork, deps);
    expect(permissions).toEqual([['ses_fork', []]]);
    expect(patches).toEqual([{}]);
  });
});

describe('withoutSourceOwnedLinks', () => {
  test('pauses an active goal so the fork does not pursue it in parallel', () => {
    const result = withoutSourceOwnedLinks({ openchamber: { goal: { ...goal(false), status: 'active' } } });
    expect(result).toEqual({ openchamber: { goal: { ...goal(false), status: 'paused', statusReason: 'paused in fork' } } });
  });

  test('keeps the goal and drops the source btw and review links and its lead mark', () => {
    const metadata: Metadata = {
      other: 1,
      openchamber: { goal: goal(false), btwSessionID: 'ses_btw', reviewSessionID: 'ses_review', lead: { at: 1, digest: { now: ['x'], updatedAt: 1 } } },
    };
    expect(withoutSourceOwnedLinks(metadata)).toEqual({ other: 1, openchamber: { goal: goal(false) } });
  });

  test('drops the btw marker when the source is a btw thread', () => {
    const metadata: Metadata = {
      openchamber: { kind: 'btw', originalSessionID: 'ses_parent', btwBoundaryMessageID: 'msg_1' },
    };
    expect(withoutSourceOwnedLinks(metadata)).toEqual({});
  });

  test('drops the scheduled-run marker, so the fork can go into In work', () => {
    expect(withoutSourceOwnedLinks({ other: 1, openchamber: { kind: 'scheduled' } })).toEqual({ other: 1 });
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

  test('remaps copied pins, drops pins beyond the fork, and keeps new fork pins', async () => {
    const fork = forkWith({ openchamber: { context_obligatory_messages: [
      { id: 'old', createdAt: 9, role: 'user', sessionID: 'ses_source' },
      { id: 'later', createdAt: 20, role: 'assistant', sessionID: 'ses_source' },
      { id: 'new', createdAt: 30, role: 'user', sessionID: 'ses_fork' },
    ], context_obligatory_last_compaction_message_id: 'summary' } });
    const h = harness(fork, { readMessages: async (id) => id === 'ses_source'
      ? [{ id: 'old', role: 'user', createdAt: 10 }, { id: 'later', role: 'assistant', createdAt: 20 }]
      : [{ id: 'copy', role: 'user', createdAt: 10 }] });
    await applyForkInheritance('ses_source', fork, h.deps);
    expect(h.patches).toEqual([{ openchamber: { context_obligatory_messages: [
      { id: 'copy', createdAt: 9, role: 'user', sessionID: 'ses_fork' },
      { id: 'new', createdAt: 30, role: 'user', sessionID: 'ses_fork' },
    ], context_obligatory_last_compaction_message_id: 'summary' } }]);
  });

  test('reads no transcripts when the fork inherited no pin', async () => {
    for (const pins of [[], [{ id: 'new', createdAt: 30, role: 'user', sessionID: 'ses_fork' }]]) {
      const reads: string[] = [];
      const fork = forkWith({ openchamber: { context_obligatory_messages: pins } });
      const h = harness(fork, { readMessages: async (id) => { reads.push(id); return []; } });
      await applyForkInheritance('ses_source', fork, h.deps);
      expect(reads).toEqual([]);
    }
  });

  test('keeps one pin when the user pinned the copy while the repair ran', async () => {
    const inherited = { id: 'old', createdAt: 10, role: 'user', sessionID: 'ses_source' };
    const fork = forkWith({ openchamber: { context_obligatory_messages: [inherited] } });
    const userPin = { id: 'copy', createdAt: 10, role: 'user', sessionID: 'ses_fork' };
    const h = harness(fork, {
      readMessages: async (id) => id === 'ses_source'
        ? [{ id: 'old', role: 'user', createdAt: 10 }]
        : [{ id: 'copy', role: 'user', createdAt: 10 }],
      patchMetadata: async (_id, updater) => {
        h.patches.push(updater({ openchamber: { context_obligatory_messages: [inherited, userPin] } }));
      },
    });
    await applyForkInheritance('ses_source', fork, h.deps);
    expect(h.patches).toEqual([{ openchamber: { context_obligatory_messages: [userPin] } }]);
  });

  test('does not guess on duplicate timestamps or discard pins when messages fail to load', async () => {
    const metadata: Metadata = { openchamber: { context_obligatory_messages: [
      { id: 'old', createdAt: 10, role: 'user', sessionID: 'ses_source' },
    ] } };
    const fork = forkWith(metadata);
    const duplicate = harness(fork, { readMessages: async (id) => id === 'ses_source'
      ? [{ id: 'old', role: 'user', createdAt: 10 }, { id: 'other', role: 'user', createdAt: 10 }]
      : [{ id: 'copy', role: 'user', createdAt: 10 }] });
    await applyForkInheritance('ses_source', fork, duplicate.deps);
    expect(duplicate.patches).toEqual([]);
    const failed = harness(fork, { readMessages: async () => { throw new Error('offline'); } });
    await applyForkInheritance('ses_source', fork, failed.deps);
    expect(failed.patches).toEqual([]);
  });

  test('cleans source links independently of conditional pin repair', async () => {
    const fork = forkWith({ openchamber: {
      btwSessionID: 'ses_btw',
      context_obligatory_messages: [{ id: 'old', createdAt: 10, role: 'user', sessionID: 'ses_source' }],
    } });
    const calls: Array<string | undefined> = [];
    const h = harness(fork, {
      readMessages: async (id) => id === 'ses_source'
        ? [{ id: 'old', role: 'user', createdAt: 10 }]
        : [{ id: 'copy', role: 'user', createdAt: 10 }],
      patchMetadata: async (_id, _updater, condition) => { calls.push(condition); },
    });
    await applyForkInheritance('ses_source', fork, h.deps);
    expect(calls).toEqual([undefined, 'required']);
  });

  test('writes no pins after the runtime changes during a message read', async () => {
    const fork = forkWith({ openchamber: {
      context_obligatory_messages: [{ id: 'old', createdAt: 10, role: 'user' }],
    } });
    let current = true;
    const h = harness(fork, {
      isCurrent: () => current,
      readMessages: async (id) => {
        current = false;
        return id === 'ses_source' ? [{ id: 'old', role: 'user', createdAt: 10 }] : [{ id: 'copy', role: 'user', createdAt: 10 }];
      },
    });
    await applyForkInheritance('ses_source', fork, h.deps);
    expect(h.patches).toEqual([]);
  });

  test('repairs pins even when source link cleanup fails', async () => {
    const fork = forkWith({ openchamber: {
      btwSessionID: 'ses_btw',
      context_obligatory_messages: [{ id: 'old', createdAt: 10, role: 'user' }],
    } });
    const calls: Array<string | undefined> = [];
    const h = harness(fork, {
      readMessages: async (id) => id === 'ses_source'
        ? [{ id: 'old', role: 'user', createdAt: 10 }]
        : [{ id: 'copy', role: 'user', createdAt: 10 }],
      patchMetadata: async (_id, _updater, condition) => {
        calls.push(condition);
        if (!condition) throw new Error('offline');
      },
    });
    await applyForkInheritance('ses_source', fork, h.deps);
    expect(calls).toEqual([undefined, 'required']);
  });
});
