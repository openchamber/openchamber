import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import type { ProjectEntry } from '@/lib/api/types';
import {
  deriveProjectLabelFromPath,
  resolveProjectsWithNoActiveSessions,
} from './projectResolution';

const projects = [
  { id: 'parent', path: '/workspace/MyProject' },
  { id: 'nested', path: '/workspace/MyProject/packages/nested' },
] as ProjectEntry[];

const session = (id: string, directory: string): Session => ({
  id,
  directory,
  time: { created: 1, updated: 1 },
} as Session);

describe('deriveProjectLabelFromPath', () => {
  test('formats folder names by default', () => {
    expect(deriveProjectLabelFromPath('/workspace/my_PROJECT')).toBe('My PROJECT');
  });

  test('preserves the exact folder basename when requested', () => {
    expect(deriveProjectLabelFromPath('/workspace/my_PROJECT', true)).toBe('my_PROJECT');
  });
});

describe('resolveProjectsWithNoActiveSessions', () => {
  test('returns a changed project after its last active session is removed', () => {
    expect(resolveProjectsWithNoActiveSessions(projects, new Map(), [], ['/workspace/MyProject']))
      .toEqual([projects[0]]);
  });

  test('keeps a project open while it has another active session', () => {
    const activeSessions = [session('remaining', '/workspace/MyProject')];
    expect(resolveProjectsWithNoActiveSessions(projects, new Map(), activeSessions, ['/workspace/MyProject']))
      .toEqual([]);
  });

  test('uses deepest project ownership for nested projects', () => {
    const activeSessions = [session('parent-session', '/workspace/MyProject')];
    expect(resolveProjectsWithNoActiveSessions(
      projects,
      new Map(),
      activeSessions,
      ['/workspace/MyProject/packages/nested'],
    )).toEqual([projects[1]]);
  });

  test('resolves sessions in registered worktrees to their project', () => {
    const worktrees = new Map([
      ['/workspace/MyProject', [{
        path: '/tmp/my-project-feature',
        projectDirectory: '/workspace/MyProject',
        branch: 'feature',
        label: 'feature',
      }]],
    ]);
    const activeSessions = [session('worktree-session', '/tmp/my-project-feature')];
    expect(resolveProjectsWithNoActiveSessions(
      projects,
      worktrees,
      activeSessions,
      ['/tmp/my-project-feature'],
    )).toEqual([]);
  });

  test('keeps a root project open while it has an active descendant session', () => {
    const rootProject = { id: 'root', path: '/' } as ProjectEntry;
    expect(resolveProjectsWithNoActiveSessions(
      [rootProject],
      new Map(),
      [session('root-session', '/workspace/project')],
      ['/workspace/project'],
    )).toEqual([]);
  });
});
