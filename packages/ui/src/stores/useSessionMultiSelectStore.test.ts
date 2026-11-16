import { beforeEach, describe, expect, test } from 'bun:test';
import { useSessionMultiSelectStore } from './useSessionMultiSelectStore';
import type { SessionRowOrderEntry } from '@/components/session/sidebar/sessions/sessionRowOrder';

const entries: SessionRowOrderEntry[] = [
  { id: 'session-a', rowKey: 'recent:session-a', scopeKey: 'project-a', archived: false },
  { id: 'session-b', rowKey: 'project:session-b', scopeKey: 'project-a', archived: false, descendantRange: [0, 1] },
  { id: 'session-a', rowKey: 'project:session-a', scopeKey: 'project-a', archived: false },
  { id: 'session-c', rowKey: 'other:session-c', scopeKey: 'project-b', archived: false },
];

describe('useSessionMultiSelectStore logical ranges', () => {
  beforeEach(() => useSessionMultiSelectStore.getState().disable());

  test('ranges by occurrence key rather than ambiguous session ID', () => {
    useSessionMultiSelectStore.getState().toggleSelected('session-a', 'project-a', [], 'project:session-a');
    useSessionMultiSelectStore.getState().setRange('project:session-a', 'project:session-b', entries, ['session-b-child'], 'project-a');

    expect([...useSessionMultiSelectStore.getState().selectedIds]).toEqual(['session-a', 'session-b', 'session-b-child']);
    expect(useSessionMultiSelectStore.getState().anchorRowKey).toBe('project:session-a');
  });

  test('does not cross owner scope boundaries', () => {
    useSessionMultiSelectStore.getState().setRange(null, 'other:session-c', entries, [], 'project-a');

    expect(useSessionMultiSelectStore.getState().selectedIds.size).toBe(0);
  });

  test('selects descendants through the shared preorder pool', () => {
    useSessionMultiSelectStore.getState().setRange(null, 'archived:parent', [{
      id: 'parent',
      rowKey: 'archived:parent',
      scopeKey: 'project-a',
      archived: true,
      descendantRange: [0, 1],
    }], ['child'], 'project-a');

    expect([...useSessionMultiSelectStore.getState().selectedIds]).toEqual(['parent', 'child']);
  });

  test('a range skips the sessions of a folded work, which have no row', () => {
    const zone: SessionRowOrderEntry[] = [
      { id: 'first', rowKey: 'activity:work:first', scopeKey: 'activity:work', archived: false },
      { id: 'folded', rowKey: null, scopeKey: 'activity:work', archived: false },
      { id: 'last', rowKey: 'activity:work:last', scopeKey: 'activity:work', archived: false },
    ];
    useSessionMultiSelectStore.getState().setRange('activity:work:first', 'activity:work:last', zone, [], 'activity:work');

    expect([...useSessionMultiSelectStore.getState().selectedIds]).toEqual(['first', 'last']);
  });

  test('a selected session shown again in another scope unchecks there and keeps the rest', () => {
    const store = useSessionMultiSelectStore.getState;
    store().toggleSelected('in-work-a', 'activity:work', ['in-work-a-child'], 'activity:work:in-work-a');
    store().toggleSelected('in-work-b', 'activity:work', [], 'activity:work:in-work-b');
    // The same session's row under its project.
    store().toggleSelected('in-work-a', 'project-a', ['in-work-a-child'], 'project:in-work-a');

    expect([...store().selectedIds]).toEqual(['in-work-b']);
    expect(store().scopeKey).toBe('activity:work');

    // A row of another scope that is not selected still starts a new selection.
    store().toggleSelected('session-c', 'project-b', [], 'other:session-c');
    expect([...store().selectedIds]).toEqual(['session-c']);
    expect(store().scopeKey).toBe('project-b');
  });

  test('an anchorless shift selection starts at the clicked occurrence', () => {
    useSessionMultiSelectStore.getState().setRange(null, 'project:session-a', entries, ['session-b-child'], 'project-a');

    expect([...useSessionMultiSelectStore.getState().selectedIds]).toEqual(['session-a']);
    expect(useSessionMultiSelectStore.getState().anchorRowKey).toBe('project:session-a');
  });
});
