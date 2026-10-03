import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { relocateRestoredSessionIfDirectoryMissing } from './relocateRestoredSession';

const WORKTREE = '/worktrees/feature';
const PROJECT = '/projects/app';

const session = (id: string, overrides: Partial<Session> = {}): Session => ({
  id,
  projectID: 'app',
  title: id,
  directory: WORKTREE,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  ...overrides,
});

const setup = (options: {
  sessions: Session[];
  availability: Record<string, 'available' | 'missing' | 'unknown'>;
  projectRoot?: string | null;
  failMove?: boolean;
}) => {
  const moves: Array<{ id: string; from: string; to: string }> = [];
  const byId = new Map(options.sessions.map((entry) => [entry.id, entry]));
  return {
    moves,
    deps: {
      getSession: (id: string) => byId.get(id),
      getActiveSessions: () => options.sessions,
      getDirectoryAvailability: async (directory: string) => options.availability[directory] ?? 'unknown',
      resolveProjectRoot: () => (options.projectRoot === undefined ? PROJECT : options.projectRoot),
      moveSession: async (moved: Session, from: string, to: string) => {
        if (options.failMove) throw new Error('move rejected');
        moves.push({ id: moved.id, from, to });
      },
    },
  };
};

describe('relocateRestoredSessionIfDirectoryMissing', () => {
  test('a session whose folder still exists stays where it is', async () => {
    const { deps, moves } = setup({ sessions: [session('root')], availability: { [WORKTREE]: 'available', [PROJECT]: 'available' } });

    expect(await relocateRestoredSessionIfDirectoryMissing('root', deps)).toEqual({ outcome: 'kept' });
    expect(moves).toEqual([]);
  });

  test('an unknown answer is not proof the folder is gone', async () => {
    const { deps, moves } = setup({ sessions: [session('root')], availability: { [PROJECT]: 'available' } });

    expect(await relocateRestoredSessionIfDirectoryMissing('root', deps)).toEqual({ outcome: 'kept' });
    expect(moves).toEqual([]);
  });

  test('moves the session and its subsessions in that folder to the project root, deepest first', async () => {
    const sessions = [
      session('root'),
      session('child', { parentID: 'root' }),
      session('grandchild', { parentID: 'child' }),
      session('elsewhere', { parentID: 'root', directory: '/other' }),
    ];
    const { deps, moves } = setup({ sessions, availability: { [WORKTREE]: 'missing', [PROJECT]: 'available' } });

    expect(await relocateRestoredSessionIfDirectoryMissing('root', deps)).toEqual({ outcome: 'moved', projectRoot: PROJECT });
    expect(moves).toEqual([
      { id: 'grandchild', from: WORKTREE, to: PROJECT },
      { id: 'child', from: WORKTREE, to: PROJECT },
      { id: 'root', from: WORKTREE, to: PROJECT },
    ]);
  });

  test('without a known, existing project root nothing moves', async () => {
    const noProject = setup({ sessions: [session('root')], availability: { [WORKTREE]: 'missing' }, projectRoot: null });
    expect(await relocateRestoredSessionIfDirectoryMissing('root', noProject.deps)).toEqual({ outcome: 'kept' });

    const goneProject = setup({ sessions: [session('root')], availability: { [WORKTREE]: 'missing', [PROJECT]: 'missing' } });
    expect(await relocateRestoredSessionIfDirectoryMissing('root', goneProject.deps)).toEqual({ outcome: 'kept' });
    expect([...noProject.moves, ...goneProject.moves]).toEqual([]);
  });

  test('a rejected move is reported, not swallowed', async () => {
    const { deps } = setup({ sessions: [session('root')], availability: { [WORKTREE]: 'missing', [PROJECT]: 'available' }, failMove: true });

    const result = await relocateRestoredSessionIfDirectoryMissing('root', deps);
    expect(result.outcome).toBe('failed');
  });
});
