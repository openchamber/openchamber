import { expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { createRunParent } from './parent';
import { buildRunParentContext } from './parentContext';
import { getMultiRunIdentity, withMultiRunMembership } from './identity';
import { buildMultiRunIndex } from './runs';

const group = { kind: 'id', id: '9f512893-6e63-4e49-a534-5de733ca103e' } as const;
const makeSession = (id: string, role: 'parent' | 'run' = 'run'): Session => ({
  id, projectID: 'p', directory: `/worktrees/${id}`, title: id,
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1, idle: 2 },
  metadata: withMultiRunMembership({}, { version: 1, sessionID: id, group, groupSlug: 'run', role, providerID: 'provider', modelID: 'model' }),
});

// Oracle: parent creation adds a normal root chat and sends no model prompt;
// progress context uses current membership and live status, never idle history.
test('creates an editable parent in its own worktree without changing or prompting members', async () => {
  const a = makeSession('a');
  const b = makeSession('b');
  const sessions = new Map([a, b].map((session) => [session.id, session]));
  const run = [...buildMultiRunIndex(sessions.values(), () => '/repo').runs.values()][0];
  if (!run) throw new Error('Empty premise');
  const calls: string[] = [];
  const io: NonNullable<Parameters<typeof createRunParent>[1]> = {
    readSession: async () => a,
    locate: async () => ({ project: { id: 'p', path: '/repo' }, worktree: { path: a.directory, projectDirectory: '/repo', branch: 'a', label: 'a' } }),
    snapshot: async (_directory, { ref }) => { calls.push('snapshot'); return { ref, head: 'base', commit: 'snapshot' }; },
    createWorktree: async (_project, input) => {
      calls.push('worktree');
      expect(input.startRef).toBe('base');
      return { path: '/worktrees/parent', projectDirectory: '/repo', branch: 'parent', label: 'parent' };
    },
    startDirectory: async (_project, tree) => tree.path,
    createSession: async (input) => {
      calls.push('create');
      expect(input.selection?.model).toEqual({ providerID: 'parent-provider', id: 'parent-model', variant: undefined });
      return { ...makeSession('parent', 'parent'), directory: input.directory, metadata: withMultiRunMembership({}, { ...input.identity, version: 1, sessionID: 'parent' }) };
    },
    publish: (session) => { calls.push('publish'); return session; },
    attachWorktree: () => { calls.push('attach'); },
  };
  const parent = await createRunParent({ run, sessionById: sessions, model: { providerID: 'parent-provider', modelID: 'parent-model' }, title: 'Parent' }, io);
  expect(parent.parentID).toBeUndefined();
  expect(getMultiRunIdentity(parent)?.role).toBe('parent');
  expect(parent.directory).not.toBe(a.directory);
  expect(sessions.get('a')).toBe(a);
  expect(calls).toEqual(['snapshot', 'worktree', 'create', 'publish', 'attach']);
});

test('parent sees running, blocked, finished and unavailable work without treating old output as live', async () => {
  const parent = makeSession('parent', 'parent');
  const sessions = ['running', 'blocked', 'done', 'broken'].map((id) => makeSession(id));
  const reads: string[] = [];
  const context = await buildRunParentContext({ parent, sessions }, {
    readSession: async (id) => {
      const session = sessions.find((item) => item.id === id);
      if (!session) throw new Error('Missing session');
      return session;
    },
    readReply: async (id) => {
      reads.push(id);
      if (id === 'broken') throw new Error('read failed');
      return `final-${id}`;
    },
    isBusy: (id) => id === 'running' || id === 'blocked',
    blocking: (id) => id === 'blocked' ? 'permission' : null,
  });
  expect(context).toContain('"status":"working"');
  expect(context).toContain('"status":"permission"');
  expect(context).toContain('final-done');
  expect(context).toContain('unavailable');
  expect(reads).toEqual(['done', 'broken']);
  expect(context).toContain('not automatically delivered');
  expect(context).toContain('Completed work changes only after another instruction runs');
});

test('revalidates members and excludes detached, archived, and unrelated sessions', async () => {
  const parent = makeSession('parent', 'parent');
  const member = makeSession('source');
  const detached = { ...member, metadata: {} };
  const context = await buildRunParentContext({ parent, sessions: [member, { ...member, id: 'fork' }, { ...member, time: { ...member.time, archived: 10 } }] }, {
    readSession: async () => detached,
    readReply: async () => { throw new Error('Detached results must not be read'); },
    isBusy: () => false, blocking: () => null,
  });
  expect(context).toContain('Current known members, read for this user message: []');
});
