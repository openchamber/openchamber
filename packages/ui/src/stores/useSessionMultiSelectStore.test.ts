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

  test('an anchorless shift selection starts at the clicked occurrence', () => {
    useSessionMultiSelectStore.getState().setRange(null, 'project:session-a', entries, ['session-b-child'], 'project-a');

    expect([...useSessionMultiSelectStore.getState().selectedIds]).toEqual(['session-a']);
    expect(useSessionMultiSelectStore.getState().anchorRowKey).toBe('project:session-a');
  });
});
