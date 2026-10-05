import { expect, test } from 'bun:test';

import { prVisualStateOf } from './prVisualState';

const open = { state: 'open', draft: false, checksState: 'success', mergeable: true, mergeableState: 'clean' };

test('orange means something to fix: failed checks or a conflict', () => {
  expect(prVisualStateOf(open)).toBe('open');
  expect(prVisualStateOf({ ...open, checksState: 'failure' })).toBe('blocked');
  expect(prVisualStateOf({ ...open, mergeable: false })).toBe('blocked');
  expect(prVisualStateOf({ ...open, mergeableState: 'dirty' })).toBe('blocked');
});

test('a merge blocked only by a missing review keeps the open colour', () => {
  expect(prVisualStateOf({ ...open, mergeableState: 'blocked' })).toBe('open');
  expect(prVisualStateOf({ ...open, checksState: 'pending', mergeable: null, mergeableState: null })).toBe('open');
});

test('closed, merged and draft win over checks', () => {
  expect(prVisualStateOf({ ...open, state: 'merged', checksState: 'failure' })).toBe('merged');
  expect(prVisualStateOf({ ...open, state: 'closed', mergeable: false })).toBe('closed');
  expect(prVisualStateOf({ ...open, draft: true, checksState: 'failure' })).toBe('draft');
});
