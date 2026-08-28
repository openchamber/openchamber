import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import { isProjectEligibleForBackgroundDiscovery, selectWorktreeDiscoveryProjects } from './worktreeDiscoveryProjects';

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

  test('uses exact directory ownership for VS Code sessions', () => {
    const projects = [
      { id: 'active', path: '/projects/active' },
      { id: 'session-owner', path: '/projects/session-owner' },
      { id: 'nested', path: '/projects/nested' },
    ];
    const sessions = [
      { id: 'session', directory: '/projects/session-owner' },
    ] as unknown as Session[];

    const eligible = selectWorktreeDiscoveryProjects(
      projects,
      'active',
      sessions,
      new Map(),
      true,
    );

    expect(eligible.map((project) => project.id)).toEqual(['active', 'session-owner']);
  });

  test('drops a collapsed project whose sessions are only historical', () => {
    const projects = [
      { id: 'active', path: '/projects/active' },
      { id: 'collapsed', path: '/projects/collapsed', sidebarCollapsed: true },
    ];
    const sessions = [
      { id: 'historical', directory: '/projects/collapsed/src' },
    ] as unknown as Session[];

    const eligible = selectWorktreeDiscoveryProjects(
      projects,
      'active',
      sessions,
      new Map(),
      false,
      new Set(),
    );

    expect(eligible.map((project) => project.id)).toEqual(['active']);
  });

  test('keeps a collapsed project that owns a live session', () => {
    const projects = [
      { id: 'active', path: '/projects/active' },
      { id: 'collapsed', path: '/projects/collapsed', sidebarCollapsed: true },
    ];
    const sessions = [
      { id: 'historical', directory: '/projects/collapsed/src' },
      { id: 'live', directory: '/projects/collapsed/src' },
    ] as unknown as Session[];

    const eligible = selectWorktreeDiscoveryProjects(
      projects,
      'active',
      sessions,
      new Map(),
      false,
      new Set(['live']),
    );

    expect(eligible.map((project) => project.id)).toEqual(['active', 'collapsed']);
  });

  test('keeps the active project even when it is collapsed and owns no session', () => {
    const projects = [
      { id: 'active', path: '/projects/active', sidebarCollapsed: true },
      { id: 'collapsed', path: '/projects/collapsed', sidebarCollapsed: true },
    ];

    const eligible = selectWorktreeDiscoveryProjects(
      projects,
      'active',
      [],
      new Map(),
      false,
      new Set(),
    );

    expect(eligible.map((project) => project.id)).toEqual(['active']);
  });

  test('keeps an expanded project that owns only historical sessions', () => {
    const projects = [
      { id: 'active', path: '/projects/active' },
      { id: 'expanded', path: '/projects/expanded', sidebarCollapsed: false },
    ];
    const sessions = [
      { id: 'historical', directory: '/projects/expanded/src' },
    ] as unknown as Session[];

    const eligible = selectWorktreeDiscoveryProjects(
      projects,
      'active',
      sessions,
      new Map(),
      false,
      new Set(),
    );

    expect(eligible.map((project) => project.id)).toEqual(['active', 'expanded']);
  });
});

describe('isProjectEligibleForBackgroundDiscovery', () => {
  const sessionsByProject = new Map([
    ['collapsed', [{ id: 'historical' }, { id: 'live' }] as unknown as Session[]],
    ['expanded', [{ id: 'historical' }] as unknown as Session[]],
  ]);

  test('excludes a collapsed project without a live session', () => {
    expect(isProjectEligibleForBackgroundDiscovery(
      { id: 'collapsed', sidebarCollapsed: true },
      { activeProjectId: 'active', sessionsByProject, liveSessionIds: new Set() },
    )).toBe(false);
  });

  test('includes a collapsed project with a live session', () => {
    expect(isProjectEligibleForBackgroundDiscovery(
      { id: 'collapsed', sidebarCollapsed: true },
      { activeProjectId: 'active', sessionsByProject, liveSessionIds: new Set(['live']) },
    )).toBe(true);
  });

  test('includes an expanded project that owns a session', () => {
    expect(isProjectEligibleForBackgroundDiscovery(
      { id: 'expanded', sidebarCollapsed: true },
      { activeProjectId: 'active', sessionsByProject, liveSessionIds: new Set() },
    )).toBe(false);
    expect(isProjectEligibleForBackgroundDiscovery(
      { id: 'expanded', sidebarCollapsed: false },
      { activeProjectId: 'active', sessionsByProject, liveSessionIds: new Set() },
    )).toBe(true);
  });

  test('excludes an expanded project that owns no session', () => {
    expect(isProjectEligibleForBackgroundDiscovery(
      { id: 'idle', sidebarCollapsed: false },
      { activeProjectId: 'active', sessionsByProject, liveSessionIds: new Set() },
    )).toBe(false);
  });

  test('includes the active project regardless of collapse or session ownership', () => {
    expect(isProjectEligibleForBackgroundDiscovery(
      { id: 'active', sidebarCollapsed: true },
      { activeProjectId: 'active', sessionsByProject, liveSessionIds: new Set() },
    )).toBe(true);
  });
});
