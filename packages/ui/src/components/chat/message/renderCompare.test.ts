import { describe, expect, test } from 'bun:test';
import type { TurnGroupingContext } from '../lib/turns/types';
import { areRelevantTurnGroupingContextsEqual } from './renderCompare';

const finalAnswerContext: TurnGroupingContext = {
  turnId: 'turn',
  isFirstAssistantInTurn: false,
  isLastAssistantInTurn: true,
  isLatestTurn: true,
  isWorking: false,
  activitySettled: true,
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

describe('settled activity context', () => {
  const activityOwnerContext: TurnGroupingContext = {
    ...finalAnswerContext,
    activityOwnerMessageId: 'owner',
    activitySettled: false,
  };

  test('invalidates the activity owner when completion changes', () => {
    expect(areRelevantTurnGroupingContextsEqual(
      activityOwnerContext,
      { ...activityOwnerContext, activitySettled: true },
      'owner',
      false,
    )).toBe(false);
  });

  test('invalidates a segment anchor when completion changes', () => {
    const segment = { id: 'segment', anchorMessageId: 'anchor', afterToolPartId: null, parts: [] };
    const before = { ...activityOwnerContext, activityOwnerMessageId: 'owner', activityGroupSegments: [segment] };
    expect(areRelevantTurnGroupingContextsEqual(before, { ...before, activitySettled: true }, 'anchor', false)).toBe(false);
  });

  test('does not invalidate an unrelated assistant message when completion changes', () => {
    expect(areRelevantTurnGroupingContextsEqual(
      activityOwnerContext,
      { ...activityOwnerContext, activitySettled: true },
      'other',
      false,
    )).toBe(true);
  });
});
