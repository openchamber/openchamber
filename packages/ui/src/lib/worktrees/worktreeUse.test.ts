import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { ChildStoreManager } from '@/sync/child-store';
import { activeSessionsInWorktreeNow, readSessionsInWorktree, subscribeSessionsInWorktree, withSessionsNowInWorktree } from './worktreeUse';

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

  test('a session the global list places in another worktree stays out, whatever a stale live copy says', () => {
    useGlobalSessionsStore.setState({ activeSessions: [{ ...session('ses_moved', '/repo-other'), time: { created: 1, updated: 2 } }] });

    const ids = activeSessionsInWorktreeNow('/repo-feature', [session('ses_moved', '/repo-feature')]).map((entry) => entry.id);

    expect(ids).toEqual([]);
  });
});

describe('worktree containment on Windows paths', () => {
  test('a drive path holds its subfolders whatever the separator or drive letter case, never a sibling with the same prefix', () => {
    useGlobalSessionsStore.setState({
      activeSessions: [
        session('ses_root', 'C:\\work\\feature'),
        session('ses_sub', 'c:\\work\\feature\\packages\\app'),
        session('ses_sibling', 'C:\\work\\feature-two'),
        session('ses_other_drive', 'D:\\work\\feature'),
      ],
    });

    expect(activeSessionsInWorktreeNow('C:/work/feature/', []).map((entry) => entry.id)).toEqual(['ses_root', 'ses_sub']);
  });

  test('a UNC share path holds its subfolders, never a sibling share folder', () => {
    useGlobalSessionsStore.setState({ activeSessions: [] });

    const ids = activeSessionsInWorktreeNow('\\\\server\\share\\feature', [
      session('ses_root', '\\\\server\\share\\feature'),
      session('ses_sub', '\\\\server\\share\\feature\\src'),
      session('ses_sibling', '\\\\server\\share\\feature2'),
      session('ses_other_share', '\\\\server\\other\\feature'),
    ]).map((entry) => entry.id);

    expect(ids).toEqual(['ses_root', 'ses_sub']);
  });
});

describe('readSessionsInWorktree', () => {
  // The delete dialog gates "Keep sessions in the project" on this count: a
  // session only a live store holds must still offer the option.
  test('counts a session only a live store holds while the global list is empty, and follows that store', () => {
    useGlobalSessionsStore.setState({ activeSessions: [] });
    const manager = new ChildStoreManager();
    const child = manager.ensureChild('/repo-feature', { bootstrap: false });
    let notifications = 0;
    const unsubscribe = subscribeSessionsInWorktree(manager, () => {
      notifications += 1;
    });

    expect(readSessionsInWorktree(manager, '/repo-feature')).toEqual([]);

    child.setState({ session: [session('ses_live_only', '/repo-feature')] });
    expect(notifications).toBe(1);
    expect(readSessionsInWorktree(manager, '/repo-feature').map((entry) => entry.id)).toEqual(['ses_live_only']);

    useGlobalSessionsStore.setState({ activeSessions: [session('ses_listed', '/repo-feature/sub')] });
    expect(notifications).toBe(2);
    expect(readSessionsInWorktree(manager, '/repo-feature').map((entry) => entry.id)).toEqual(['ses_listed', 'ses_live_only']);

    unsubscribe();
    manager.disposeAll();
  });
});
