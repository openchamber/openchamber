import { describe, expect, test } from 'bun:test';
import { WALKTHROUGH_STAGE_ORDER, __testing } from './useWalkthroughStageProgress';

const { indexOfStage, nextIndex } = __testing;

// The pacing itself is a React effect, but the two decisions it rests on are
// plain functions and are where the mistakes would live.
describe('stage ordering', () => {
  test('maps every server stage onto a visible step', () => {
    expect(indexOfStage('collecting')).toBe(0);
    expect(indexOfStage('asking')).toBe(1);
    expect(indexOfStage('assembling')).toBe(2);
  });

  test('folds the schema fallback into the same wait', () => {
    // From out here it is still "waiting on the model"; the fallback is our
    // plumbing and must not show up as its own step or as going backwards.
    expect(indexOfStage('retrying')).toBe(indexOfStage('asking'));
  });

  test('treats an absent stage as not started', () => {
    expect(indexOfStage(null)).toBe(-1);
  });
});

describe('advancing', () => {
  test('moves one step at a time so none is skipped', () => {
    expect(nextIndex(-1, 2)).toBe(0);
    expect(nextIndex(0, 2)).toBe(1);
    expect(nextIndex(1, 2)).toBe(2);
  });

  test('stops at the target', () => {
    expect(nextIndex(2, 2)).toBe(2);
  });

  test('completion goes one past the last step so everything reads as done', () => {
    expect(nextIndex(2, WALKTHROUGH_STAGE_ORDER.length)).toBe(WALKTHROUGH_STAGE_ORDER.length);
  });
});
