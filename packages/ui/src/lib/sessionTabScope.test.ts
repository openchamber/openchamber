import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { sessionTabScopeFor, sessionTabSeedFor } from './sessionTabScope';

// SAFETY: the seed reads only ids, folders, parents, archive and activity times.
const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id, title: id, directory: '/wt', time: { created: 1, updated: 1 }, ...extra,
} as Session);

describe('session tab scopes', () => {
  test('a scope is the folder of one instance', () => {
    expect(sessionTabScopeFor('local', '/repo/')).toBe('local|/repo');
    expect(sessionTabScopeFor('remote', '/repo')).toBe('remote|/repo');
    expect(sessionTabScopeFor('local', null)).toBeNull();
  });

  test('a worktree opens with the sessions the user started there, newest first; a project root with none', () => {
    const sessions = [
      session('old', { time: { created: 1, updated: 1, idle: 10 } }),
      session('new', { time: { created: 1, updated: 1, idle: 20 } }),
      session('subagent', { parentID: 'new' }),
      session('archived', { time: { created: 1, updated: 1, archived: 5 } }),
      session('elsewhere', { directory: '/repo' }),
    ];
    expect(sessionTabSeedFor('/wt', sessions, ['/repo'])).toEqual(['new', 'old']);
    expect(sessionTabSeedFor('/repo', sessions, ['/repo'])).toEqual([]);
    expect(sessionTabSeedFor(null, sessions, ['/repo'])).toEqual([]);
  });
});
