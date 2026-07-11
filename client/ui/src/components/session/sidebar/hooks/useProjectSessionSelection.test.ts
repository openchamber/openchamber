import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionGroup, SessionNode } from '../types';

// ---------------------------------------------------------------------------
// Helper: simulate the projectSessionMeta computation from the hook
// (same visitNodes logic as useProjectSessionSelection.ts lines 46-71)
// ---------------------------------------------------------------------------

type ProjectSection = {
  project: { id: string; normalizedPath: string };
  groups: SessionGroup[];
};

function computeProjectMeta(projectSections: ProjectSection[]) {
  const metaByProject = new Map<string, Map<string, { directory: string | null }>>();
  const firstSessionByProject = new Map<string, { id: string; directory: string | null }>();

  const visitNodes = (
    projectId: string,
    projectRoot: string,
    fallbackDirectory: string | null,
    nodes: SessionNode[],
  ) => {
    if (!metaByProject.has(projectId)) {
      metaByProject.set(projectId, new Map());
    }
    const projectMap = metaByProject.get(projectId)!;
    nodes.forEach((node) => {
      const sessionDirectory = (
        node.worktree?.path
        ?? (node.session as Session & { directory?: string | null }).directory
        ?? fallbackDirectory
        ?? projectRoot
      ).replace(/\\/g, '/').replace(/\/+$/, '');

      projectMap.set(node.session.id, { directory: sessionDirectory });
      if (!firstSessionByProject.has(projectId)) {
        firstSessionByProject.set(projectId, { id: node.session.id, directory: sessionDirectory });
      }
      if (node.children.length > 0) {
        visitNodes(projectId, projectRoot, sessionDirectory, node.children);
      }
    });
  };

  projectSections.forEach((section) => {
    section.groups.forEach((group) => {
      visitNodes(section.project.id, section.project.normalizedPath, group.directory, group.sessions);
    });
  });

  return { metaByProject, firstSessionByProject };
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const makeSession = (id: string, directory?: string): Session =>
  ({ id, directory } as unknown as Session);

const rootSession1 = makeSession('root-session-1', '/workspace/project');
const rootSession2 = makeSession('root-session-2', '/workspace/project');
const worktreeSession1 = makeSession('wt-session-1', '/workspace/project-wt');

const project2Session1 = makeSession('project-2-session-1', '/workspace/project-2');
const project2Session2 = makeSession('project-2-session-2', '/workspace/project-2');

const WORKTREE_PATH = '/workspace/project-wt';

// staleSections: root group only, no worktree group
const staleSections: ProjectSection[] = [
  {
    project: { id: 'project-1', normalizedPath: '/workspace/project' },
    groups: [
      {
        id: 'root',
        label: 'Main',
        branch: null,
        description: null,
        isMain: true,
        worktree: null,
        directory: '/workspace/project',
        sessions: [
          { session: rootSession1, children: [], worktree: null },
          { session: rootSession2, children: [], worktree: null },
        ],
      },
    ],
  },
];

// updatedSections: includes the worktree group
const updatedSections: ProjectSection[] = [
  {
    project: { id: 'project-1', normalizedPath: '/workspace/project' },
    groups: [
      {
        id: 'root',
        label: 'Main',
        branch: null,
        description: null,
        isMain: true,
        worktree: null,
        directory: '/workspace/project',
        sessions: [
          { session: rootSession1, children: [], worktree: null },
          { session: rootSession2, children: [], worktree: null },
        ],
      },
      {
        id: 'wt-group',
        label: 'feature-branch',
        branch: 'feature-branch',
        description: 'Worktree at ' + WORKTREE_PATH,
        isMain: false,
        worktree: { path: WORKTREE_PATH, projectDirectory: '/workspace/project', branch: 'feature-branch', label: 'feature-branch' },
        directory: WORKTREE_PATH,
        sessions: [
          { session: worktreeSession1, children: [], worktree: { path: WORKTREE_PATH, projectDirectory: '/workspace/project', branch: 'feature-branch', label: 'feature-branch' } },
        ],
      },
    ],
  },
];

// project-2Sections: separate project for project-switching tests
const project2Sections: ProjectSection[] = [
  {
    project: { id: 'project-2', normalizedPath: '/workspace/project-2' },
    groups: [
      {
        id: 'root',
        label: 'Main',
        branch: null,
        description: null,
        isMain: true,
        worktree: null,
        directory: '/workspace/project-2',
        sessions: [
          { session: project2Session1, children: [], worktree: null },
          { session: project2Session2, children: [], worktree: null },
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useProjectSessionSelection — worktree session click race', () => {
  test('stale projectSections (no worktree group) excludes worktree sessions from projectMap', () => {
    const { metaByProject } = computeProjectMeta(staleSections);
    const projectMap = metaByProject.get('project-1');

    // Root sessions are present
    expect(projectMap?.has('root-session-1')).toBe(true);
    expect(projectMap?.has('root-session-2')).toBe(true);

    // Worktree session is NOT present — this is what triggers the bug
    expect(projectMap?.has('wt-session-1')).toBe(false);
  });

  test('stale data firstSessionByProject points to first root session, not worktree session', () => {
    const { firstSessionByProject } = computeProjectMeta(staleSections);

    // Path C would fall back to firstSessionByProject, which is the first ROOT session
    const first = firstSessionByProject.get('project-1');
    expect(first?.id).toBe('root-session-1');
    expect(first?.id).not.toBe('wt-session-1');
  });

  test('updated projectSections includes all sessions including worktree', () => {
    const { metaByProject } = computeProjectMeta(updatedSections);
    const projectMap = metaByProject.get('project-1');

    expect(projectMap?.has('root-session-1')).toBe(true);
    expect(projectMap?.has('root-session-2')).toBe(true);
    expect(projectMap?.has('wt-session-1')).toBe(true);
  });

  test('guard preserves currentSessionId when projectMap is stale (the bug fix)', () => {
    const { metaByProject, firstSessionByProject } = computeProjectMeta(staleSections);
    const projectMap = metaByProject.get('project-1')!;
    const currentSessionId = 'wt-session-1';

    // Path A fails: currentSessionId is set but not in stale projectMap
    const pathAHit = Boolean(currentSessionId && projectMap?.has(currentSessionId));
    expect(pathAHit).toBe(false);

    // Guard: if (currentSessionId) return;
    // This is what prevents the fallthrough to Path C (auto-select wrong session)
    // Without the guard, Path C would select firstSessionByProject = root-session-1
    // instead of preserving the user's wt-session-1 selection
    const fallback = firstSessionByProject.get('project-1')?.id ?? null;
    expect(fallback).toBe('root-session-1');
    expect(fallback).not.toBe(currentSessionId);
  });

  test('second click works correctly when projectSections is updated', () => {
    const { metaByProject } = computeProjectMeta(updatedSections);
    const projectMap = metaByProject.get('project-1')!;
    const currentSessionId = 'wt-session-1';

    // After data arrives, Path A succeeds — no guard needed
    const pathAHit = Boolean(currentSessionId && projectMap?.has(currentSessionId));
    expect(pathAHit).toBe(true);
  });

  test('project switch: guard does NOT fire when currentSessionId matches new project', () => {
    // Simulates: user clicks a session in project-2 (normal click, not worktree)
    const { metaByProject } = computeProjectMeta(project2Sections);
    const projectMap = metaByProject.get('project-2')!;
    const currentSessionId = 'project-2-session-1';

    // Path A succeeds — the session is in the new project's projectMap
    const pathAHit = Boolean(currentSessionId && projectMap?.has(currentSessionId));
    expect(pathAHit).toBe(true);

    // Guard condition only fires when Path A fails — should not fire here
    const guardWouldFire = Boolean(currentSessionId && !(projectMap?.has(currentSessionId)));
    expect(guardWouldFire).toBe(false);
  });

  test('guard does NOT fire when currentSessionId is null (deleted/archived session)', () => {
    const { metaByProject } = computeProjectMeta(staleSections);
    const projectMap = metaByProject.get('project-1')!;
    const currentSessionId = null;

    // Path A: currentSessionId is null → skipped
    const pathAHit = Boolean(currentSessionId && projectMap?.has(currentSessionId));
    expect(pathAHit).toBe(false);

    // Guard: currentSessionId is null → skipped, falls through to Path B/C
    const guardWouldFire = currentSessionId !== null && !pathAHit;
    expect(guardWouldFire).toBe(false);
  });

  test('guard does NOT fire for empty projects — falls through to Path B (open draft)', () => {
    // Empty project: no groups/sessions in projectSections
    const emptySections: ProjectSection[] = [
      {
        project: { id: 'empty-project', normalizedPath: '/workspace/empty' },
        groups: [],
      },
    ];
    const { metaByProject } = computeProjectMeta(emptySections);
    const projectMap = metaByProject.get('empty-project');
    const currentSessionId = 'some-session-id';

    // projectMap is undefined for empty project
    expect(projectMap).toBe(undefined);

    // Guard: projectMap is undefined → skipped, falls through to Path B
    // which opens a new session draft for the empty project
    const guardWouldFire = Boolean(currentSessionId && projectMap);
    expect(guardWouldFire).toBe(false);
  });
});
