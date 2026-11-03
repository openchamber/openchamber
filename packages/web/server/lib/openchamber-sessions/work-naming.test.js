import { describe, expect, it, vi } from 'vitest';
import { createWorkNamer } from './work-naming.js';

const createError = (message, status) => Object.assign(new Error(message), { status });

const setup = ({ sessions, worktrees = [{ path: '/repo' }] }) => {
  const records = new Map(sessions.map((session) => [session.id, structuredClone(session)]));
  const renameSession = vi.fn(async (sessionID, title) => {
    records.get(sessionID).title = title;
  });
  const updateMetadata = vi.fn(async (sessionID, decide) => {
    const record = records.get(sessionID);
    const patch = decide(record.metadata ?? {});
    if (patch) record.metadata = { ...record.metadata, openchamber: { ...record.metadata?.openchamber, ...patch.openchamber } };
  });
  const setWorktreeTaskTitle = vi.fn(async (_directory, { title }) => ({ applied: true, title, branch: 'feature/x', by: 'agent' }));
  const namer = createWorkNamer({
    getSession: async (sessionID) => records.get(sessionID) ?? null,
    listWorktrees: async () => worktrees,
    setWorktreeTaskTitle,
    renameSession,
    updateMetadata,
    createError,
  });
  return { namer, records, renameSession, updateMetadata, setWorktreeTaskTitle };
};

describe('work.name', () => {
  it('names a linked worktree through its branch', async () => {
    const { namer, setWorktreeTaskTitle, renameSession } = setup({
      sessions: [{ id: 's1', title: 'Untitled', location: { directory: '/wt/feature/src' } }],
      worktrees: [{ path: '/repo' }, { path: '/wt/feature' }],
    });

    expect(await namer.name({ sessionId: 's1', title: 'Login fix' })).toEqual({ task: 'worktree', title: 'Login fix', named: true });
    expect(setWorktreeTaskTitle).toHaveBeenCalledWith('/wt/feature', { title: 'Login fix', by: 'agent' });
    expect(renameSession).not.toHaveBeenCalled();
  });

  it('names the root session of a main-checkout task, walking up from a review', async () => {
    const { namer, records, renameSession } = setup({
      sessions: [
        { id: 'root', title: 'Untitled', location: { directory: '/repo' } },
        { id: 'review', title: 'Review', location: { directory: '/repo' }, metadata: { openchamber: { kind: 'review', originalSessionID: 'root' } } },
      ],
    });

    expect(await namer.name({ sessionId: 'review', title: 'Sidebar rows' })).toEqual({ task: 'session', sessionId: 'root', title: 'Sidebar rows', named: true });
    expect(renameSession).toHaveBeenCalledWith('root', 'Sidebar rows', '/repo');
    expect(records.get('root').metadata.openchamber.workTitle).toEqual({ title: 'Sidebar rows', by: 'agent' });
  });

  it('keeps a name the user gave, by marker or by renaming after the agent', async () => {
    const byMarker = setup({
      sessions: [{ id: 's', title: 'Mine', location: { directory: '/repo' }, metadata: { openchamber: { workTitle: { title: 'Mine', by: 'user' } } } }],
    });
    expect(await byMarker.namer.name({ sessionId: 's', title: 'Agent' })).toMatchObject({ named: false, title: 'Mine' });
    expect(byMarker.renameSession).not.toHaveBeenCalled();

    const renamedLater = setup({
      sessions: [{ id: 's', title: 'Renamed', location: { directory: '/repo' }, metadata: { openchamber: { workTitle: { title: 'Agent', by: 'agent' } } } }],
    });
    expect(await renamedLater.namer.name({ sessionId: 's', title: 'Agent 2' })).toMatchObject({ named: false, title: 'Renamed' });
  });

  it('names a plain fork itself, not the session it forked from', async () => {
    const { namer, records, renameSession } = setup({
      sessions: [
        { id: 'root', title: 'Connect stall', location: { directory: '/repo' } },
        { id: 'fork', title: 'Connect stall (fork #1)', location: { directory: '/repo' }, fork: { sessionID: 'root' } },
      ],
    });

    expect(await namer.name({ sessionId: 'fork', title: 'Reconnect loop' })).toEqual({ task: 'session', sessionId: 'fork', title: 'Reconnect loop', named: true });
    expect(renameSession).toHaveBeenCalledWith('fork', 'Reconnect loop', '/repo');
    expect(records.get('root').title).toBe('Connect stall');
    expect(records.get('root').metadata).toBeUndefined();
  });

  it('walks from a /btw side conversation to the session it was typed into', async () => {
    const { namer, renameSession } = setup({
      sessions: [
        { id: 'parent', title: 'Connect stall', location: { directory: '/repo' } },
        { id: 'btw', title: 'Btw', location: { directory: '/repo' }, fork: { sessionID: 'parent' }, metadata: { openchamber: { kind: 'btw', originalSessionID: 'parent' } } },
      ],
    });

    expect(await namer.name({ sessionId: 'btw', title: 'Reconnect loop' })).toMatchObject({ sessionId: 'parent', named: true });
    expect(renameSession).toHaveBeenCalledWith('parent', 'Reconnect loop', '/repo');
  });

  it('walks from a promoted /btw session through its fork source', async () => {
    const { namer, renameSession } = setup({
      sessions: [
        { id: 'parent', title: 'Connect stall', location: { directory: '/repo' } },
        { id: 'promoted', title: 'Promoted', location: { directory: '/repo' }, fork: { sessionID: 'parent' }, metadata: { openchamber: { btwPromoted: true } } },
      ],
    });

    expect(await namer.name({ sessionId: 'promoted', title: 'Reconnect loop' })).toMatchObject({ sessionId: 'parent', named: true });
    expect(renameSession).toHaveBeenCalledWith('parent', 'Reconnect loop', '/repo');
  });

  it('names the run that spawned a subagent', async () => {
    const { namer, renameSession } = setup({
      sessions: [
        { id: 'parent', title: 'Connect stall', location: { directory: '/repo' } },
        { id: 'child', title: 'Explore the relay', location: { directory: '/repo' }, parentID: 'parent' },
      ],
    });

    expect(await namer.name({ sessionId: 'child', title: 'Reconnect loop' })).toMatchObject({ sessionId: 'parent', named: true });
    expect(renameSession).toHaveBeenCalledWith('parent', 'Reconnect loop', '/repo');
  });

  it('stops at a /btw origin in another folder', async () => {
    const { namer, renameSession } = setup({
      sessions: [
        { id: 'origin', title: 'Origin', location: { directory: '/elsewhere' } },
        { id: 'btw', title: 'Btw', location: { directory: '/repo' }, fork: { sessionID: 'origin' }, metadata: { openchamber: { kind: 'btw', originalSessionID: 'origin' } } },
      ],
    });

    expect(await namer.name({ sessionId: 'btw', title: 'Own task' })).toMatchObject({ sessionId: 'btw', named: true });
    expect(renameSession).toHaveBeenCalledWith('btw', 'Own task', '/repo');
  });

  it('refuses an empty title', async () => {
    const { namer, renameSession } = setup({
      sessions: [{ id: 's', title: 'Untitled', location: { directory: '/repo' } }],
    });

    await expect(namer.name({ sessionId: 's', title: '  ' })).rejects.toMatchObject({ status: 400 });
    expect(renameSession).not.toHaveBeenCalled();
  });

  describe('a placeholder branch', () => {
    const placeholderSetup = ({ placeholder }) => {
      const base = setup({
        sessions: [
          { id: 'wt', title: 'Untitled', location: { directory: '/wt/kinetic-zebra' } },
          { id: 'main', title: 'Untitled', location: { directory: '/repo' } },
        ],
        worktrees: [{ path: '/repo' }, { path: '/wt/kinetic-zebra' }],
      });
      const renamePlaceholderBranch = vi.fn(async (_directory, to) => ({ from: 'kinetic-zebra', to }));
      const namer = createWorkNamer({
        getSession: async (sessionID) => base.records.get(sessionID) ?? null,
        listWorktrees: async () => [{ path: '/repo' }, { path: '/wt/kinetic-zebra' }],
        setWorktreeTaskTitle: base.setWorktreeTaskTitle,
        readPlaceholderBranch: async () => (placeholder ? 'kinetic-zebra' : null),
        renamePlaceholderBranch,
        renameSession: base.renameSession,
        updateMetadata: base.updateMetadata,
        createError,
      });
      return { ...base, namer, renamePlaceholderBranch };
    };

    it('requires the branch, saying how, and names nothing without it', async () => {
      const { namer, setWorktreeTaskTitle } = placeholderSetup({ placeholder: true });
      await expect(namer.name({ sessionId: 'wt', title: 'pnpm detection' })).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('Call work.name again with both title and branch'),
      });
      expect(setWorktreeTaskTitle).not.toHaveBeenCalled();
    });

    it('renames it with the task and says so', async () => {
      const { namer, renamePlaceholderBranch } = placeholderSetup({ placeholder: true });
      expect(await namer.name({ sessionId: 'wt', title: 'pnpm detection', branch: 'fix/pnpm-detection' }))
        .toEqual({ task: 'worktree', title: 'pnpm detection', named: true, branch: 'fix/pnpm-detection', branchRenamed: true });
      expect(renamePlaceholderBranch).toHaveBeenCalledWith('/wt/kinetic-zebra', 'fix/pnpm-detection');
    });

    it('leaves any other branch alone, and says it did when one was passed', async () => {
      const { namer, renamePlaceholderBranch } = placeholderSetup({ placeholder: false });
      expect(await namer.name({ sessionId: 'wt', title: 'Task' })).toEqual({ task: 'worktree', title: 'Task', named: true });
      expect(await namer.name({ sessionId: 'wt', title: 'Task', branch: 'fix/x' })).toMatchObject({ named: true, branchRenamed: false });
      expect(await namer.name({ sessionId: 'main', title: 'Task', branch: 'fix/x' })).toMatchObject({ task: 'session', branchRenamed: false });
      expect(renamePlaceholderBranch).not.toHaveBeenCalled();
    });
  });
});

describe('carrying a task name into a new worktree', () => {
  it('names the worktree after the moved session, keeping who named it', async () => {
    const { namer, setWorktreeTaskTitle } = setup({
      sessions: [
        { id: 'agent', title: 'Login fix', metadata: { openchamber: { workTitle: { title: 'Login fix', by: 'agent' } } } },
        { id: 'renamed', title: 'My login fix', metadata: { openchamber: { workTitle: { title: 'Login fix', by: 'agent' } } } },
      ],
    });

    await namer.carryToWorktree({ sessionId: 'agent', worktree: '/wt/a' });
    await namer.carryToWorktree({ sessionId: 'renamed', worktree: '/wt/b' });

    expect(setWorktreeTaskTitle).toHaveBeenNthCalledWith(1, '/wt/a', { title: 'Login fix', by: 'agent' });
    expect(setWorktreeTaskTitle).toHaveBeenNthCalledWith(2, '/wt/b', { title: 'My login fix', by: 'user' });
  });

  it('leaves the worktree unnamed when nobody named the task', async () => {
    const { namer, setWorktreeTaskTitle } = setup({ sessions: [{ id: 's', title: 'New session - 2026-10-27' }] });

    expect(await namer.carryToWorktree({ sessionId: 's', worktree: '/wt/a' })).toBeNull();
    expect(setWorktreeTaskTitle).not.toHaveBeenCalled();
  });
});
