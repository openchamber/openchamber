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

  it('stops at an origin in another folder and refuses an empty title', async () => {
    const { namer, renameSession } = setup({
      sessions: [
        { id: 'origin', title: 'Origin', location: { directory: '/elsewhere' } },
        { id: 'fork', title: 'Fork', location: { directory: '/repo' }, fork: { sessionID: 'origin' } },
      ],
    });
    expect(await namer.name({ sessionId: 'fork', title: 'Own task' })).toMatchObject({ sessionId: 'fork', named: true });
    expect(renameSession).toHaveBeenCalledWith('fork', 'Own task', '/repo');
    await expect(namer.name({ sessionId: 'fork', title: '  ' })).rejects.toMatchObject({ status: 400 });
  });
});
