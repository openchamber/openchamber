import { describe, expect, it, vi } from 'vitest';
import { createWorkNamer, linkedWorktreeOf } from './work-naming.js';

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
  it('uses linked topology for naming eligibility, including nested and Windows directories', () => {
    const checkouts = [{ path: '/repo' }, { path: '/repo/linked' }];
    expect(linkedWorktreeOf('/repo', checkouts)).toBeNull();
    expect(linkedWorktreeOf('/repo/src', checkouts)).toBeNull();
    expect(linkedWorktreeOf('/plain', checkouts)).toBeNull();
    expect(linkedWorktreeOf('/repo/linked/src/', checkouts)).toBe('/repo/linked');
    expect(linkedWorktreeOf('/repo/linked-other', checkouts)).toBeNull();
    expect(linkedWorktreeOf('C:\\wt\\src', [{ path: 'C:\\repo' }, { path: 'C:\\wt' }])).toBe('C:\\wt');
  });
  it('names a linked worktree through its branch', async () => {
    const { namer, setWorktreeTaskTitle, renameSession } = setup({
      sessions: [{ id: 's1', title: 'Untitled', location: { directory: '/wt/feature/src' } }],
      worktrees: [{ path: '/repo' }, { path: '/wt/feature' }],
    });

    expect(await namer.name({ sessionId: 's1', title: 'Login fix' })).toEqual({ task: 'worktree', title: 'Login fix', named: true });
    expect(setWorktreeTaskTitle).toHaveBeenCalledWith('/wt/feature', { title: 'Login fix', by: 'agent' });
    expect(renameSession).not.toHaveBeenCalled();
  });

  it('never renames a main-checkout session or its review origin', async () => {
    const { namer, records, renameSession, updateMetadata } = setup({
      sessions: [
        { id: 'root', title: 'Untitled', location: { directory: '/repo' } },
        { id: 'review', title: 'Review', location: { directory: '/repo' }, metadata: { openchamber: { kind: 'review', originalSessionID: 'root' } } },
      ],
    });

    expect(await namer.name({ sessionId: 'review', title: 'Sidebar rows' })).toMatchObject({ task: 'session', sessionId: 'review', title: 'Review', named: false, reason: expect.stringContaining('Nothing needs naming') });
    expect(renameSession).not.toHaveBeenCalled();
    expect(updateMetadata).not.toHaveBeenCalled();
    expect(records.get('root').title).toBe('Untitled');
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

  it('keeps forks and plain-folder sessions unchanged and refuses an empty title', async () => {
    const { namer, renameSession } = setup({
      sessions: [
        { id: 'origin', title: 'Origin', location: { directory: '/elsewhere' } },
        { id: 'fork', title: 'Fork', location: { directory: '/plain-folder' }, fork: { sessionID: 'origin' } },
      ],
    });
    expect(await namer.name({ sessionId: 'fork', title: 'Own task' })).toMatchObject({ sessionId: 'fork', title: 'Fork', named: false });
    expect(renameSession).not.toHaveBeenCalled();
    await expect(namer.name({ sessionId: 'fork', title: '  ' })).rejects.toMatchObject({ status: 400 });
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
    expect(setWorktreeTaskTitle).toHaveBeenNthCalledWith(2, '/wt/b', { title: 'My login fix', by: 'agent' });
  });

  it('carries generated session titles as agent-owned without requiring metadata', async () => {
    const { namer, setWorktreeTaskTitle } = setup({ sessions: [{ id: 's', title: 'New session - 2026-10-27' }] });

    await namer.carryToWorktree({ sessionId: 's', worktree: '/wt/a' });
    expect(setWorktreeTaskTitle).toHaveBeenCalledWith('/wt/a', { title: 'New session - 2026-10-27', by: 'agent' });
  });

  it('preserves explicit user ownership and skips a missing session', async () => {
    const { namer, setWorktreeTaskTitle } = setup({ sessions: [
      { id: 's', title: 'Mine now', metadata: { openchamber: { workTitle: { title: 'Mine', by: 'user' } } } },
    ] });
    await namer.carryToWorktree({ sessionId: 's', worktree: '/wt/a' });
    expect(setWorktreeTaskTitle).toHaveBeenCalledWith('/wt/a', { title: 'Mine now', by: 'user' });
    expect(await namer.carryToWorktree({ sessionId: 'missing', worktree: '/wt/a' })).toBeNull();
  });
});
