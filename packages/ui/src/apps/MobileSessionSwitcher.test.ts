import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionNode } from '@/components/session/sidebar/types';

import { collectSessionNodeDescendantIds } from './mobileSessionArchive';

const source = readFileSync(new URL('./MobileSessionSwitcher.tsx', import.meta.url), 'utf8');

const makeSession = (id: string): Session => ({
  id,
  title: `session-${id}`,
  time: { created: 0, updated: 0 },
} as Session);

const makeNode = (id: string, children: SessionNode[] = []): SessionNode => ({
  session: makeSession(id),
  children,
  worktree: null,
});

describe('collectSessionNodeDescendantIds', () => {
  test('returns every descendant depth-first, root excluded', () => {
    const node = makeNode('root', [
      makeNode('a', [makeNode('a1'), makeNode('a2', [makeNode('a2x')])]),
      makeNode('b'),
    ]);
    expect(collectSessionNodeDescendantIds(node)).toEqual(['a', 'a1', 'a2', 'a2x', 'b']);
  });

  test('returns an empty list for a leaf node', () => {
    expect(collectSessionNodeDescendantIds(makeNode('leaf'))).toEqual([]);
  });
});

describe('MobileSessionSwitcher archive affordance', () => {
  test('archive controls are siblings of the select button, so tapping them cannot select', () => {
    const rowStart = source.indexOf('const SwitcherRow');
    const selectButtonStart = source.indexOf('onClick={onSelect}', rowStart);
    const archiveButtonStart = source.indexOf("onClick={onRequestArchive}", rowStart);
    // The select button element is closed before the archive button opens:
    // the archive button lives outside it (sibling), not nested.
    expect(selectButtonStart).toBeGreaterThan(rowStart);
    expect(archiveButtonStart).toBeGreaterThan(selectButtonStart);
    // The archive button must not close over onSelect — tapping it never
    // selects the session.
    expect(source.indexOf('onSelect()', archiveButtonStart)).toBe(-1);
  });

  test('the confirm chip is gated behind the armed state and executes the archive', () => {
    const rowStart = source.indexOf('const SwitcherRow');
    // Confirm chip only renders while the row is armed.
    const chipGuard = source.indexOf('{confirmingArchive ? (', rowStart);
    expect(chipGuard).toBeGreaterThan(-1);
    // The armed icon button flips to the cancel affordance; tapping it
    // (onRequestArchive) disarms instead of archiving.
    const cancelLabel = source.indexOf("t('mobile.sessions.cancelArchiveAria', { title })", rowStart);
    expect(cancelLabel).toBeGreaterThan(chipGuard);
    // The chip itself performs the archive through the confirm handler.
    const chipConfirm = source.indexOf('onClick={onConfirmArchive}', rowStart);
    expect(chipConfirm).toBeGreaterThan(chipGuard);
  });

  test('the panel resets the armed confirmation when it closes or a session is selected', () => {
    const closeReset = source.indexOf('setConfirmingArchiveId(null);', source.indexOf('// Closing the panel cancels'));
    expect(closeReset).toBeGreaterThan(-1);
    const selectReset = source.indexOf('setConfirmingArchiveId(null);', source.indexOf('// Selecting a row cancels'));
    expect(selectReset).toBeGreaterThan(-1);
    const rowUsesArmedState = source.indexOf('confirmingArchive={confirmingArchiveId === session.id}');
    expect(rowUsesArmedState).toBeGreaterThan(-1);
  });

  test('the confirmed archive reuses the canonical batch action with descendant ids', () => {
    const handlerStart = source.indexOf('const handleConfirmArchive');
    expect(handlerStart).toBeGreaterThan(-1);
    expect(source.indexOf('archiveSessions([item.node.session.id, ...descendantIds])', handlerStart)).toBeGreaterThan(-1);
    expect(source.indexOf('collectSessionNodeDescendantIds(item.node)', handlerStart)).toBeGreaterThan(-1);
    // Partial failures keep their existing visible feedback.
    expect(source.indexOf("t('sessions.sidebar.bulkActions.failedArchivePlural', { count: failedIds.length })", handlerStart)).toBeGreaterThan(-1);
  });
});
