import { describe, expect, it, vi } from 'vitest';
import { applyForkInheritance, sourceOwnedLinksPatch } from './fork-inheritance.js';

const goal = (objectiveFile) => ({ id: 'goal_1', objective: objectiveFile ? '' : 'Ship it', objectiveFile, status: 'paused' });

const harness = (metadata, overrides = {}) => {
  const deps = {
    readObjective: vi.fn(async () => 'Objective from file'),
    writeObjective: vi.fn(async () => undefined),
    writeMetadata: vi.fn(async () => undefined),
    ...overrides,
  };
  const run = () => applyForkInheritance({ sourceSessionID: 'ses_source', fork: { id: 'ses_fork', metadata }, ...deps });
  return { deps, run };
};

describe('sourceOwnedLinksPatch', () => {
  it('pauses an active goal so the fork does not pursue it in parallel', () => {
    expect(sourceOwnedLinksPatch({ openchamber: { goal: { id: 'g', status: 'active' } } }))
      .toEqual({ goal: { status: 'paused', statusReason: 'paused in fork' } });
    expect(sourceOwnedLinksPatch({ openchamber: { goal: { id: 'g', status: 'complete' } } })).toBeNull();
  });

  it('removes the btw and review links but keeps the goal', () => {
    expect(sourceOwnedLinksPatch({ openchamber: { goal: goal(false), btwSessionID: 'b', reviewSessionID: 'r' } }))
      .toEqual({ btwSessionID: null, reviewSessionID: null });
  });

  it('removes the btw marker of a btw source, keeps a review marker', () => {
    expect(sourceOwnedLinksPatch({ openchamber: { kind: 'btw', originalSessionID: 'p', btwBoundaryMessageID: 'm' } }))
      .toEqual({ kind: null, originalSessionID: null, btwBoundaryMessageID: null });
    expect(sourceOwnedLinksPatch({ openchamber: { kind: 'review', originalSessionID: 'p' } })).toBeNull();
    expect(sourceOwnedLinksPatch(undefined)).toBeNull();
  });
});

describe('applyForkInheritance', () => {
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
