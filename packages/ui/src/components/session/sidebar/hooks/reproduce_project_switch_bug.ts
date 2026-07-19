/**
 * Reproduction script for issue #2317
 *
 * Demonstrates that when switching from Project A to Project B:
 * - `currentSessionId` still holds Project A's session ID
 * - The "Path A'" guard (`if (currentSessionId && projectMap) return;`)
 *   fires because projectMap for Project B exists, preventing selection
 *   of Project B's remembered or fallback session.
 *
 * This script simulates the exact layout-effect logic from
 * useProjectSessionSelection.ts lines 84-151 without React.
 */

import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionGroup, SessionNode } from '../types';

// ---------------------------------------------------------------------------
// Same helper as in the test file
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
// Simulate the exact layout effect logic
// ---------------------------------------------------------------------------

/**
 * Simulates the layout effect from useProjectSessionSelection.ts lines 84-151.
 * Returns what the effect would do:
 * - 'return-early-Path-A' : currentSessionId is in projectMap → update activeSessionByProject
 * - 'return-early-Path-Aprime' : GUARD FIRES — currentSessionId is set but NOT in projectMap → return (BUG!)
 * - 'open-draft' : projectMap is empty/missing → open new session draft
 * - 'select-session' : select remembered or fallback session
 * - 'noop' : no action needed
 */
function simulateLayoutEffect(
  activeProjectId: string | null,
  currentSessionId: string | null,
  projectSections: ProjectSection[],
  activeSessionByProject: Map<string, string>,
): string {
  if (!activeProjectId) return 'noop';

  const section = projectSections.find((item) => item.project.id === activeProjectId);
  if (!section) return 'noop';

  const projectSessionMeta = computeProjectMeta(projectSections);
  const projectMap = projectSessionMeta.metaByProject.get(activeProjectId);

  // Path A — currentSessionId is in projectMap
  if (currentSessionId && projectMap && projectMap.has(currentSessionId)) {
    return 'return-early-Path-A';
  }

  // Path A' — GUARD: currentSessionId is set but not in projectMap (THiS IS THE BUG)
  if (currentSessionId && projectMap) {
    // THIS IS THE BUGGY RETURN — it prevents fallthrough to paths B and C
    return 'return-early-Path-Aprime';
  }

  // Path B — empty project, open draft
  if (!projectMap || projectMap.size === 0) {
    return 'open-draft';
  }

  // Path C — select remembered or fallback session
  const rememberedSessionId = activeSessionByProject.get(activeProjectId);
  const remembered = rememberedSessionId && projectMap.has(rememberedSessionId)
    ? rememberedSessionId
    : null;
  const fallback = projectSessionMeta.firstSessionByProject.get(activeProjectId)?.id ?? null;
  const targetSessionId = remembered ?? fallback;
  if (!targetSessionId || targetSessionId === currentSessionId) {
    return 'noop';
  }
  return 'select-session';
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const makeSession = (id: string): Session =>
  ({ id } as unknown as Session);

// Project A has sessions
const projectASession1 = makeSession('project-a-session-1');
const projectASession2 = makeSession('project-a-session-2');

const projectASections: ProjectSection[] = [
  {
    project: { id: 'project-a', normalizedPath: '/workspace/project-a' },
    groups: [
      {
        id: 'root',
        label: 'Main',
        branch: null,
        description: null,
        isMain: true,
        worktree: null,
        directory: '/workspace/project-a',
        sessions: [
          { session: projectASession1, children: [], worktree: null },
          { session: projectASession2, children: [], worktree: null },
        ],
      },
    ],
  },
];

// Project B has sessions
const projectBSession1 = makeSession('project-b-session-1');
const projectBSession2 = makeSession('project-b-session-2');

const projectBSections: ProjectSection[] = [
  {
    project: { id: 'project-b', normalizedPath: '/workspace/project-b' },
    groups: [
      {
        id: 'root',
        label: 'Main',
        branch: null,
        description: null,
        isMain: true,
        worktree: null,
        directory: '/workspace/project-b',
        sessions: [
          { session: projectBSession1, children: [], worktree: null },
          { session: projectBSession2, children: [], worktree: null },
        ],
      },
    ],
  },
];

// Combined sections (what projectSections looks like after switching)
const combinedSections: ProjectSection[] = [...projectASections, ...projectBSections];

// ---------------------------------------------------------------------------
// Test: Demonstrate bug #2317 — project switch preserves wrong session
// ---------------------------------------------------------------------------

describe('Reproduce issue #2317 — project switch preserves wrong session', () => {
  test('Setup: Project A has sessions and Project B has sessions', () => {
    const metaA = computeProjectMeta(projectASections);
    const metaB = computeProjectMeta(projectBSections);
    const metaCombined = computeProjectMeta(combinedSections);

    expect(metaA.metaByProject.get('project-a')?.has('project-a-session-1')).toBe(true);
    expect(metaA.metaByProject.get('project-a')?.has('project-a-session-2')).toBe(true);

    expect(metaB.metaByProject.get('project-b')?.has('project-b-session-1')).toBe(true);
    expect(metaB.metaByProject.get('project-b')?.has('project-b-session-2')).toBe(true);

    expect(metaCombined.metaByProject.get('project-a')?.has('project-a-session-1')).toBe(true);
    expect(metaCombined.metaByProject.get('project-b')?.has('project-b-session-1')).toBe(true);
  });

  test('BUG: Switching to Project B with stale currentSessionId triggers Path A\' guard', () => {
    // Simulate the state right after switching from Project A to Project B:
    // - activeProjectId is now 'project-b'
    // - currentSessionId still holds 'project-a-session-1' (from Project A)
    const activeProjectId = 'project-b';
    const currentSessionId = 'project-a-session-1';
    const activeSessionByProject = new Map<string, string>([
      ['project-a', 'project-a-session-1'],
    ]);

    const result = simulateLayoutEffect(
      activeProjectId,
      currentSessionId,
      combinedSections,
      activeSessionByProject,
    );

    // The BUG: the guard at Path A' returns early because currentSessionId
    // (from Project A) is truthy AND projectMap for Project B exists.
    // This prevents selecting Project B's remembered or fallback session.
    expect(result).toBe('return-early-Path-Aprime');
    // ^^^ If this hits, the bug is reproduced: the effect returns early
    //     without ever selecting a Project B session.
  });

  test('Evidence: Project B remembered session is never selected due to guard', () => {
    // Same scenario but we verify what would happen if the guard didn't exist.
    // The remembered session for Project B should be selected.
    const activeProjectId = 'project-b';
    const currentSessionId = 'project-a-session-1';
    const activeSessionByProject = new Map<string, string>([
      ['project-a', 'project-a-session-1'],
      ['project-b', 'project-b-session-2'],  // Project B has a remembered session
    ]);

    const result = simulateLayoutEffect(
      activeProjectId,
      currentSessionId,
      combinedSections,
      activeSessionByProject,
    );

    // Bug: guard fires, no session selection happens
    expect(result).toBe('return-early-Path-Aprime');
    // The expected correct behavior would be 'select-session' which would
    // pick project-b-session-2 as the remembered session.
  });

  test('Workaround: Explicitly clicking a Project B session avoids the bug', () => {
    // When the user explicitly clicks a Project B session, both
    // activeProjectId and currentSessionId point to Project B.
    const activeProjectId = 'project-b';
    const currentSessionId = 'project-b-session-1';
    const activeSessionByProject = new Map<string, string>([
      ['project-a', 'project-a-session-1'],
    ]);

    const result = simulateLayoutEffect(
      activeProjectId,
      currentSessionId,
      combinedSections,
      activeSessionByProject,
    );

    // Path A succeeds because currentSessionId is in Project B's projectMap
    expect(result).toBe('return-early-Path-A');
  });

  test('Correct behavior: Current session IS valid for current project (no switch)', () => {
    // When no project switch occurs, the session is valid
    const activeProjectId = 'project-a';
    const currentSessionId = 'project-a-session-1';
    const activeSessionByProject = new Map<string, string>([
      ['project-a', 'project-a-session-1'],
    ]);

    const result = simulateLayoutEffect(
      activeProjectId,
      currentSessionId,
      projectASections,
      activeSessionByProject,
    );

    // Path A succeeds — currentSessionId is in project-a's projectMap
    expect(result).toBe('return-early-Path-A');
  });
});
