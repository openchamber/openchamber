import { describe, expect, test } from 'bun:test';
import type { TurnGroupingContext } from '../lib/turns/types';
import { areRelevantTurnGroupingContextsEqual } from './renderCompare';

const finalAnswerContext: TurnGroupingContext = {
  turnId: 'turn',
  isFirstAssistantInTurn: false,
  isLastAssistantInTurn: true,
  isLatestTurn: true,
  isWorking: false,
  hasTools: false,
  hasReasoning: false,
  hasEarlierAssistantText: false,
};

describe('final answer divider context', () => {
  test('updates the final answer when earlier visible text appears or disappears', () => {
    const withEarlierText = { ...finalAnswerContext, hasEarlierAssistantText: true };
    expect(areRelevantTurnGroupingContextsEqual(finalAnswerContext, withEarlierText, 'answer', false)).toBe(false);
    expect(areRelevantTurnGroupingContextsEqual(withEarlierText, finalAnswerContext, 'answer', false)).toBe(false);
  });

  test('preserves equivalent rebuilt context', () => {
    expect(areRelevantTurnGroupingContextsEqual(finalAnswerContext, { ...finalAnswerContext }, 'answer', false)).toBe(true);
  });

  test('does not invalidate the user message for assistant decoration', () => {
    expect(areRelevantTurnGroupingContextsEqual(
      finalAnswerContext,
      { ...finalAnswerContext, hasEarlierAssistantText: true },
      'user',
      true,
    )).toBe(true);
  });
});

describe('completed-turn changed files', () => {
  const files = [{ file: 'src/a.ts', additions: 2, deletions: 1, inTurnDiff: false }];

  test('re-renders when the turn diff later lists a file whose counts did not change', () => {
    const before = { ...finalAnswerContext, changedFiles: files };
    const after = { ...finalAnswerContext, changedFiles: [{ ...files[0], inTurnDiff: true }] };
    expect(areRelevantTurnGroupingContextsEqual(before, after, 'answer', false)).toBe(false);
  });

  test('preserves an equivalent rebuilt file list', () => {
    const before = { ...finalAnswerContext, changedFiles: files };
    const after = { ...finalAnswerContext, changedFiles: [{ ...files[0] }] };
    expect(areRelevantTurnGroupingContextsEqual(before, after, 'answer', false)).toBe(true);
  });
});
