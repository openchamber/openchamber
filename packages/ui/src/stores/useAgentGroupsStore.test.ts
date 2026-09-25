import { expect, mock, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import type { SessionListOptions, SessionPage } from '@/lib/opencode/client';
import { withMultiRunMembership } from '@/lib/multirun/identity';

const makeSession = (id: string, groupId: string): Session => ({
  id, projectID: 'p', directory: '/group-test', title: 'Renamed freely',
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  metadata: withMultiRunMembership({}, {
    version: 1, sessionID: id, group: { kind: 'id', id: groupId }, groupSlug: 'same-name',
    role: 'run', providerID: 'openrouter', modelID: 'vendor/model',
  }),
});

let sessions = [
  makeSession('first', '9f512893-6e63-4e49-a534-5de733ca103e'),
  makeSession('second', '5fdf22b1-d21e-4324-b2df-01747396c704'),
];
sessions.push({ ...sessions[0], id: 'fork' });
let failList = false;
const deleted: string[] = [];

mock.module('@/lib/opencode/client', () => ({
  OpencodeApiError: Error,
  normalizeOpencodeError: (operation: string, error: unknown) => new Error(`${operation}: ${String(error)}`),
  opencodeClient: {
    setDirectory: () => undefined,
    getDirectory: () => '/group-test',
    listSessionsPage: async (options: SessionListOptions): Promise<SessionPage> => {
      expect(options.directory).toBe('/group-test');
      if (failList) throw new Error('offline');
      return { sessions: [...sessions], cursor: {} };
    },
    getSession: async (id: string): Promise<Session> => {
      const session = sessions.find((item) => item.id === id);
      if (!session) throw new Error('not found');
      return session;
    },
  },
}));

// Only the delete is replaced; other consumers of this module keep the real exports.
const sessionActions = await import('@/sync/session-actions');
mock.module('@/sync/session-actions', () => ({
  ...sessionActions,
  deleteSessionInDirectory: async (id: string) => {
    deleted.push(id);
    sessions = sessions.filter((item) => item.id !== id);
    return true;
  },
}));

mock.module('@/lib/gitApi', () => ({
  checkIsGitRepository: async () => false,
}));

mock.module('@/lib/worktrees/worktreeManager', () => ({
  listProjectWorktrees: async () => [],
  removeProjectWorktree: async () => { throw new Error('no worktree removal expected'); },
}));

const { useDirectoryStore } = await import('./useDirectoryStore');
const { useProjectsStore } = await import('./useProjectsStore');
const { useAgentGroupsStore } = await import('./useAgentGroupsStore');

useProjectsStore.setState({ projects: [], activeProjectId: null });
useDirectoryStore.setState({ currentDirectory: '/group-test' });

test('Agent Manager keeps same-label runs separate and deletes only the selected ID group', async () => {
  await useAgentGroupsStore.getState().loadGroups();
  const groups = useAgentGroupsStore.getState().groups;
  expect(groups).toHaveLength(2);
  expect(groups.every((group) => group.name === 'same-name')).toBe(true);
  const first = groups.find((group) => group.sessions.some((session) => session.id === 'first'));
  if (!first) throw new Error('Missing first group');
  useAgentGroupsStore.getState().selectGroup(first.id);
  expect(useAgentGroupsStore.getState().selectedSessionId).toBe('first');

  failList = true;
  await useAgentGroupsStore.getState().loadGroups();
  expect(useAgentGroupsStore.getState().groups).toHaveLength(2);
  expect(useAgentGroupsStore.getState().error).not.toBeNull();
  failList = false;

  const result = await useAgentGroupsStore.getState().deleteGroupSessions(first.sessions, { removeWorktrees: true });
  await useAgentGroupsStore.getState().loadGroups();
  expect(result.failedIds).toEqual([]);
  expect(result.failedWorktreePaths).toEqual([]);
  expect(deleted).toEqual(['first']);
  expect(sessions.map((session) => session.id)).toEqual(['second', 'fork']);
  expect(useAgentGroupsStore.getState().groups).toHaveLength(1);
  expect(useAgentGroupsStore.getState().selectedGroupId).toBeNull();
}, 15000);
