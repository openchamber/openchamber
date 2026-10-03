import { describe, expect, test } from 'bun:test';
import { deriveSessionRowBulkSelectAll, deriveSessionRowSelectionArchived, type SessionRowOrderEntry } from './sessionRowOrder';

const entries: SessionRowOrderEntry[] = [
  { id: 'duplicate', rowKey: 'recent:duplicate', scopeKey: 'project-a', archived: false },
  { id: 'other', rowKey: 'project:other', scopeKey: 'project-a', archived: false },
  { id: 'duplicate', rowKey: 'project:duplicate', scopeKey: 'project-a', archived: false },
  { id: 'outside', rowKey: 'project:outside', scopeKey: 'project-b', archived: false },
];

describe('session row order authority', () => {
  test('deduplicates API IDs while preserving model order and scope', () => {
    expect(deriveSessionRowBulkSelectAll(entries, [], 'project-a')).toEqual({ ids: ['duplicate', 'other'], scopeKey: 'project-a' });
  });

  test('includes hidden descendants from the shared preorder pool', () => {
    const parentEntries: SessionRowOrderEntry[] = [
      { id: 'parent', rowKey: 'project:parent', scopeKey: 'project-a', archived: false, descendantRange: [0, 2] },
    ];

    expect(deriveSessionRowBulkSelectAll(parentEntries, ['child', 'grandchild'], 'project-a')).toEqual({
      ids: ['parent', 'child', 'grandchild'],
      scopeKey: 'project-a',
    });
  });

  test('reads current session archive metadata rather than selection-time state', () => {
    const selected = new Set(['duplicate']);
    const session = { time: { archived: 1 } };
    const sessions = new Map([['duplicate', session]]);
    expect(deriveSessionRowSelectionArchived(selected, sessions)).toBe(true);

    session.time.archived = 0;
    expect(deriveSessionRowSelectionArchived(selected, sessions)).toBe(false);
  });
});
