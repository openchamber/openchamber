import { expect, test } from 'bun:test';

import { matchesConversationProjectScope, matchesConversationWorktreeScope, normalizeConversationProjectPath } from './conversationScope';

test('normalizes project paths for exact case-insensitive scopes', () => {
  expect(normalizeConversationProjectPath('/Repos/App/')).toBe('/repos/app');
  expect(matchesConversationProjectScope('/repos/app', '/Repos/App/')).toBe(true);
});

test('does not match colliding project paths', () => {
  expect(matchesConversationProjectScope('/repos/app', '/repos/app-backup')).toBe(false);
});

test('matches an exact project label without prefix matching', () => {
  expect(matchesConversationProjectScope('App', '/repos/app', 'App')).toBe(true);
  expect(matchesConversationProjectScope('App', '/repos/app-backup', 'App Backup')).toBe(false);
  expect(matchesConversationProjectScope('app', '/repos/app')).toBe(true);
});

test('a worktree scope names one worktree by full path or exact label, name or branch', () => {
  const task = { path: '/worktrees/task', label: 'Task', name: 'task', branch: 'feature/task' };
  const old = { path: '/worktrees/task-old', label: 'Task old', name: 'task-old', branch: 'feature/task-old' };
  for (const scope of ['/worktrees/task', '/Worktrees/Task/', 'task', 'feature/task']) {
    expect(matchesConversationWorktreeScope(scope, task)).toBe(true);
    expect(matchesConversationWorktreeScope(scope, old)).toBe(false);
  }
  expect(matchesConversationWorktreeScope('tas', task)).toBe(false);
  expect(matchesConversationWorktreeScope('', task)).toBe(false);
});
