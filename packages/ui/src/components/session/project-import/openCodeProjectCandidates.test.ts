import { describe, expect, test } from 'bun:test';
import { openCodeProjectCandidates } from './openCodeProjectCandidates';

const repo = (worktree: string, updated = 1, name?: string) => ({
  worktree,
  vcs: 'git' as const,
  name,
  time: { created: 1, updated },
});

describe('openCodeProjectCandidates', () => {
  test('offers repositories, latest first, named by folder unless OpenCode has a name', () => {
    const candidates = openCodeProjectCandidates([
      repo('/home/me/code/older', 1),
      repo('/home/me/code/newer', 2, ' Newer '),
    ], new Set());

    expect(candidates).toEqual([
      { path: '/home/me/code/newer', parent: '/home/me/code', name: 'Newer' },
      { path: '/home/me/code/older', parent: '/home/me/code', name: 'older' },
    ]);
  });

  test('leaves out what OpenCode records that is nobody\'s project', () => {
    const candidates = openCodeProjectCandidates([
      { worktree: '/home/me', vcs: undefined, time: { created: 1, updated: 1 } },
      { worktree: '/home/me/Documents/notes', vcs: undefined, time: { created: 1, updated: 1 } },
      repo('/'),
      repo('/tmp/run-1/repo'),
      repo('/private/tmp/run-2/repo'),
      repo('/private/var/folders/qj/T/opencode/repo'),
      repo('/home/me/.cache/bench/runs/repo'),
      repo('/home/me/.local/share/opencode/worktree/abc/fuzzy-fox'),
      repo('/Users/me/Library/Application Support/Code/User/repo'),
      repo('C:/Users/me/AppData/Local/Temp/repo'),
      repo('/home/me/code/kept'),
    ], new Set());

    expect(candidates.map((candidate) => candidate.path)).toEqual(['/home/me/code/kept']);
  });

  test('skips configured projects and duplicate records of one folder', () => {
    const candidates = openCodeProjectCandidates([
      repo('/home/me/code/added'),
      repo('/home/me/code/twice', 1),
      repo('/home/me/code/twice/', 2),
    ], new Set(['/home/me/code/added']));

    expect(candidates.map((candidate) => candidate.path)).toEqual(['/home/me/code/twice']);
  });
});
