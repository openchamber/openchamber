import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import type { SessionSidebarFolderTarget, SessionSidebarRow } from '../sessionSidebarRowModel';
import { getSessionDragId, getSessionFolderDropId } from '../sessions/sessionFolderIdentity';
import { applySessionFolderDrop, resolveCurrentSessionFolderDropSource, resolveCurrentSessionFolderDropTarget } from './sessionFolderDrop';

type SessionRow = Extract<SessionSidebarRow, { kind: 'session' }>;

const sessionRow = (ownerKey: string | null, archived = false): SessionRow => {
  const session: Session = {
    id: 'child-b',
    projectID: 'project',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    title: 'Child',
    directory: '/b-worktree',
    time: { created: 1, updated: 1 },
  };
  return {
    kind: 'session',
    key: 'project-a:session:child-b',
    estimateSize: 28,
    node: { session, children: [], worktree: null },
    depth: 1,
    ownsWork: false,
    projectId: 'project-a',
    ownerProjectId: ownerKey,
    groupDirectory: '/a',
    ownerKey,
    selectionScopeKey: ownerKey,
    archived,
    renderContext: 'project',
    secondaryMeta: null,
  };
};

const target = (ownerKey: string): SessionSidebarFolderTarget => ({
  rowKey: `folder-${ownerKey}`,
  scopeKey: `/${ownerKey}-worktree`,
  folderId: `folder-${ownerKey}`,
  ownerKey,
  enabled: true,
});

describe('session folder drop authority', () => {
  test('resolves and applies actual prefixed DnD identities for the current owner', () => {
    const writes: string[] = [];
    const row = sessionRow('project-b');
    const folder = target('project-b');
    const source = resolveCurrentSessionFolderDropSource([row], getSessionDragId(row.key), 'child-b');
    const currentTarget = resolveCurrentSessionFolderDropTarget(
      [folder],
      getSessionFolderDropId(folder.scopeKey, folder.folderId),
      folder.scopeKey,
      folder.folderId,
    );
    const applied = applySessionFolderDrop({
      sessionId: source?.sessionId ?? '',
      sessionOwnerKey: source?.ownerKey ?? null,
      target: currentTarget,
      authority: { scopeKeys: ['/project-b', folder.scopeKey], complete: true },
      removeSessionFromFolder: (scope, id) => writes.push(`remove:${scope}:${id}`),
      addSessionToFolder: (scope, folderId, id) => writes.push(`add:${scope}:${folderId}:${id}`),
    });

    expect(applied).toBe(true);
    expect(writes).toEqual([
      'remove:/project-b:child-b',
      `add:${folder.scopeKey}:${folder.folderId}:child-b`,
    ]);
  });

  test('rejects a forged owner claim even when it matches the target', () => {
    const writes: string[] = [];
    const row = sessionRow('project-b');
    const claimedTarget = target('project-a');
    const source = resolveCurrentSessionFolderDropSource([row], getSessionDragId(row.key), 'child-b');
    const applied = applySessionFolderDrop({
      sessionId: source?.sessionId ?? '',
      sessionOwnerKey: source?.ownerKey ?? null,
      target: claimedTarget,
      authority: { scopeKeys: ['/project-b'], complete: true },
      removeSessionFromFolder: (scope) => writes.push(`remove:${scope}`),
      addSessionToFolder: (scope) => writes.push(`add:${scope}`),
    });

    expect(source).toEqual({ sessionId: 'child-b', ownerKey: 'project-b' });
    expect(applied).toBe(false);
    expect(writes).toEqual([]);
  });

  test('rejects stale, mismatched, archived and unresolved sources', () => {
    const current = sessionRow('project-b');
    expect(resolveCurrentSessionFolderDropSource([current], getSessionDragId('stale'), 'child-b')).toBeNull();
    expect(resolveCurrentSessionFolderDropSource([current], getSessionDragId(current.key), 'other')).toBeNull();
    expect(resolveCurrentSessionFolderDropSource([sessionRow('project-b', true)], getSessionDragId(current.key), 'child-b')).toBeNull();
    expect(resolveCurrentSessionFolderDropSource([sessionRow(null)], getSessionDragId(current.key), 'child-b')).toBeNull();
  });

  test('rejects a stale or mismatched target identity', () => {
    const current = target('project-b');
    expect(resolveCurrentSessionFolderDropTarget([current], getSessionFolderDropId('/stale', current.folderId), current.scopeKey, current.folderId)).toBeUndefined();
    expect(resolveCurrentSessionFolderDropTarget([current], getSessionFolderDropId(current.scopeKey, current.folderId), '/other', current.folderId)).toBeUndefined();
  });
});
