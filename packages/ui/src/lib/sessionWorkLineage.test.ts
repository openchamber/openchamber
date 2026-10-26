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

// SAFETY: the fork boundary is not read by lineage.
const forkOf = (sessionID: string) => ({ sessionID } as Session['fork']);

describe('resolveSessionNestingParentId', () => {
  const root = session('root');

  test('a subagent nests under its run, a review and a fork under their origin', () => {
    const subagent = session('sub', { parentID: 'root' });
    const review = session('review', { metadata: { openchamber: { kind: 'review', originalSessionID: 'root' } } });
    const fork = session('fork', { fork: forkOf('root') });
    const all = [root, subagent, review, fork];
    expect(all.map((entry) => resolve(entry, all))).toEqual([null, 'root', 'root', 'root']);
  });

  test('a session another session\'s agent started stays a root', () => {
    // Recorded by builds that nested these sessions; it no longer counts.
    const dispatched = session('dispatched', { metadata: { openchamber: { originSessionID: 'root' } } });
    expect(resolve(dispatched, [root, dispatched])).toBeNull();
  });

  test('the folder wins: an origin in another folder, unknown or archived leaves a root', () => {
    const elsewhere = session('elsewhere', { directory: '/wt', fork: forkOf('root') });
    const unknown = session('unknown', { fork: forkOf('missing') });
    const archivedOrigin = session('old', { time: { created: 1, updated: 1, archived: 2 } });
    const fromArchived = session('child', { fork: forkOf('old') });
    const all = [root, elsewhere, unknown, archivedOrigin, fromArchived];
    expect([elsewhere, unknown, fromArchived].map((entry) => resolve(entry, all))).toEqual([null, null, null]);
  });

  test('a multi-run lane stays a root, and a recorded loop does not nest', () => {
    const lane = session('lane', { fork: forkOf('root'), metadata: { openchamber: { multirun: { version: 1 } } } });
    const a = session('a', { fork: forkOf('b') });
    const b = session('b', { fork: forkOf('a') });
    const all = [root, lane, a, b];
    expect(resolve(lane, all)).toBeNull();
    expect(resolve(a, all)).toBeNull();
    expect(resolve(b, all)).toBeNull();
  });
});
