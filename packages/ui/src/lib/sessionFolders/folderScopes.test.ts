import { describe, expect, test } from 'bun:test';

import { folderScopeKeepsMovedSession, getArchivedScopeKey } from './folderScopes';

describe('folderScopeKeepsMovedSession', () => {
  test('a session moved into a worktree leaves the project root folders', () => {
    expect(folderScopeKeepsMovedSession('/repo', '/worktrees/feat', '/worktrees/feat')).toBe(false);
    // A worktree nested in the project folder has folders of its own.
    expect(folderScopeKeepsMovedSession('/repo', '/repo/.worktrees/feat', '/repo/.worktrees/feat')).toBe(false);
    expect(folderScopeKeepsMovedSession('/worktrees/feat', '/worktrees/feat/src', '/worktrees/feat')).toBe(true);
  });

  test('a session moved out of a worktree leaves its folders', () => {
    expect(folderScopeKeepsMovedSession('/worktrees/feat', '/repo', null)).toBe(false);
    expect(folderScopeKeepsMovedSession('/worktrees/feat', '/worktrees/other', '/worktrees/other')).toBe(false);
  });

  test('a move inside the same place keeps the folder', () => {
    expect(folderScopeKeepsMovedSession('/repo', '/repo/docs', null)).toBe(true);
    expect(folderScopeKeepsMovedSession('/repo/', '/repo', null)).toBe(true);
    expect(folderScopeKeepsMovedSession('/repo', '/repository', null)).toBe(false);
  });

  test('archived folders are the restore\'s to settle', () => {
    expect(folderScopeKeepsMovedSession(getArchivedScopeKey('/repo'), '/elsewhere', null)).toBe(true);
  });
});
