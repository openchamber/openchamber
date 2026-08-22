import { describe, expect, test } from 'bun:test';

import { resolveSwipeMove } from './mobileSessionSwipe';

describe('resolveSwipeMove', () => {
  test('cancels an active drag when another touch appears', () => {
    expect(resolveSwipeMove({
      touchCount: 2,
      dx: -30,
      dy: 0,
      axis: 'horizontal',
      dragging: true,
      revealed: false,
      actionsWidth: 96,
    })).toEqual({ type: 'cancel' });
  });

  test('leaves vertical gestures to native scrolling', () => {
    expect(resolveSwipeMove({
      touchCount: 1,
      dx: 4,
      dy: 12,
      axis: 'undecided',
      dragging: false,
      revealed: false,
      actionsWidth: 96,
    })).toEqual({ type: 'ignore', axis: 'vertical' });
  });

  test('clamps horizontal movement to the action width', () => {
    expect(resolveSwipeMove({
      touchCount: 1,
      dx: -120,
      dy: 2,
      axis: 'undecided',
      dragging: false,
      revealed: false,
      actionsWidth: 96,
    })).toEqual({ type: 'drag', axis: 'horizontal', offset: -96 });
  });
});
