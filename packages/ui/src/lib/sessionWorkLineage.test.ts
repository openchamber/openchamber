import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { resolveSessionNestingParentId } from './sessionWorkLineage';

// SAFETY: lineage reads only ids, folders, parents, forks, archive time and metadata.
const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id, title: id, directory: '/repo', time: { created: 1, updated: 1 }, ...extra,
} as Session);

const resolve = (target: Session, all: Session[]) => {
  const byId = new Map(all.map((entry) => [entry.id, entry]));
  return resolveSessionNestingParentId(target, (id) => byId.get(id));
};

describe('resolveSessionNestingParentId', () => {
  const root = session('root');

  test('a subagent nests under its run, a review, fork and dispatched session under their origin', () => {
    const subagent = session('sub', { parentID: 'root' });
    const review = session('review', { metadata: { openchamber: { kind: 'review', originalSessionID: 'root' } } });
    // SAFETY: the fork boundary is not read by lineage.
    const fork = session('fork', { fork: { sessionID: 'root' } as Session['fork'] });
    const dispatched = session('dispatched', { metadata: { openchamber: { originSessionID: 'root' } } });
    const all = [root, subagent, review, fork, dispatched];
    expect(all.map((entry) => resolve(entry, all))).toEqual([null, 'root', 'root', 'root', 'root']);
  });

  test('the folder wins: an origin in another folder, unknown or archived leaves a root', () => {
    const elsewhere = session('elsewhere', { directory: '/wt', metadata: { openchamber: { originSessionID: 'root' } } });
    const unknown = session('unknown', { metadata: { openchamber: { originSessionID: 'missing' } } });
    const archivedOrigin = session('old', { time: { created: 1, updated: 1, archived: 2 } });
    const fromArchived = session('child', { metadata: { openchamber: { originSessionID: 'old' } } });
    const all = [root, elsewhere, unknown, archivedOrigin, fromArchived];
    expect([elsewhere, unknown, fromArchived].map((entry) => resolve(entry, all))).toEqual([null, null, null]);
  });

  test('a multi-run lane stays a root, and a recorded loop does not nest', () => {
    const lane = session('lane', { metadata: { openchamber: { multirun: { version: 1 }, originSessionID: 'root' } } });
    const a = session('a', { metadata: { openchamber: { originSessionID: 'b' } } });
    const b = session('b', { metadata: { openchamber: { originSessionID: 'a' } } });
    const all = [root, lane, a, b];
    expect(resolve(lane, all)).toBeNull();
    expect(resolve(a, all)).toBeNull();
    expect(resolve(b, all)).toBeNull();
  });
});
