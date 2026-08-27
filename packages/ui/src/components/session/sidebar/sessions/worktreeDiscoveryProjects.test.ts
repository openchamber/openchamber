import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import { selectWorktreeDiscoveryProjects } from './worktreeDiscoveryProjects';

describe('selectWorktreeDiscoveryProjects', () => {
  test('keeps the active project and projects that own active sessions', () => {
    const projects = [
      { id: 'active', path: '/projects/active' },
      { id: 'session-owner', path: '/projects/session-owner' },
      { id: 'inactive', path: '/projects/inactive' },
    ];
    const sessions = [
      { id: 'session', directory: '/projects/session-owner/src' },
    ] as unknown as Session[];

    const eligible = selectWorktreeDiscoveryProjects(
      projects,
      'active',
      sessions,
      new Map(),
    );

    expect(eligible.map((project) => project.id)).toEqual(['active', 'session-owner']);
  });

  test('keeps a project that owns a session in a known worktree', () => {
    const projects = [
      { id: 'active', path: '/projects/active' },
      { id: 'worktree-owner', path: '/projects/worktree-owner' },
      { id: 'inactive', path: '/projects/inactive' },
    ];
    const sessions = [
      { id: 'session', directory: '/worktrees/worktree-owner-feature/src' },
    ] as unknown as Session[];

    const eligible = selectWorktreeDiscoveryProjects(
      projects,
      'active',
      sessions,
      new Map([['/projects/worktree-owner', [{ path: '/worktrees/worktree-owner-feature' }]]]),
    );

    expect(eligible.map((project) => project.id)).toEqual(['active', 'worktree-owner']);
  });
});
