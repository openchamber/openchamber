import { describe, expect, test } from 'bun:test';
import type { SessionSidebarActivityKey, SessionSidebarRow } from './sessionSidebarRowModel';
import { boundaryClipKeyframes, findSessionSidebarDisclosure } from './sessionSidebarDisclosure';

const header = (activityKey: SessionSidebarActivityKey, collapsed: boolean, forceExpanded = false): SessionSidebarRow => ({
  kind: 'activity-header',
  key: `activity:${activityKey}`,
  estimateSize: 28,
  activityKey,
  collapsed,
  forceExpanded,
});

const child = (key: string): SessionSidebarRow => ({
  kind: 'show-control',
  key,
  estimateSize: 20,
  control: 'more',
  containerKey: key,
  currentCount: 7,
  increment: 7,
});

describe('findSessionSidebarDisclosure', () => {
  test('finds the rows a header opened', () => {
    const previous = [header('chats', true), header('work', false), child('w1')];
    const next = [header('chats', false), child('c1'), child('c2'), header('work', false), child('w1')];

    expect(findSessionSidebarDisclosure(previous, next)).toEqual({
      opened: true,
      previousHeaderIndex: 0,
      nextHeaderIndex: 0,
      blockStart: 1,
      blockEnd: 3,
    });
  });

  test('finds the rows a header closed, at the end of the list too', () => {
    const previous = [header('chats', false), child('c1'), header('work', false), child('w1'), child('w2')];
    const next = [header('chats', false), child('c1'), header('work', true)];

    expect(findSessionSidebarDisclosure(previous, next)).toEqual({
      opened: false,
      previousHeaderIndex: 2,
      nextHeaderIndex: 2,
      blockStart: 3,
      blockEnd: 5,
    });
  });

  test('ignores several headers changing at once, as Collapse all does', () => {
    const previous = [header('chats', false), child('c1'), header('work', false), child('w1')];
    const next = [header('chats', true), header('work', true)];

    expect(findSessionSidebarDisclosure(previous, next)).toBeNull();
  });

  test('ignores headers search holds open', () => {
    const previous = [header('chats', true), header('work', false)];
    const next = [header('chats', false, true), child('c1'), header('work', false, true)];

    expect(findSessionSidebarDisclosure(previous, next)).toBeNull();
  });

  test('ignores a header that changed with nothing under it', () => {
    const previous = [header('chats', true), header('work', false)];
    const next = [header('chats', false), header('work', false)];

    expect(findSessionSidebarDisclosure(previous, next)).toBeNull();
  });

  test('ignores a change that is not one block right under the header', () => {
    const previous = [header('chats', true), child('a'), header('work', false)];
    const next = [header('chats', false), child('c1'), header('work', false)];

    expect(findSessionSidebarDisclosure(previous, next)).toBeNull();
  });

  test('ignores rows that changed without a header changing', () => {
    const previous = [header('chats', false), child('c1')];
    const next = [header('chats', false), child('c1'), child('c2')];

    expect(findSessionSidebarDisclosure(previous, next)).toBeNull();
  });
});

describe('boundaryClipKeyframes', () => {
  test('reveals a row as the boundary passes over it', () => {
    // A 20px row at 40, under a boundary moving 20 → 100.
    expect(boundaryClipKeyframes(40, 20, 20, 100)).toEqual([
      { offset: 0, clipPath: 'inset(0 0 20px 0)' },
      { offset: 0.25, clipPath: 'inset(0 0 20px 0)' },
      { offset: 0.5, clipPath: 'inset(0 0 0px 0)' },
      { offset: 1, clipPath: 'inset(0 0 0px 0)' },
    ]);
  });

  test('hides a row as the boundary rises over it', () => {
    expect(boundaryClipKeyframes(40, 20, 100, 20)).toEqual([
      { offset: 0, clipPath: 'inset(0 0 0px 0)' },
      { offset: 0.5, clipPath: 'inset(0 0 0px 0)' },
      { offset: 0.75, clipPath: 'inset(0 0 20px 0)' },
      { offset: 1, clipPath: 'inset(0 0 20px 0)' },
    ]);
  });
});
