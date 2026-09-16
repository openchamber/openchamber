import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Session } from '@opencode-ai/sdk/v2';
import { getSessionFolderIdentityKey } from '@/lib/sessionFolderIdentity';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import type { SessionOwnershipIndex } from '../sessions/sessionOwnership';
import { createSessionOwnershipIndex } from '../sessions/sessionOwnership';
import { installHookTestDom } from '../test-utils/testDom';

const { useArchivedAutoFolders } = await import('./useArchivedAutoFolders');

const project = { id: 'project', normalizedPath: '/workspace' };
const projects = [project];
const worktrees = new Map([['/workspace', [{ path: '/workspace/feature' }]]]);

// SAFETY: this fixture supplies every Session field consumed by ownership and
// archived-folder projection logic; other SDK fields are irrelevant here.
const makeSession = (id: string, directory: string, archived: boolean): Session => ({
  id,
  slug: id,
  projectID: project.id,
  title: id,
  version: '1',
  directory,
  time: archived
    ? { created: 1, updated: 1, archived: 1 }
    : { created: 1, updated: 1 },
} as Session);

const makeOwnership = (active: Session[], archived: Session[]): SessionOwnershipIndex => (
  createSessionOwnershipIndex(active, projects, worktrees, false, archived)
);

const createFolderCalls: unknown[][] = [];
const createFolder = (scopeKey: string, name: string, parentId?: string | null) => {
  createFolderCalls.push([scopeKey, name, parentId]);
  return { id: 'unused', name: 'unused', sessionIds: [] };
};
const addSessionToFolderCalls: unknown[][] = [];
const addSessionToFolder = (scopeKey: string, folderId: string, sessionId: string): void => {
  addSessionToFolderCalls.push([scopeKey, folderId, sessionId]);
};

type ProbeProps = {
  ownership: SessionOwnershipIndex;
  enabled?: boolean;
  isSessionsLoading?: boolean;
  hasAuthoritativeGlobalSessions?: boolean;
  isWorktreeTopologyLoading?: boolean;
  unresolvedWorktreeProjectPaths?: ReadonlySet<string>;
  revision?: number;
};

const Probe: React.FC<ProbeProps> = ({
  ownership,
  enabled = true,
  isSessionsLoading = false,
  hasAuthoritativeGlobalSessions = true,
  isWorktreeTopologyLoading = false,
  unresolvedWorktreeProjectPaths = new Set(),
  revision = 0,
}) => {
  const foldersMap = useSessionFoldersStore((state) => state.foldersMap);
  useArchivedAutoFolders({
    enabled,
    normalizedProjects: projects,
    ownership,
    isSessionsLoading,
    hasAuthoritativeGlobalSessions,
    isWorktreeTopologyLoading,
    unresolvedWorktreeProjectPaths,
    foldersMap,
    createFolder,
    addSessionToFolder,
  });
  return React.createElement('span', null, revision);
};

describe('useArchivedAutoFolders', () => {
  let root: Root;
  let dom: ReturnType<typeof installHookTestDom>;
  let originalStore: ReturnType<typeof useSessionFoldersStore.getState>;
  let reconcileCalls: Array<{
    scopeKey: string;
    assignments: readonly { name: string; sessionIds: readonly string[] }[];
    knownSessionIds: readonly string[] | undefined;
  }>;
  let reconcileArchivedFolders: ReturnType<typeof useSessionFoldersStore.getState>['reconcileArchivedFolders'];

  beforeEach(() => {
    dom = installHookTestDom();
    root = createRoot(dom.container);
    originalStore = useSessionFoldersStore.getState();
    reconcileCalls = [];
    reconcileArchivedFolders = originalStore.reconcileArchivedFolders;
    createFolderCalls.length = 0;
    addSessionToFolderCalls.length = 0;
    useSessionFoldersStore.setState({
      foldersMap: {},
      collapsedFolderIds: new Set<string>(),
      reconcileArchivedFolders: (scopeKey, assignments, knownSessionIds) => {
        reconcileCalls.push({ scopeKey, assignments, knownSessionIds });
        reconcileArchivedFolders(scopeKey, assignments, knownSessionIds);
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 350));
    useSessionFoldersStore.setState(originalStore, true);
    dom.restore();
  });

  test('materializes archived folders from authoritative directory ownership', async () => {
    const feature = makeSession('archived-feature', '/workspace/feature', true);
    const rootSession = makeSession('archived-root', '/workspace', true);
    const duplicate = makeSession('archived-feature', '/workspace/feature', true);
    const invalid = makeSession('', '/workspace/feature', true);
    const ownership = makeOwnership([], [feature, rootSession, duplicate, invalid]);
    const existingFeatureFolder = {
      id: 'feature-folder',
      name: 'Feature',
      sessionIds: [],
      createdAt: 1,
      parentId: null,
    };
    const ordinaryFolder = {
      id: 'ordinary-folder',
      name: 'Ordinary',
      sessionIds: ['ordinary-session'],
      createdAt: 2,
      parentId: null,
    };
    useSessionFoldersStore.setState({
      foldersMap: {
        '__archived__:/workspace': [existingFeatureFolder],
        '/workspace': [ordinaryFolder],
      },
      collapsedFolderIds: new Set([
        getSessionFolderIdentityKey('__archived__:/workspace', existingFeatureFolder.id),
      ]),
    });

    await act(async () => root.render(<Probe ownership={ownership} />));

    const archivedFolders = useSessionFoldersStore.getState().foldersMap['__archived__:/workspace'] ?? [];
    expect(archivedFolders).toHaveLength(2);
    expect(archivedFolders[0]).toMatchObject({ id: 'feature-folder', name: 'Feature', sessionIds: ['archived-feature'] });
    expect(archivedFolders[1]).toMatchObject({ name: 'project root', sessionIds: ['archived-root'] });
    expect(useSessionFoldersStore.getState().foldersMap['/workspace']).toEqual([ordinaryFolder]);
    expect(useSessionFoldersStore.getState().collapsedFolderIds).toEqual(new Set([
      getSessionFolderIdentityKey('__archived__:/workspace', existingFeatureFolder.id),
    ]));
    expect(createFolderCalls).toEqual([]);
    expect(addSessionToFolderCalls).toEqual([]);
  });

  test('rerunning with the same authoritative inputs is a state and persistence no-op', async () => {
    const archived = makeSession('archived-feature', '/workspace/feature', true);
    const firstOwnership = makeOwnership([], [archived]);
    await act(async () => root.render(<Probe ownership={firstOwnership} />));
    const beforeRerun = useSessionFoldersStore.getState().foldersMap;
    const callsBeforeRerun = reconcileCalls.length;

    await act(async () => root.render(<Probe ownership={makeOwnership([], [archived])} revision={1} />));

    expect(useSessionFoldersStore.getState().foldersMap).toBe(beforeRerun);
    expect(reconcileCalls.length).toBeGreaterThan(callsBeforeRerun);
    expect(createFolderCalls).toEqual([]);
    expect(addSessionToFolderCalls).toEqual([]);
  });

  test('reconciles once per archived scope with grouped session assignments', async () => {
    const archived = Array.from({ length: 12 }, (_, index) => makeSession(
      `archived-${index}`,
      index % 2 === 0 ? '/workspace/feature' : '/workspace',
      true,
    ));

    await act(async () => root.render(<Probe ownership={makeOwnership([], archived)} />));

    const firstCall = reconcileCalls[0];
    expect(firstCall?.scopeKey).toBe('__archived__:/workspace');
    expect(firstCall?.assignments).toEqual([
      { name: 'feature', sessionIds: archived.filter((_, index) => index % 2 === 0).map((session) => session.id) },
      { name: 'project root', sessionIds: archived.filter((_, index) => index % 2 === 1).map((session) => session.id) },
    ]);
    expect(reconcileCalls.length).toBeLessThan(archived.length);
  });

  test('keeps existing state when session or topology authority is incomplete', async () => {
    const archived = makeSession('archived-feature', '/workspace/feature', true);
    const ownership = makeOwnership([], [archived]);
    const archivedFolder = {
      id: 'archived-folder',
      name: 'Feature',
      sessionIds: [archived.id],
      createdAt: 1,
      parentId: null,
    };
    const existingFoldersMap = { '__archived__:/workspace': [archivedFolder] };
    useSessionFoldersStore.setState({ foldersMap: existingFoldersMap });
    const before = useSessionFoldersStore.getState().foldersMap;

    await act(async () => root.render(<Probe ownership={ownership} isSessionsLoading />));
    await act(async () => root.render(<Probe ownership={ownership} hasAuthoritativeGlobalSessions={false} revision={1} />));
    await act(async () => root.render(<Probe ownership={ownership} isWorktreeTopologyLoading revision={2} />));
    await act(async () => root.render(<Probe ownership={ownership} unresolvedWorktreeProjectPaths={new Set(['/workspace'])} revision={3} />));

    expect(reconcileCalls).toEqual([]);
    expect(useSessionFoldersStore.getState().foldersMap).toBe(before);
  });

  test('removes a restored session from the archived projection without touching ordinary folders', async () => {
    const restored = makeSession('restored', '/workspace/feature', false);
    const archivedScope = '__archived__:/workspace';
    const archivedFolder = {
      id: 'feature-folder',
      name: 'Feature',
      sessionIds: [restored.id],
      createdAt: 1,
      parentId: null,
    };
    const ordinaryFolder = {
      id: 'ordinary-folder',
      name: 'Ordinary',
      sessionIds: [restored.id],
      createdAt: 2,
      parentId: null,
    };
    useSessionFoldersStore.setState({
      foldersMap: { [archivedScope]: [archivedFolder], '/workspace': [ordinaryFolder] },
    });

    await act(async () => root.render(<Probe ownership={makeOwnership([restored], [])} />));

    expect(useSessionFoldersStore.getState().foldersMap[archivedScope]?.[0]).toMatchObject({
      id: archivedFolder.id,
      sessionIds: [],
    });
    expect(useSessionFoldersStore.getState().foldersMap['/workspace']).toEqual([ordinaryFolder]);
  });
});
