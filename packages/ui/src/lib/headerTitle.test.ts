import { describe, expect, test } from 'bun:test';

import type { ProjectEntry } from '@/lib/api/types';
import type { WorktreeMetadata } from '@/types/worktree';

import { deriveDesktopHeaderTitle } from './headerTitle';

const projects: ProjectEntry[] = [
  { id: 'parent', path: '/workspace', label: 'Workspace' },
  { id: 'app', path: '/workspace/app', label: 'App' },
  { id: 'other', path: '/workspace/other', label: 'Other' },
];

const baseOptions = {
  projects,
  availableWorktreesByProject: new Map<string, WorktreeMetadata[]>(),
  authoritativeDirectory: '/workspace/app',
  activeProjectId: 'app',
  isDraftOpen: false,
  draftProjectId: null,
  currentSessionId: 'session-1',
  currentSessionTitle: 'Fix header',
  draftTitle: 'New session',
  untitledTitle: 'Untitled session',
  productTitle: 'OpenChamber',
};

describe('deriveDesktopHeaderTitle', () => {
  test('prefixes an ordinary session with its directory project', () => {
    expect(deriveDesktopHeaderTitle(baseOptions)).toBe('App / Fix header');
  });

  test('uses the selected draft project', () => {
    expect(deriveDesktopHeaderTitle({
      ...baseOptions,
      authoritativeDirectory: null,
      isDraftOpen: true,
      draftProjectId: 'other',
    })).toBe('Other / New session');
  });

  test('prefers the selected draft project over the directory fallback', () => {
    expect(deriveDesktopHeaderTitle({
      ...baseOptions,
      isDraftOpen: true,
      draftProjectId: 'other',
    })).toBe('Other / New session');
  });

  test('keeps the selected draft project while directory topology is unresolved', () => {
    expect(deriveDesktopHeaderTitle({
      ...baseOptions,
      authoritativeDirectory: '/worktrees/not-hydrated-yet',
      isDraftOpen: true,
      draftProjectId: 'other',
    })).toBe('Other / New session');
  });

  test('uses the localized untitled session label', () => {
    expect(deriveDesktopHeaderTitle({
      ...baseOptions,
      currentSessionTitle: '   ',
    })).toBe('App / Untitled session');
  });

  test('falls back to the active project when no session directory exists', () => {
    expect(deriveDesktopHeaderTitle({
      ...baseOptions,
      authoritativeDirectory: null,
      currentSessionId: null,
      currentSessionTitle: null,
    })).toBe('App');
  });

  test('falls back to the product title when there is no project or session', () => {
    expect(deriveDesktopHeaderTitle({
      ...baseOptions,
      projects: [],
      authoritativeDirectory: null,
      activeProjectId: null,
      currentSessionId: null,
      currentSessionTitle: null,
    })).toBe('OpenChamber');
  });

  test('chooses the most specific nested project', () => {
    expect(deriveDesktopHeaderTitle({
      ...baseOptions,
      authoritativeDirectory: '/workspace/app/src',
      activeProjectId: 'parent',
    })).toBe('App / Fix header');
  });

  test('maps an external worktree to its owning project', () => {
    const externalWorktree = {
      path: '/worktrees/app-feature',
      projectDirectory: '/workspace/app',
    } as WorktreeMetadata;

    expect(deriveDesktopHeaderTitle({
      ...baseOptions,
      availableWorktreesByProject: new Map([['/workspace/app', [externalWorktree]]]),
      authoritativeDirectory: '/worktrees/app-feature/src',
      activeProjectId: 'other',
    })).toBe('App / Fix header');
  });

  test('does not use a stale active project for an unresolved directory', () => {
    expect(deriveDesktopHeaderTitle({
      ...baseOptions,
      authoritativeDirectory: '/worktrees/not-hydrated-yet',
      activeProjectId: 'other',
    })).toBe('Fix header');
  });

  test('does not use an active-project fallback for a session with only a guessed directory', () => {
    expect(deriveDesktopHeaderTitle({
      ...baseOptions,
      authoritativeDirectory: null,
      activeProjectId: 'other',
    })).toBe('Fix header');
  });
});
