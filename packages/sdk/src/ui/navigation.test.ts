import { describe, expect, test } from 'bun:test';

import { moveListSelection, navigationKey } from './navigation.ts';

const items = [
  { id: 'a' },
  { id: 'b', disabled: true },
  { id: 'c' },
  { id: 'd' },
];

describe('moveListSelection', () => {
  test('moves down and skips disabled items', () => {
    expect(moveListSelection(items, 'a', 'next')).toBe('c');
    expect(moveListSelection(items, 'c', 'next')).toBe('d');
  });

  test('moves up and stops at the first enabled item', () => {
    expect(moveListSelection(items, 'c', 'previous')).toBe('a');
    expect(moveListSelection(items, 'a', 'previous')).toBe('a');
  });

  test('stops at the last item', () => {
    expect(moveListSelection(items, 'd', 'next')).toBe('d');
  });

  test('enters from nothing at the matching edge', () => {
    expect(moveListSelection(items, null, 'next')).toBe('a');
    expect(moveListSelection(items, null, 'previous')).toBe('d');
    expect(moveListSelection(items, 'gone', 'next')).toBe('a');
  });

  test('home and end land on enabled edges', () => {
    expect(moveListSelection([{ id: 'x', disabled: true }, ...items], 'c', 'first')).toBe('a');
    expect(moveListSelection([...items, { id: 'z', disabled: true }], 'a', 'last')).toBe('d');
  });

  test('returns null when nothing is enabled', () => {
    expect(moveListSelection([], null, 'next')).toBeNull();
    expect(moveListSelection([{ id: 'x', disabled: true }], null, 'first')).toBeNull();
  });
});

describe('navigationKey', () => {
  test('maps arrows, home, end, and Ctrl+N / Ctrl+P', () => {
    expect(navigationKey({ key: 'ArrowDown', ctrlKey: false })).toBe('next');
    expect(navigationKey({ key: 'ArrowUp', ctrlKey: false })).toBe('previous');
    expect(navigationKey({ key: 'n', ctrlKey: true })).toBe('next');
    expect(navigationKey({ key: 'P', ctrlKey: true })).toBe('previous');
    expect(navigationKey({ key: 'Home', ctrlKey: false })).toBe('first');
    expect(navigationKey({ key: 'End', ctrlKey: false })).toBe('last');
  });

  test('ignores plain letters and horizontal arrows on a vertical axis', () => {
    expect(navigationKey({ key: 'n', ctrlKey: false })).toBeNull();
    expect(navigationKey({ key: 'ArrowRight', ctrlKey: false })).toBeNull();
    expect(navigationKey({ key: 'ArrowRight', ctrlKey: false }, 'horizontal')).toBe('next');
    expect(navigationKey({ key: 'ArrowLeft', ctrlKey: false }, 'horizontal')).toBe('previous');
  });
});
