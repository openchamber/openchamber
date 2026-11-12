import { describe, expect, test } from 'bun:test';
import { isSessionGoalMaxAutoTurns } from './sessionGoalTurnLimit';

describe('goal turn limit', () => {
  test('accepts whole numbers from 1 to 200 only', () => {
    expect([1, 20, 200].map(isSessionGoalMaxAutoTurns)).toEqual([true, true, true]);
    expect([0, -1, 201, 2.5, Number.NaN].map(isSessionGoalMaxAutoTurns)).toEqual([false, false, false, false, false]);
  });
});
