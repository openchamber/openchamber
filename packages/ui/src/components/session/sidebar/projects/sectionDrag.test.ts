import { describe, expect, test } from 'bun:test';
import type { SessionSidebarActivityKey, SessionSidebarRow } from '../sessionSidebarRowModel';
import { sectionIdOfRow } from './sectionDrag';

const activity = (activityKey: SessionSidebarActivityKey): SessionSidebarRow => ({ kind: 'activity-header', key: `activity:${activityKey}:header`, estimateSize: 34, activityKey, collapsed: false, forceExpanded: false });
const caption = (key: 'projects' | `section:${string}`): SessionSidebarRow => ({ kind: 'caption', key: `caption:${key}`, estimateSize: 34, caption: key, collapsed: false, forceExpanded: false });

describe('sectionIdOfRow', () => {
  test('a caption names its section by the id the user list keeps', () => {
    expect(sectionIdOfRow(activity('chats'))).toBe('chats');
    expect(sectionIdOfRow(activity('work'))).toBe('work');
    expect(sectionIdOfRow(activity('section:s1'))).toBe('s1');
    expect(sectionIdOfRow(caption('section:g1'))).toBe('g1');
    expect(sectionIdOfRow(caption('projects'))).toBe('projects');
  });

  test('the list by time is the Projects section', () => {
    expect(sectionIdOfRow(activity('timeline'))).toBe('projects');
  });

  test('other rows open no section', () => {
    expect(sectionIdOfRow({ kind: 'empty', key: 'e', estimateSize: 28, emptyKind: 'section' })).toBeNull();
  });
});
