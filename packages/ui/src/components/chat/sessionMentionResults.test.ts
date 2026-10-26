import { describe, expect, test } from 'bun:test';

import type { Session } from '@/lib/opencode/model';
import { rankSessionMentions } from './sessionMentionResults';

// SAFETY: sessions as the global store holds them; ranking reads id, parent, title, directory and time.
const session = (id: string, title: string, directory: string, updated: number, extra: Partial<Session> = {}): Session => ({
  id, title, directory, projectID: 'p', cost: 0, time: { created: 0, updated }, ...extra,
} as Session);

describe('session mentions', () => {
  const sessions = [
    session('ses_1', 'Tweet writing', '/work/other', 5),
    session('ses_2', 'Tweet thread ideas', '/work/app', 1),
    session('ses_3', 'Tweet stats', '/work/app/worktree-x', 3),
    session('ses_4', 'Tweet subagent run', '/work/app', 9, { parentID: 'ses_2' }),
    session('ses_5', 'Release notes', '/work/app', 7),
    session('ses_now', 'Tweet current', '/work/app', 10),
  ];

  test('lists nothing before the user types', () => {
    expect(rankSessionMentions(sessions, '  ', { currentSessionId: null, projectRoot: '/work/app' })).toEqual([]);
  });

  test('finds by title across projects, the open project first, without the current session or subagent runs', () => {
    const found = rankSessionMentions(sessions, 'tweet', { currentSessionId: 'ses_now', projectRoot: '/work/app' });
    expect(found.map((entry) => entry.id)).toEqual(['ses_3', 'ses_2', 'ses_1']);
  });
});
