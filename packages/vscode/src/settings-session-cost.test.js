import { describe, expect, test } from 'bun:test';
import { dropUnorderedSessionCostChanges } from './settings-session-cost.ts';

const apply = (stored, changes) => {
  const next = { ...changes };
  dropUnorderedSessionCostChanges(stored, next);
  return { ...stored, ...next };
};

describe('session cost thresholds at the VS Code persistence boundary', () => {
  test('keeps the saved pair when a stale yellow edit lands above a red saved meanwhile', () => {
    const stored = { sessionCostWarnThreshold: 5, sessionCostCriticalThreshold: 10 };
    expect(apply(stored, { sessionCostWarnThreshold: 15 })).toEqual(stored);
  });

  test('checks a one-sided write against the default for the side never saved', () => {
    expect(apply({}, { sessionCostWarnThreshold: 25 })).toEqual({});
    expect(apply({}, { sessionCostCriticalThreshold: 4 })).toEqual({});
    expect(apply({}, { sessionCostWarnThreshold: 8 })).toEqual({ sessionCostWarnThreshold: 8 });
  });

  test('accepts a pair that moves both sides together and drops amounts that are not positive', () => {
    const stored = { sessionCostWarnThreshold: 5, sessionCostCriticalThreshold: 20 };
    expect(apply(stored, { sessionCostWarnThreshold: 30, sessionCostCriticalThreshold: 50 }))
      .toEqual({ sessionCostWarnThreshold: 30, sessionCostCriticalThreshold: 50 });
    expect(apply(stored, { sessionCostCriticalThreshold: 0, sessionCostAlertsEnabled: true }))
      .toEqual({ ...stored, sessionCostAlertsEnabled: true });
  });
});
