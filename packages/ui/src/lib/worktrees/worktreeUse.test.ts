import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { activeSessionsInWorktreeNow, withSessionsNowInWorktree } from './worktreeUse';

const session = (id: string, directory: string): Session => ({
  id,
  projectID: 'project',
  directory,
  title: id,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
});

describe('withSessionsNowInWorktree', () => {
  test('keeps the first attempt\'s sessions and adds the ones started in the worktree since, once each', () => {
    useGlobalSessionsStore.setState({
      activeSessions: [
        session('ses_first', '/repo-feature'),
        session('ses_later', '/repo-feature/packages/app'),
        session('ses_elsewhere', '/repo'),
      ],
    });

    expect(withSessionsNowInWorktree(['ses_first', 'ses_gone'], '/repo-feature')).toEqual(['ses_first', 'ses_gone', 'ses_later']);
  });
});

describe('activeSessionsInWorktreeNow', () => {
  test('adds the live sessions the global list has not loaded yet, never an archived one or one elsewhere', () => {
    useGlobalSessionsStore.setState({
      activeSessions: [session('ses_listed', '/repo-feature'), session('ses_elsewhere', '/repo')],
    });
    const archived = { ...session('ses_archived', '/repo-feature'), time: { created: 1, updated: 1, archived: 2 } };

    const ids = activeSessionsInWorktreeNow('/repo-feature', [
      session('ses_listed', '/repo-feature'),
      session('ses_live_only', '/repo-feature/sub'),
      archived,
      session('ses_live_elsewhere', '/repo-feature-two'),
    ]).map((entry) => entry.id);

    expect(ids).toEqual(['ses_listed', 'ses_live_only']);
  });
});
