import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import {
  createSessionOwnershipIndex,
  type SessionOwnershipRecord,
} from './sessionOwnership';

const ownershipSession = (
  id: string,
  options: {
    directory?: string;
    projectID?: string;
    project?: { id?: string; worktree?: string };
  } = {},
): SessionOwnershipRecord => ({
  id,
  slug: id,
  projectID: options.projectID ?? options.project?.id ?? 'project',
  directory: options.directory ?? '/workspace',
  title: id,
  version: '1',
  time: { created: 1, updated: 1 },
  project: options.project,
});

describe('createSessionOwnershipIndex', () => {
  test('assigns sessions to the deepest project and registered worktree', () => {
    const sessions = [
      { id: 'nested', directory: '/projects/app/packages/admin/src' },
      { id: 'external-worktree', directory: '/worktrees/app-feature/src' },
      { id: 'worktree-fallback', project: { worktree: '/worktrees/app-feature/src' } },
      { id: 'directory-wins', directory: '/projects/app/packages/admin', project: { worktree: '/projects/app' } },
      { id: 'windows', directory: 'c:\\Projects\\App\\src' },
      { id: 'unassigned', directory: '/elsewhere' },
    ] as unknown as Session[];
    const projects = [
      { id: 'app', normalizedPath: '/projects/app' },
      { id: 'admin', normalizedPath: '/projects/app/packages/admin' },
      { id: 'windows-app', normalizedPath: 'C:/Projects/App' },
    ];
    const worktrees = new Map([
      ['/projects/app', [{ path: '/worktrees/app-feature' }]],
    ]);

    const ownership = createSessionOwnershipIndex(sessions, projects, worktrees, false);

    expect(ownership.bySessionId.get('nested')?.projectId).toBe('admin');
    expect(ownership.bySessionId.get('external-worktree')).toEqual({
      projectId: 'app',
      projectRoot: '/projects/app',
      scopeDirectory: '/worktrees/app-feature',
      kind: 'worktree',
    });
    expect(ownership.bySessionId.get('worktree-fallback')?.scopeDirectory).toBe('/worktrees/app-feature');
    expect(ownership.bySessionId.get('directory-wins')?.projectId).toBe('admin');
    expect(ownership.bySessionId.get('windows')?.projectId).toBe('windows-app');
    expect(ownership.bySessionId.has('unassigned')).toBe(false);
    expect(ownership.sessionsByProject.get('admin')?.map((session) => session.id)).toEqual([
      'nested',
      'directory-wins',
    ]);
    expect(ownership.sessionsByScope.get('/worktrees/app-feature')).toEqual(new Set([
      'external-worktree',
      'worktree-fallback',
    ]));
  });

  test('gives an exact project precedence over a colliding worktree', () => {
    const ownership = createSessionOwnershipIndex(
      [{ id: 'nested', directory: '/projects/app/packages/admin/src' } as Session],
      [
        { id: 'app', normalizedPath: '/projects/app' },
        { id: 'admin', normalizedPath: '/projects/app/packages/admin' },
      ],
      new Map([['/projects/app', [{ path: '/projects/app/packages/admin' }]]]),
      false,
    );

    expect(ownership.bySessionId.get('nested')?.projectId).toBe('admin');
    expect(ownership.bySessionId.get('nested')?.kind).toBe('project');
  });

  test('indexes archived sessions separately', () => {
    const ownership = createSessionOwnershipIndex(
      [],
      [{ id: 'app', normalizedPath: '/projects/app' }],
      new Map([['/projects/app', [{ path: '/worktrees/app-feature' }]]]),
      false,
      [
        { id: 'archived-child', directory: '/worktrees/app-feature/src', time: { archived: 1 } },
        { id: 'archived-fallback', project: { worktree: '/worktrees/app-feature' }, time: { archived: 1 } },
      ] as unknown as Session[],
    );

    expect(ownership.archivedSessionsByProject.get('app')?.map((session) => session.id)).toEqual([
      'archived-child',
      'archived-fallback',
    ]);
  });

  test('requires exact workspace directories in VS Code', () => {
    const ownership = createSessionOwnershipIndex(
      [
        { id: 'workspace', directory: '/projects/app' },
        { id: 'nested', directory: '/projects/app/packages/ui' },
      ] as Session[],
      [{ id: 'app', normalizedPath: '/projects/app' }],
      new Map(),
      true,
    );

    expect(ownership.bySessionId.get('workspace')?.projectId).toBe('app');
    expect(ownership.bySessionId.has('nested')).toBe(false);
  });

  test('resolves a deleted directory through canonical OpenCode project metadata', () => {
    const ownership = createSessionOwnershipIndex(
      [
        ownershipSession('restored', { projectID: 'opencode-app', directory: '/deleted/worktrees/feature' }),
        ownershipSession('canonical', { projectID: 'opencode-app', project: { id: 'opencode-app', worktree: '/projects/app' } }),
      ],
      [{ id: 'configured-app', normalizedPath: '/projects/app' }],
      new Map([['/projects/app', [{ path: '/worktrees/feature' }]]]),
      false,
    );

    expect(ownership.bySessionId.get('restored')).toEqual({
      projectId: 'configured-app',
      projectRoot: '/projects/app',
      scopeDirectory: '/projects/app',
      kind: 'project',
    });
  });

  test('resolves a bare session projectID from authoritative global project metadata', () => {
    const ownership = createSessionOwnershipIndex(
      [ownershipSession('restored', { projectID: 'opencode-app', directory: '/deleted/worktrees/feature' })],
      [{ id: 'configured-app', normalizedPath: '/projects/app' }],
      new Map(),
      false,
      [],
      [{ id: 'opencode-app', worktree: '/projects/app' }],
    );

    expect(ownership.bySessionId.get('restored')?.projectId).toBe('configured-app');
  });

  test('prefers authoritative project metadata over conflicting embedded metadata', () => {
    const ownership = createSessionOwnershipIndex(
      [ownershipSession('restored', {
        projectID: 'opencode-app',
        directory: '/deleted/worktrees/feature',
        project: { id: 'opencode-app', worktree: '/projects/embedded' },
      })],
      [
        { id: 'configured-authoritative', normalizedPath: '/projects/authoritative' },
        { id: 'configured-embedded', normalizedPath: '/projects/embedded' },
      ],
      new Map(),
      false,
      [],
      [{ id: 'opencode-app', worktree: '/projects/authoritative' }],
    );

    expect(ownership.bySessionId.get('restored')?.projectId).toBe('configured-authoritative');
  });

  test('leaves conflicting embedded canonical roots unassigned', () => {
    const ownership = createSessionOwnershipIndex(
      [
        ownershipSession('restored', { projectID: 'opencode-app', directory: '/deleted/worktree' }),
        ownershipSession('metadata-one', { project: { id: 'opencode-app', worktree: '/projects/one' } }),
        ownershipSession('metadata-two', { project: { id: 'opencode-app', worktree: '/projects/two' } }),
      ],
      [
        { id: 'configured-one', normalizedPath: '/projects/one' },
        { id: 'configured-two', normalizedPath: '/projects/two' },
      ],
      new Map(),
      false,
    );

    expect(ownership.bySessionId.has('restored')).toBe(false);
  });

  test('keeps deleted-directory sessions unassigned without a canonical configured root', () => {
    const ownership = createSessionOwnershipIndex(
      [ownershipSession('restored', {
        projectID: 'opencode-app',
        directory: '/deleted/worktrees/feature',
        project: { id: 'opencode-app', worktree: '/deleted/worktrees/feature' },
      })],
      [{ id: 'configured-app', normalizedPath: '/projects/app' }],
      new Map(),
      false,
    );

    expect(ownership.bySessionId.has('restored')).toBe(false);
  });

  test('prefers exact topology over OpenCode project metadata fallback', () => {
    const ownership = createSessionOwnershipIndex(
      [
        ownershipSession('worktree', { projectID: 'opencode-app', directory: '/worktrees/app-feature' }),
        ownershipSession('canonical', { project: { id: 'opencode-app', worktree: '/projects/app' } }),
      ],
      [{ id: 'configured-app', normalizedPath: '/projects/app' }],
      new Map([['/projects/app', [{ path: '/worktrees/app-feature' }]]]),
      false,
    );

    expect(ownership.bySessionId.get('worktree')?.scopeDirectory).toBe('/worktrees/app-feature');
    expect(ownership.bySessionId.get('worktree')?.kind).toBe('worktree');
  });

  test('supports a Windows drive root project', () => {
    const ownership = createSessionOwnershipIndex(
      [{ id: 'windows-root', directory: 'c:\\Users\\name\\project' } as Session],
      [{ id: 'drive', normalizedPath: 'C:/' }],
      new Map(),
      false,
    );

    expect(ownership.bySessionId.get('windows-root')?.projectId).toBe('drive');
    expect(ownership.bySessionId.get('windows-root')?.scopeDirectory).toBe('C:/');
  });

  test('resolves report-sized data once instead of once per project consumer', () => {
    const projects = Array.from({ length: 15 }, (_, index) => ({
      id: `project-${index}`,
      normalizedPath: `/projects/${index}`,
    }));
    const worktrees = new Map(projects.map((project, projectIndex) => [
      project.normalizedPath,
      Array.from({ length: projectIndex < 7 ? 5 : 4 }, (_, index) => ({
        path: `/worktrees/${projectIndex}/${index}`,
      })),
    ]));
    const sessions = Array.from({ length: 14_561 }, (_, index) => ({
      id: `session-${index}`,
      directory: `/worktrees/${index % 15}/${index % 4}/session/${index}`,
    })) as unknown as Session[];

    const ownership = createSessionOwnershipIndex(sessions, projects, worktrees, false);

    expect(ownership.bySessionId.size).toBe(14_561);
    expect(ownership.directoryResolutions).toBeLessThan(14_561 * 2);
    expect([...ownership.sessionsByProject.values()].reduce((total, bucket) => total + bucket.length, 0)).toBe(14_561);
  });
});
