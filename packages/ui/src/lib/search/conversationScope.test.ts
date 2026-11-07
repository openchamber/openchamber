import { expect, test } from 'bun:test';

import { matchesConversationProjectScope, normalizeConversationProjectPath } from './conversationScope';

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
