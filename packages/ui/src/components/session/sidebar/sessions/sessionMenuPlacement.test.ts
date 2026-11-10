import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import type { WorktreeMetadata } from '@/types/worktree';
import { collectNestedWorkInWork, resolveSessionMenuPlacement } from './sessionMenuPlacement';

const session = (id: string, directory: string, extra: Partial<Session> = {}): Session => ({
  id, title: id, directory, projectID: 'opencode-project', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  ...extra,
});

const inWork = { openchamber: { work: { state: 'open' } } };
const review = (originalSessionID: string, work = false) => ({
  openchamber: { kind: 'review', originalSessionID, ...(work ? { work: { state: 'open' } } : {}) },
});

const worktree = { path: '/repo-wt', projectDirectory: '/repo', branch: 'feature' } as WorktreeMetadata;

const placementOf = (target: Session, sessions: Session[] = [target]) => resolveSessionMenuPlacement(target, {
  projects: [{ id: 'project-a', path: '/repo' }],
  availableWorktreesByProject: new Map([['/repo', [worktree]]]),
  authoritativeProjects: [],
  spaces: [],
  isVSCode: false,
  activeSessions: sessions,
  resolveLegacyScope: (entry) => entry.directory ?? null,
  lookup: (id) => sessions.find((entry) => entry.id === id),
});

const RUN_ID = '0b6c2a52-6f5e-4c1b-9d55-3a7f0d1c9e01';
const runLane = (id: string, directory: string): Session => session(id, directory, {
  metadata: { openchamber: { multirun: {
    version: 1, sessionID: id, group: { kind: 'id', id: RUN_ID }, groupSlug: 'run',
    providerID: 'opencode', modelID: 'big-pickle', role: 'run',
  } } },
});

describe('resolveSessionMenuPlacement', () => {
  test('a root session of the project root is a work of its own, filed in the project', () => {
    expect(placementOf(session('root', '/repo'))).toEqual({ projectId: 'project-a', folderOwnerKey: 'project-a', ownsWork: true });
  });

  test('a session in a linked worktree files in the worktree and leaves Track / Done to it', () => {
    expect(placementOf(session('wt', '/repo-wt'))).toEqual({ projectId: 'project-a', folderOwnerKey: 'work:/repo-wt', ownsWork: false });
  });

  test('a review nested under its session belongs to that work', () => {
    const root = session('root', '/repo');
    const nested = session('review', '/repo', { metadata: review('root') });
    expect(placementOf(nested, [root, nested]).ownsWork).toBe(false);
  });

  test('a run lane leaves Track / Done to its run and files like the project root', () => {
    const lane = runLane('lane-a', '/repo-wt');
    expect(placementOf(lane, [lane, runLane('lane-b', '/repo')])).toEqual({ projectId: 'project-a', folderOwnerKey: 'project-a', ownsWork: false });
  });

  test('the survivor Keep leaves is an ordinary session again', () => {
    const rootSurvivor = runLane('lane-a', '/repo');
    expect(placementOf(rootSurvivor).ownsWork).toBe(true);
    const worktreeSurvivor = runLane('lane-b', '/repo-wt');
    expect(placementOf(worktreeSurvivor).folderOwnerKey).toBe('work:/repo-wt');
  });

  test('a session outside every project files nowhere', () => {
    expect(placementOf(session('loose', '/elsewhere'))).toEqual({ projectId: null, folderOwnerKey: null, ownsWork: true });
  });
});

describe('collectNestedWorkInWork', () => {
  test('Done reaches the nested reviews in work, not subagents', () => {
    const root = session('root', '/repo', { metadata: inWork });
    const nestedReview = session('review', '/repo', { metadata: review('root', true) });
    const subagent = session('sub', '/repo', { parentID: 'root', metadata: inWork });
    const other = session('other', '/repo', { metadata: inWork });
    expect(collectNestedWorkInWork(root, [root, nestedReview, subagent, other]).map((entry) => entry.id).sort())
      .toEqual(['review', 'root']);
  });

  test('a root that is not in work is in work through its nested review', () => {
    const root = session('root', '/repo');
    const nestedReview = session('review', '/repo', { metadata: review('root', true) });
    expect(collectNestedWorkInWork(root, [root, nestedReview]).map((entry) => entry.id)).toEqual(['review']);
  });
});
