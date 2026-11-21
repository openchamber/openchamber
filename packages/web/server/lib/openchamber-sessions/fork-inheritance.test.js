import { describe, expect, it, vi } from 'vitest';
import { ClientError } from '@opencode/client';
import { applyForkInheritance, inheritedFromParentPatch, listForkMessages, sourceOwnedLinksPatch } from './fork-inheritance.js';

describe('listForkMessages', () => {
  it('reads the fork transcript after a temporary OpenCode outage', async () => {
    const list = vi.fn()
      .mockRejectedValueOnce(new ClientError('UnexpectedStatus', { detail: '503' }))
      .mockResolvedValueOnce({ data: [{ id: 'copy', type: 'user', time: { created: 10 } }] });
    await expect(listForkMessages({ message: { list } }, 'ses_fork'))
      .resolves.toEqual([{ id: 'copy', role: 'user', createdAt: 10 }]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('surfaces a permanent message read failure without retrying', async () => {
    const error = new ClientError('MalformedResponse');
    const list = vi.fn().mockRejectedValue(error);
    await expect(listForkMessages({ message: { list } }, 'ses_fork')).rejects.toBe(error);
    expect(list).toHaveBeenCalledTimes(1);
  });
});

const goal = (objectiveFile) => ({ id: 'goal_1', objective: objectiveFile ? '' : 'Ship it', objectiveFile, status: 'paused' });

const harness = (metadata, overrides = {}) => {
  const deps = {
    readObjective: vi.fn(async () => 'Objective from file'),
    writeObjective: vi.fn(async () => undefined),
    writeMetadata: vi.fn(async () => undefined),
    readMessages: vi.fn(async () => []),
    updatePins: vi.fn(async () => undefined),
    ...overrides,
  };
  const run = () => applyForkInheritance({ sourceSessionID: 'ses_source', fork: { id: 'ses_fork', metadata }, ...deps });
  return { deps, run };
};

describe('inheritedFromParentPatch', () => {
  it('clears from a new child everything that still equals its parent, and keeps what the child got of its own', () => {
    const parent = { openchamber: { lead: { at: 1, digest: { now: ['x'] } }, work: { state: 'open' }, goal: { id: 'g', status: 'active' }, linked_issues: [{ id: 'a#1' }] } };
    const decide = inheritedFromParentPatch(parent);
    expect(decide({ openchamber: { ...parent.openchamber, kind: 'btw', originalSessionID: 'p' }, other: { kept: true } }))
      .toEqual({ openchamber: { lead: null, work: null, goal: null, linked_issues: null } });
    expect(decide({ openchamber: { kind: 'btw', work: { state: 'done' } } })).toBeNull();
  });

  it('drops a copied lead mark even after the parent rewrote its digest, and keeps a link the child added of its own', () => {
    const parent = { openchamber: { lead: { at: 1, digest: { now: ['newer'] } }, linked_issues: [{ id: 'a#1' }] } };
    expect(inheritedFromParentPatch(parent)({ openchamber: { lead: { at: 1, digest: { now: ['older'] } }, linked_issues: [{ id: 'a#1' }, { id: 'a#2' }] } }))
      .toEqual({ openchamber: { lead: null, linked_issues: [{ id: 'a#2' }] } });
  });
});

describe('sourceOwnedLinksPatch', () => {
  it('pauses an active goal so the fork does not pursue it in parallel', () => {
    expect(sourceOwnedLinksPatch({ openchamber: { goal: { id: 'g', status: 'active' } } }))
      .toEqual({ goal: { status: 'paused', statusReason: 'paused in fork' } });
    expect(sourceOwnedLinksPatch({ openchamber: { goal: { id: 'g', status: 'complete' } } })).toBeNull();
  });

  it('removes the btw and review links but keeps the goal', () => {
    expect(sourceOwnedLinksPatch({ openchamber: { goal: goal(false), btwSessionID: 'b', reviewSessionID: 'r', lead: { at: 1, digest: { now: ['x'] } } } }))
      .toEqual({ btwSessionID: null, reviewSessionID: null, lead: null });
  });

  it('removes the btw marker of a btw source, keeps a review marker', () => {
    expect(sourceOwnedLinksPatch({ openchamber: { kind: 'btw', originalSessionID: 'p', btwBoundaryMessageID: 'm' } }))
      .toEqual({ kind: null, originalSessionID: null, btwBoundaryMessageID: null });
    expect(sourceOwnedLinksPatch({ openchamber: { kind: 'review', originalSessionID: 'p' } })).toBeNull();
    // A fork of a scheduled run is the user's own work again.
    expect(sourceOwnedLinksPatch({ openchamber: { kind: 'scheduled' } })).toEqual({ kind: null });
    expect(sourceOwnedLinksPatch(undefined)).toBeNull();
  });
});

describe('a fork of an agent\'s worker session', () => {
  it('drops the link to the agent and gives the question and secret tools back', async () => {
    const writes = [];
    const permissions = [];
    await applyForkInheritance({
      sourceSessionID: 'ses_worker',
      fork: { id: 'ses_fork', metadata: { openchamber: { kind: 'operator-child', parentID: 'ses_operator' } }, permissions: [{ action: 'bash', resource: '*', effect: 'ask' }, { action: 'question', resource: '*', effect: 'deny' }, { action: 'openchamber_secret', resource: '*', effect: 'deny' }] },
      readObjective: async () => null,
      writeObjective: async () => {},
      writeMetadata: async (id, patch) => { writes.push([id, patch]); },
      readMessages: async () => [],
      updatePins: async () => {},
      writePermissions: async (id, rules) => { permissions.push([id, rules]); },
    });
    expect(writes).toEqual([['ses_fork', { openchamber: { kind: null, parentID: null } }]]);
    expect(permissions).toEqual([['ses_fork', [{ action: 'bash', resource: '*', effect: 'ask' }]]]);
  });
});

describe('applyForkInheritance', () => {
  it('repairs inherited pins in the current metadata while preserving a new pin', async () => {
    const inherited = { id: 'old', createdAt: 9, role: 'user', sessionID: 'ses_source' };
    const later = { id: 'later', createdAt: 20, role: 'assistant', sessionID: 'ses_source' };
    const added = { id: 'new', createdAt: 30, role: 'user', sessionID: 'ses_fork' };
    let current = { openchamber: { context_obligatory_messages: [inherited, later, added], context_obligatory_last_compaction_message_id: 'old-summary' } };
    const h = harness({ openchamber: { context_obligatory_messages: [inherited, later] } }, {
      readMessages: async (id) => id === 'ses_source'
        ? [{ id: 'old', role: 'user', createdAt: 10 }, { id: 'later', role: 'assistant', createdAt: 20 }]
        : [{ id: 'copy', role: 'user', createdAt: 10 }],
      updatePins: async (_id, decide) => { current = decide(current); },
    });
    await h.run();
    expect(current).toEqual({ openchamber: {
      context_obligatory_messages: [{ ...inherited, id: 'copy', sessionID: 'ses_fork' }, added],
    } });
  });

  it('reads no transcripts when the fork inherited no pin', async () => {
    for (const pins of [[], [{ id: 'new', createdAt: 30, role: 'user', sessionID: 'ses_fork' }]]) {
      const h = harness({ openchamber: { context_obligatory_messages: pins } });
      await h.run();
      expect(h.deps.readMessages).not.toHaveBeenCalled();
    }
  });

  it('keeps one pin when the copy was pinned while the repair ran', async () => {
    const inherited = { id: 'old', createdAt: 10, role: 'user', sessionID: 'ses_source' };
    const userPin = { id: 'copy', createdAt: 10, role: 'user', sessionID: 'ses_fork' };
    let current = { openchamber: { context_obligatory_messages: [inherited, userPin] } };
    const h = harness({ openchamber: { context_obligatory_messages: [inherited] } }, {
      readMessages: async (id) => id === 'ses_source'
        ? [{ id: 'old', role: 'user', createdAt: 10 }]
        : [{ id: 'copy', role: 'user', createdAt: 10 }],
      updatePins: async (_id, decide) => { current = decide(current); },
    });
    await h.run();
    expect(current).toEqual({ openchamber: { context_obligatory_messages: [userPin] } });
  });

  it('keeps inherited pins if reads fail or timestamp matches are ambiguous', async () => {
    const metadata = { openchamber: { context_obligatory_messages: [{ id: 'old', createdAt: 10, role: 'user', sessionID: 'ses_source' }] } };
    const updatePins = vi.fn();
    const h = harness(metadata, {
      updatePins,
      readMessages: async (id) => id === 'ses_source'
        ? [{ id: 'old', role: 'user', createdAt: 10 }, { id: 'other', role: 'user', createdAt: 10 }]
        : [{ id: 'copy', role: 'user', createdAt: 10 }],
    });
    await h.run();
    expect(updatePins).not.toHaveBeenCalled();
  });

  it('does nothing for an inline goal without source links', async () => {
    const h = harness({ openchamber: { goal: goal(false) } });
    await h.run();
    expect(h.deps.readObjective).not.toHaveBeenCalled();
    expect(h.deps.writeMetadata).not.toHaveBeenCalled();
  });

  it('copies a file-backed objective and strips source links', async () => {
    const h = harness({ openchamber: { goal: goal(true), btwSessionID: 'b' } });
    await h.run();
    expect(h.deps.readObjective).toHaveBeenCalledWith('ses_source');
    expect(h.deps.writeObjective).toHaveBeenCalledWith('ses_fork', 'Objective from file');
    expect(h.deps.writeMetadata).toHaveBeenCalledWith('ses_fork', { openchamber: { btwSessionID: null } });
  });

  it('inlines the objective when the file copy fails', async () => {
    const h = harness({ openchamber: { goal: goal(true) } }, {
      writeObjective: vi.fn(async () => { throw new Error('disk full'); }),
    });
    await h.run();
    expect(h.deps.writeMetadata).toHaveBeenCalledWith('ses_fork', {
      openchamber: { goal: { objective: 'Objective from file', objectiveFile: false } },
    });
  });

  it('swallows a metadata write failure', async () => {
    const h = harness({ openchamber: { reviewSessionID: 'r' } }, {
      writeMetadata: vi.fn(async () => { throw new Error('offline'); }),
    });
    await expect(h.run()).resolves.toBeUndefined();
  });
});
