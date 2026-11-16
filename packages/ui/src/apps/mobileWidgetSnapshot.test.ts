import { afterEach, describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';

import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import {
  applyGlobalSessionStatusEvent,
  replaceGlobalSessionStatusById,
  useGlobalSessionStatusStore,
} from '@/sync/global-session-status';
import { buildMobileWidgetSnapshot } from './mobileWidgetSnapshot';

// SAFETY: the snapshot reads only the id, title, parent, directory and times.
const session = (id: string): Session => ({
  id,
  projectID: 'project',
  directory: '/repo',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  title: id,
  time: { created: 1, updated: 2 },
} as Session);

afterEach(() => {
  useGlobalSessionsStore.getState().applySnapshot([], []);
  replaceGlobalSessionStatusById(new Map());
  useGlobalSessionStatusStore.setState({ observedById: new Map() });
  useSessionUIStore.setState({ availableWorktreesByProject: new Map() });
  useProjectsStore.setState({ projects: [] });
});

describe('native widget session snapshot', () => {
  test('carries live activity from the global status channel, and nothing for idle sessions', () => {
    useGlobalSessionsStore.getState().applySnapshot(
      ['busy', 'retry', 'failed', 'done', 'idle'].map(session),
      [],
    );
    applyGlobalSessionStatusEvent('/repo', { type: 'session.status', properties: { sessionID: 'busy', status: { type: 'busy' } } });
    applyGlobalSessionStatusEvent('/repo', {
      type: 'session.status',
      properties: { sessionID: 'retry', status: { type: 'retry', attempt: 1, message: 'Wait', next: 1 } },
    });
    useGlobalSessionStatusStore.setState({
      observedById: new Map([
        ['failed', { directory: '/repo', outcome: 'failed' as const }],
        ['done', { directory: '/repo', outcome: 'completed' as const }],
      ]),
    });

    const status = new Map(buildMobileWidgetSnapshot().recentSessions.map((row) => [row.id, row.status]));
    expect(status.get('busy')).toBe('running');
    expect(status.get('retry')).toBe('retrying');
    expect(status.get('failed')).toBe('error');
    expect(status.has('done')).toBe(true);
    expect(status.get('done')).toBeUndefined();
    expect(status.get('idle')).toBeUndefined();
  });

  test('a session in a worktree shows the project the worktree belongs to', () => {
    useProjectsStore.setState({ projects: [{ id: 'p', path: '/repo', label: 'audiobookland', addedAt: 0 }] });
    useSessionUIStore.setState({
      availableWorktreesByProject: new Map([['/repo', [{
        path: '/wt/fix-login.2UIkfZ', projectDirectory: '/repo', branch: 'fix', label: 'fix',
      }]]]),
    });
    useGlobalSessionsStore.getState().applySnapshot([
      { ...session('wt'), directory: '/wt/fix-login.2UIkfZ' },
      { ...session('loose'), directory: '/elsewhere/scratch' },
    ], []);

    const project = new Map(buildMobileWidgetSnapshot().recentSessions.map((row) => [row.id, row.project]));
    expect(project.get('wt')).toBe('audiobookland');
    expect(project.get('loose')).toBe('scratch');
  });
});
