import { describe, expect, it } from 'vitest';

import { classifyTurnError, modelKey, pickRecoveryModel } from './recovery.js';
import { overdueBackgroundWork } from './background-work.js';

// Oracle: invariants of the walk, not a copy of its ordering. Walking the
// ladder by feeding each pick back as tried must never repeat a model, never
// return the model that failed, and must end.
const walk = ({ kind, current, catalog, defaultModel }) => {
  const tried = [];
  const picks = [];
  let from = current;
  for (let i = 0; i < 100; i += 1) {
    const next = pickRecoveryModel({ kind, current: from, catalog, defaultModel, tried });
    if (!next) return picks;
    // A leg error indicts the provider that just failed: the next pick leaves it.
    if (kind === 'leg') expect(next.providerID).not.toBe(from.providerID);
    picks.push(next);
    tried.push(modelKey(from), modelKey(next));
    from = next;
  }
  throw new Error('the recovery walk did not end');
};

const catalogs = [
  [],
  [{ providerID: 'a', id: 'm', modelID: 'm', enabled: true, variants: [{ id: 'low' }, { id: 'high' }] }],
  [
    { providerID: 'a', id: 'm', modelID: 'm', enabled: true, variants: [{ id: 'low' }, { id: 'high' }] },
    { providerID: 'b', id: 'm-b', modelID: 'm', enabled: true, variants: [{ id: 'max' }] },
    { providerID: 'c', id: 'm', modelID: 'm', enabled: false, variants: [] },
    { providerID: 'd', id: 'other', modelID: 'other', enabled: true, variants: [] },
  ],
];

describe('pickRecoveryModel', () => {
  for (const kind of ['refusal', 'leg']) {
    for (const [index, catalog] of catalogs.entries()) {
      for (const defaultModel of [null, { providerID: 'd', id: 'other' }, { providerID: 'a', id: 'm' }]) {
        it(`${kind}: walks catalog ${index} with default ${defaultModel ? modelKey(defaultModel) : 'none'} without repeats and ends`, () => {
          const current = { providerID: 'a', id: 'm', variant: 'high' };
          const picks = walk({ kind, current, catalog, defaultModel });
          const keys = [modelKey(current), ...picks.map(modelKey)];
          expect(new Set(keys).size).toBe(keys.length);
          for (const pick of picks) {
            expect(pick.providerID).not.toBe('c');
          }
        });
      }
    }
  }
});

describe('classifyTurnError', () => {
  it('sorts refusals, provider failures and the rest', () => {
    expect(classifyTurnError('provider.content-filter')).toBe('refusal');
    expect(classifyTurnError('provider.auth')).toBe('leg');
    expect(classifyTurnError('provider.transport')).toBe('ordinary');
    expect(classifyTurnError('')).toBe('ordinary');
  });
});

describe('overdueBackgroundWork', () => {
  const item = (extra) => ({ kind: 'subagent', id: 's', title: 's', startedAt: 0, timeoutMs: null, ...extra });
  it('is due exactly when a full window passed since the start or the last check, whichever is later', () => {
    for (const startedAt of [0, 50, 100]) {
      for (const lastCheckAt of [0, 75, 150]) {
        for (const now of [100, 160, 200, 260]) {
          const due = overdueBackgroundWork([item({ startedAt })], { now, checkMs: 100, lastCheckAt }).length === 1;
          expect(due).toBe(now - Math.max(startedAt, lastCheckAt) >= 100);
        }
      }
    }
  });

  it('never asks about work that has its own timeout', () => {
    expect(overdueBackgroundWork([item({ timeoutMs: 5 })], { now: 1e9, checkMs: 1 })).toEqual([]);
  });
});
