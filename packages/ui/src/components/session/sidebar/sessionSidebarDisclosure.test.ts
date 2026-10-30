import { describe, expect, test } from 'bun:test';
import type { SessionSidebarActivityKey, SessionSidebarRow } from './sessionSidebarRowModel';
import { findSessionSidebarDisclosure } from './sessionSidebarDisclosure';

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
  more: true,
  fewer: false,
  containerKey: key,
  currentCount: 7,
  increment: 7,
});

// SAFETY: the disclosure reads only a row's kind, key and expansion fields.
const sessionRow = (key: string, expanded?: boolean): SessionSidebarRow => ({
  kind: 'session',
  key,
  estimateSize: 34,
  expanded,
  forceExpanded: expanded === undefined ? undefined : false,
} as SessionSidebarRow);

describe('findSessionSidebarDisclosure', () => {
  test('finds the subsessions a session row opened, so they animate as a header\'s rows do', () => {
    const previous = [sessionRow('s1', false), sessionRow('s2')];
    const next = [sessionRow('s1', true), child('s1-a'), child('s1-b'), sessionRow('s2')];

    expect(findSessionSidebarDisclosure(previous, next)).toEqual({
      opened: true,
      previousHeaderIndex: 0,
      nextHeaderIndex: 0,
      blockStart: 1,
      blockEnd: 3,
    });
  });

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
