import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { withSessionsNowInWorktree } from './worktreeUse';

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
