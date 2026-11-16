import { describe, expect, test } from 'bun:test';
import { deriveSessionRowBulkSelectAll, deriveSessionRowSelectionArchived, mergeSessionRowLifecycle, type SessionRowOrderEntry } from './sessionRowOrder';
import { searchFixture, searchResult } from '../sidebarSearch.fixture';
import { buildSessionSidebarRowModel } from '../sessionSidebarRowModel';
import { resolveBulkDeleteConfirmation } from '../folders/useSidebarBulkActions';

const entries: SessionRowOrderEntry[] = [
  { id: 'duplicate', rowKey: 'recent:duplicate', scopeKey: 'project-a', archived: false },
  { id: 'other', rowKey: 'project:other', scopeKey: 'project-a', archived: false },
  { id: 'duplicate', rowKey: 'project:duplicate', scopeKey: 'project-a', archived: false },
  { id: 'outside', rowKey: 'project:outside', scopeKey: 'project-b', archived: false },
];

describe('session row order authority', () => {
  for (const archived of [true, false]) test(`${archived ? 'archived' : 'active'} content-only select-all preserves restore and delete lifecycle without fabricating a session`, () => {
    const input = searchFixture(0);
    input.contentSearchResults = [searchResult('content-only', { archived, metadata: null })];
    const model = buildSessionSidebarRowModel(input);
    const selected = deriveSessionRowBulkSelectAll(model.selectionEntries, model.selectionDescendantIds, null)!;
    expect(selected.ids).toEqual(['content-only']);
    expect(model.sessionById.has('content-only')).toBe(false);
    const registry = mergeSessionRowLifecycle(model.selectionEntries, model.sessionById);
    expect(registry.get('content-only')).toEqual({ archived });
    expect(deriveSessionRowSelectionArchived(new Set(selected.ids), registry)).toBe(archived);
    expect(resolveBulkDeleteConfirmation({ sessionIds: selected.ids, sessionCount: 1, archivedBucket: archived }, registry)).toEqual({
      ready: true, value: { sessionIds: ['content-only'], sessionCount: 1, archivedBucket: archived },
    });
    expect(resolveBulkDeleteConfirmation({ sessionIds: selected.ids, sessionCount: 1, archivedBucket: false }, registry)).toEqual({
      ready: !archived, value: { sessionIds: ['content-only'], sessionCount: 1, archivedBucket: archived },
    });
  });

  test('live session lifecycle overrides a content-result fallback and unknown IDs remain active', () => {
    const registry = mergeSessionRowLifecycle([{ id: 'a', rowKey: 'a', scopeKey: null, archived: true }], new Map([['a', { time: {} }]]));
    expect(deriveSessionRowSelectionArchived(new Set(['a']), registry)).toBe(false);
    expect(deriveSessionRowSelectionArchived(new Set(['unknown']), registry)).toBe(false);
  });
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
