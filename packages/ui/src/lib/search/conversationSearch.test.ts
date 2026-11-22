import { expect, test } from 'bun:test';

import { rankConversationMetadata } from './conversationSearch';

const items = [
  { sessionId: 'ses_abc', title: 'Unicode café', projectLabel: 'OpenChamber', worktreeLabel: null, directory: '/repo', archived: false },
  { sessionId: 'ses_def', title: 'Other', projectLabel: 'OpenChamber', worktreeLabel: 'feature/search', directory: '/repo', archived: false },
];

test('matches title abbreviations by subsequence and returns title ranges', () => {
  const [match] = rankConversationMetadata([{ sessionId: 'ses_token', title: 'Token refresh', projectLabel: null, worktreeLabel: null, directory: null, archived: false }], 'tkrf');
  expect(match).toMatchObject({ sessionId: 'ses_token', matchedField: 'title', titleRanges: [[0, 1], [2, 3], [6, 7], [8, 9]] });
});

test('requires every token across title and metadata fields', () => {
  const results = rankConversationMetadata([
    { sessionId: 'ses_mixed', title: 'Token refresh', projectLabel: 'OpenChamber', worktreeLabel: null, directory: null, archived: false },
    { sessionId: 'ses_title', title: 'Token Open refresh', projectLabel: null, worktreeLabel: null, directory: null, archived: false },
    { sessionId: 'ses_partial', title: 'Token refresh', projectLabel: 'Other project', worktreeLabel: null, directory: null, archived: false },
  ], 'token open');
  expect(results.map((match) => match.sessionId)).toEqual(['ses_title', 'ses_mixed']);
  expect(results[1].titleRanges).toEqual([[0, 5]]);
});

test('ranks title matches first and keeps title ranges for metadata matches', () => {
  const results = rankConversationMetadata([
    { sessionId: 'ses_metadata', title: 'Token refresh', projectLabel: 'OpenChamber', worktreeLabel: null, directory: null, archived: false },
    { sessionId: 'ses_title', title: 'Open Token', projectLabel: null, worktreeLabel: null, directory: null, archived: false },
  ], 'open');
  expect(results.map((match) => match.sessionId)).toEqual(['ses_title', 'ses_metadata']);
  expect(results[0].titleRanges).toEqual([[0, 4]]);
  expect(results[1].titleRanges).toEqual([]);
});

test('a flag-like word is plain search text', () => {
  expect(rankConversationMetadata([{ sessionId: 'ses_token', title: 'Token refresh', projectLabel: null, worktreeLabel: null, directory: null, archived: false }], 'token in:archived')).toEqual([]);
});

test('matches a session id only exactly', () => {
  expect(rankConversationMetadata(items, 'ses_abc').map((match) => match.sessionId)).toEqual(['ses_abc']);
  expect(rankConversationMetadata([{ ...items[0], sessionId: 'ses_MixedCase' }], 'SES_mixedcase').map((match) => match.sessionId)).toEqual(['ses_MixedCase']);
  expect(rankConversationMetadata(items, 'ses_ab')).toEqual([]);
});

test('titles only drops rows the query finds only in project, worktree or folder', () => {
  const row = { sessionId: 'ses_plain', title: 'Plain title', projectLabel: 'Zephyr', worktreeLabel: 'quasar', directory: '/worktrees/nebula', archived: false };
  for (const query of ['zephyr', 'quasar', 'nebula']) {
    expect(rankConversationMetadata([row], query).map((match) => match.sessionId)).toEqual(['ses_plain']);
    expect(rankConversationMetadata([row], query, { titlesOnly: true })).toEqual([]);
  }
  expect(rankConversationMetadata([row], 'plain', { titlesOnly: true }).map((match) => match.sessionId)).toEqual(['ses_plain']);
});

test('titles holding the words as typed list newest first, and scattered matches only when there are none', () => {
  const dated = (sessionId: string, title: string, updatedAt?: number) => ({ sessionId, title, projectLabel: null, worktreeLabel: null, directory: null, archived: false, updatedAt });
  const ranked = rankConversationMetadata([
    dated('old', 'Agent status', 100),
    dated('scattered', 'Add geometry notes', 900),
    dated('new', 'Review agent tool', 300),
    dated('mid', 'AGENTS.md', 200),
  ], 'agen');
  expect(ranked.map((match) => match.sessionId)).toEqual(['new', 'mid', 'old']);
  // An abbreviation no title holds as typed still finds its conversation.
  expect(rankConversationMetadata([dated('abbr', 'Command Palette rework', 1)], 'cmdpal').map((match) => match.sessionId)).toEqual(['abbr']);
  // Without dates the match order stands.
  const undated = [dated('b', 'Review agent tool'), dated('a', 'Agent')];
  expect(rankConversationMetadata(undated, 'agent').map((match) => match.sessionId)).toEqual(rankConversationMetadata(undated.map((item) => ({ ...item })), 'agent').map((match) => match.sessionId));
});

test('branch only finds a conversation by its branch, never by its project or folder', () => {
  const item = (sessionId: string, title: string, worktreeLabel: string | null) => ({ sessionId, title, projectLabel: 'openchamber', worktreeLabel, directory: '/repos/openchamber', archived: false });
  const list = [item('by-title', 'Openchamber docs', null), item('by-branch', 'Fix login', 'feature/openchamber-sso'), item('by-project', 'Fix logout', 'main')];
  expect(rankConversationMetadata(list, 'openchamber').map((match) => match.sessionId).sort()).toEqual(['by-branch', 'by-project', 'by-title']);
  const narrow = rankConversationMetadata(list, 'openchamber', { branchOnly: true });
  expect(narrow.map((match) => [match.sessionId, match.matchedField])).toEqual([['by-title', 'title'], ['by-branch', 'worktree']]);
});
