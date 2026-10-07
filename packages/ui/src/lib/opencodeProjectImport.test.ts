import { describe, expect, test } from 'bun:test';
import type { Project } from '@/lib/opencode/model';
import {
  excludeMissingOpenCodeProjectImportCandidates,
  getOpenCodeProjectImportDisplayName,
  getOpenCodeProjectImportCandidates,
  shouldAutoOpenOpenCodeProjectImportPrompt,
} from './opencodeProjectImport';

const project = (worktree: string, sandboxes: string[] = [], name?: string): Project => ({
  id: `project:${worktree}`,
  worktree,
  sandboxes,
  name,
  time: { created: 1, updated: 1 },
});

describe('shouldAutoOpenOpenCodeProjectImportPrompt', () => {
  const eligible = {
    runtime: 'supported',
    projects: 'loaded',
    directories: 'checked',
    importableCount: 1,
  } satisfies Parameters<typeof shouldAutoOpenOpenCodeProjectImportPrompt>[0];

  test('opens only after a supported runtime has loaded and checked importable projects', () => {
    expect(shouldAutoOpenOpenCodeProjectImportPrompt(eligible)).toBe(true);
    expect(shouldAutoOpenOpenCodeProjectImportPrompt({ ...eligible, runtime: 'vscode' })).toBe(false);
    expect(shouldAutoOpenOpenCodeProjectImportPrompt({ ...eligible, projects: 'loading' })).toBe(false);
    expect(shouldAutoOpenOpenCodeProjectImportPrompt({ ...eligible, directories: 'checking' })).toBe(false);
    expect(shouldAutoOpenOpenCodeProjectImportPrompt({ ...eligible, importableCount: 0 })).toBe(false);
  });
});

describe('getOpenCodeProjectImportCandidates', () => {
  test('skips global, empty, and exact configured paths but keeps child roots', () => {
    const candidates = getOpenCodeProjectImportCandidates([
      project('/'),
      project('  '),
      project('/home/user/'),
      project('/home/user/repo'),
      project('/other/repo'),
    ], [
      { path: '/home/user' },
    ]);

    expect(candidates.map(({ path }) => path)).toEqual(['/home/user/repo', '/other/repo']);
  });

  test('deduplicates canonical paths and combines unique sandbox details', () => {
    const candidates = getOpenCodeProjectImportCandidates([
      project('C:\\Work\\Repo\\', ['C:\\Work\\Repo\\.opencode\\worktree\\feature'], 'Repo'),
      project('C:/Work/Repo', ['C:/Work/Repo/.opencode/worktree/feature', 'C:/Work/Repo/.opencode/worktree/other']),
    ], []);

    expect(candidates).toEqual([{
      path: 'C:\\Work\\Repo\\',
      sandboxes: ['C:\\Work\\Repo\\.opencode\\worktree\\feature', 'C:/Work/Repo/.opencode/worktree/other'],
    }]);
  });

  test('does not offer an associated sandbox as a separate import', () => {
    const candidates = getOpenCodeProjectImportCandidates([
      project('/repo', ['/sandbox/repo']),
      project('/sandbox/repo'),
    ], []);

    expect(candidates).toEqual([{ path: '/repo', sandboxes: ['/sandbox/repo'] }]);
  });

  test('does not carry OpenCode names into imported candidates', () => {
    const candidates = getOpenCodeProjectImportCandidates([project('/repo', [], 'OpenCode Display Name')], []);

    expect(candidates).toEqual([{ path: '/repo', sandboxes: [] }]);
  });

  test('does not offer OpenChamber managed chat session directories as projects', () => {
    const candidates = getOpenCodeProjectImportCandidates([
      project('/Users/tim/.config/openchamber/chats/2026-10-05/session-chat'),
      project('/Users/tim/work/repo'),
    ], [], '/Users/tim');

    expect(candidates.map(({ path }) => path)).toEqual(['/Users/tim/work/repo']);
  });
});

describe('excludeMissingOpenCodeProjectImportCandidates', () => {
  test('excludes only paths confirmed missing by the server', () => {
    const candidates = [{ path: '/available' }, { path: '/missing' }, { path: '/unknown' }];

    expect(excludeMissingOpenCodeProjectImportCandidates(candidates, new Set(['/missing'])))
      .toEqual([{ path: '/available' }, { path: '/unknown' }]);
  });
});

describe('getOpenCodeProjectImportDisplayName', () => {
  test('uses the same folder label as the sidebar for Windows paths', () => {
    expect(getOpenCodeProjectImportDisplayName('C:\\Users\\Tim\\.config\\opencode', 'C:/Users/Tim'))
      .toBe('opencode');
  });
});
