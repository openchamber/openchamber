import { describe, expect, test } from 'bun:test';
import { applyFolderChange, chatPlacement, folderChangeSchema, type FolderChange } from './folderChanges';

const folder = (id: string, sessionIds: string[] = []) => ({ id, name: id, sessionIds, createdAt: 1, parentId: null });
const map = (holding: Record<string, string[]>) => ({ '/repo': Object.entries(holding).map(([id, sessionIds]) => folder(id, sessionIds)) });
const heldBy = (result: ReturnType<typeof applyFolderChange>, sessionId: string) => chatPlacement(result['/repo'], [sessionId])[sessionId];

describe('a move with the place it started from', () => {
  test('applies while the chat is still there', () => {
    const start = map({ p: ['s1'], x: [] });
    const moved = applyFolderChange(start, { type: 'assign', scopeKey: '/repo', folderId: 'x', sessionIds: ['s1'], from: { s1: 'p' } });
    expect(heldBy(moved, 's1')).toBe('x');
  });

  test('leaves a chat that moved elsewhere since, and changes nothing else', () => {
    const start = map({ p: [], x: [], y: ['s1'] });
    expect(applyFolderChange(start, { type: 'assign', scopeKey: '/repo', folderId: 'x', sessionIds: ['s1'], from: { s1: 'p' } })).toBe(start);
    expect(applyFolderChange(start, { type: 'unassign', scopeKey: '/repo', sessionIds: ['s1'], from: { s1: 'p' } })).toBe(start);
  });

  test('sent twice, it stays where the first one put it', () => {
    const start = map({ p: [], x: ['s1'] });
    expect(applyFolderChange(start, { type: 'assign', scopeKey: '/repo', folderId: 'x', sessionIds: ['s1'], from: { s1: 'p' } })).toBe(start);
  });

  test('moves only the chats of a batch that are still in place', () => {
    const start = map({ p: ['s1'], x: [], y: ['s2'] });
    const moved = applyFolderChange(start, { type: 'assign', scopeKey: '/repo', folderId: 'x', sessionIds: ['s1', 's2'], from: { s1: 'p', s2: 'p' } });
    expect(heldBy(moved, 's1')).toBe('x');
    expect(heldBy(moved, 's2')).toBe('y');
  });

  test('a chat that was in no folder is moved only while it is in none', () => {
    const unfiled = map({ x: [] });
    expect(heldBy(applyFolderChange(unfiled, { type: 'assign', scopeKey: '/repo', folderId: 'x', sessionIds: ['s1'], from: { s1: null } }), 's1')).toBe('x');
    const filed = map({ x: [], y: ['s1'] });
    expect(applyFolderChange(filed, { type: 'assign', scopeKey: '/repo', folderId: 'x', sessionIds: ['s1'], from: { s1: null } })).toBe(filed);
  });

  test('a chat whose folder another client deleted can still be moved', () => {
    const start = map({ x: [] });
    expect(heldBy(applyFolderChange(start, { type: 'assign', scopeKey: '/repo', folderId: 'x', sessionIds: ['s1'], from: { s1: 'deleted' } }), 's1')).toBe('x');
  });

  test('a move an older version queued, with no starting place, still applies', () => {
    const start = map({ x: [], y: ['s1'] });
    expect(heldBy(applyFolderChange(start, { type: 'assign', scopeKey: '/repo', folderId: 'x', sessionIds: ['s1'] }), 's1')).toBe('x');
  });

  test('keeps the starting place through the stored queue', () => {
    const change: FolderChange = { type: 'assign', scopeKey: '/repo', folderId: 'x', sessionIds: ['s1', 's2'], from: { s1: 'p', s2: null } };
    expect(folderChangeSchema.parse(JSON.parse(JSON.stringify(change)))).toEqual(change);
  });
});
