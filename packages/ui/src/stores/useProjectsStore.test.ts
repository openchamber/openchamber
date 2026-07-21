import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  deferred,
  emitRuntimeEndpointChanged,
  installRuntimeSettingsTestWindow,
  resetRuntimeSettingsTestState,
  restoreRuntimeSettingsTestWindow,
  setDirectory,
  setRuntimeApiBaseUrl,
  setRuntimeFetchResolver,
  setRuntimeKey,
  storageValues,
  updateDesktopSettings,
} from './runtimeSettingsTestSupport';

installRuntimeSettingsTestWindow();

const { useDirectoryStore } = await import('./useDirectoryStore');
const { useProjectsStore } = await import('./useProjectsStore');
const { createProjectIdFromPath } = await import('@/lib/projectId');

describe('useProjectsStore runtime-scoped persistence', () => {
  afterAll(() => {
    restoreRuntimeSettingsTestWindow();
  });

  beforeEach(() => {
    resetRuntimeSettingsTestState();
    setRuntimeKey('remote-runtime');
    setRuntimeApiBaseUrl('https://shared-runtime-origin.example');
    useDirectoryStore.setState({
      homeDirectory: '/home/remote-user',
      isHomeReady: true,
    });
    useProjectsStore.getState().resetForRuntimeSwitch();
    useProjectsStore.setState({
      projects: [],
      activeProjectId: null,
      manualProjectOrder: [],
    });
  });

  test('expands remote project paths with the remote home instead of browser-local storage', () => {
    storageValues.set('homeDirectory', '/Users/local-user');

    const project = useProjectsStore.getState().addProject('~/projects/app');

    expect(project?.path).toBe('/home/remote-user/projects/app');
    expect(updateDesktopSettings).toHaveBeenCalledWith(expect.objectContaining({
      projects: [expect.objectContaining({ path: '/home/remote-user/projects/app' })],
    }));
  });

  test('does not restore an unscoped local project list after switching to a remote runtime', () => {
    storageValues.set('projects', JSON.stringify([
      { id: 'local', path: '/Users/local-user/projects/app' },
    ]));
    storageValues.set('activeProjectId', 'local');

    useProjectsStore.getState().resetForRuntimeSwitch();

    expect(useProjectsStore.getState().projects).toEqual([]);
    expect(useProjectsStore.getState().activeProjectId).toBeNull();
  });

  test('does not persist a project list left over from a previous runtime', () => {
    setRuntimeKey('local');
    useProjectsStore.getState().resetForRuntimeSwitch();
    useProjectsStore.setState({
      projects: [{ id: 'local-project', path: '/Users/local-user/projects/app' }],
      activeProjectId: null,
    });
    updateDesktopSettings.mockClear();

    setRuntimeKey('remote-runtime');
    emitRuntimeEndpointChanged({ runtimeKey: 'remote-runtime', previousRuntimeKey: 'local' });
    useProjectsStore.getState().updateProjectMeta('local-project', { label: 'Local App' });

    expect(updateDesktopSettings).not.toHaveBeenCalled();
  });

  test('does not retain a previous runtime project list when remote settings are explicitly empty', () => {
    const remoteProjectsStorageKey = `projects:${encodeURIComponent('remote-runtime')}`;
    storageValues.set(remoteProjectsStorageKey, JSON.stringify([
      { id: 'stale-remote-project', path: '/home/remote-user/stale-project' },
    ]));

    setRuntimeKey('local');
    useProjectsStore.getState().resetForRuntimeSwitch();
    useProjectsStore.setState({
      projects: [{ id: 'local-project', path: '/Users/local-user/projects/app' }],
      activeProjectId: 'local-project',
    });
    setRuntimeKey('remote-runtime');
    emitRuntimeEndpointChanged({ runtimeKey: 'remote-runtime', previousRuntimeKey: 'local' });
    useProjectsStore.getState().resetForRuntimeSwitch();
    expect(useProjectsStore.getState().projects).toHaveLength(1);

    useProjectsStore.getState().synchronizeFromSettings({ projects: [] });

    expect(useProjectsStore.getState().projects).toEqual([]);
    expect(useProjectsStore.getState().activeProjectId).toBeNull();
  });

  test('isolates caches for runtimes sharing one API origin', () => {
    setRuntimeKey('runtime-a');
    useProjectsStore.getState().resetForRuntimeSwitch();
    useProjectsStore.getState().synchronizeFromSettings({
      projects: [{ id: 'project-a', path: '/home/runtime-a/project' }],
    });

    setRuntimeKey('runtime-b');
    emitRuntimeEndpointChanged({ runtimeKey: 'runtime-b', previousRuntimeKey: 'runtime-a' });
    useProjectsStore.getState().resetForRuntimeSwitch();

    expect(useProjectsStore.getState().projects).toEqual([]);
  });

  test('ignores an old icon response after a runtime switch round trip', async () => {
    const localPath = '/Users/local-user/projects/app';
    const localProject = {
      id: createProjectIdFromPath(localPath),
      path: localPath,
    };
    setRuntimeKey('runtime-a');
    useProjectsStore.getState().resetForRuntimeSwitch();
    useProjectsStore.setState({ projects: [localProject], activeProjectId: localProject.id });
    const response = deferred<Response>();
    setRuntimeFetchResolver(async () => response.promise);
    setDirectory.mockClear();

    const request = useProjectsStore.getState().discoverProjectIcon(localProject.id);
    setRuntimeKey('runtime-b');
    emitRuntimeEndpointChanged({ runtimeKey: 'runtime-b', previousRuntimeKey: 'runtime-a' });
    setRuntimeKey('runtime-a');
    emitRuntimeEndpointChanged({ runtimeKey: 'runtime-a', previousRuntimeKey: 'runtime-b' });
    useProjectsStore.setState({
      projects: [{ id: 'remote-project', path: '/home/remote-user/project' }],
      activeProjectId: 'remote-project',
    });
    response.resolve(new Response(JSON.stringify({
      settings: {
        projects: [localProject],
        activeProjectId: localProject.id,
      },
    }), {
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(await request).toEqual({ ok: false });
    expect(useProjectsStore.getState().projects).toEqual([
      { id: 'remote-project', path: '/home/remote-user/project' },
    ]);
    expect(setDirectory).not.toHaveBeenCalledWith(localPath);
  });

  test('restores each runtime manual project order after a round trip', () => {
    const projectA = { id: 'project-a', path: '/home/runtime-a/project-a' };
    const projectB = { id: 'project-b', path: '/home/runtime-a/project-b' };
    setRuntimeKey('runtime-a');
    useProjectsStore.getState().resetForRuntimeSwitch();
    useProjectsStore.setState({
      projects: [projectA, projectB],
      activeProjectId: projectA.id,
      manualProjectOrder: [],
    });
    useProjectsStore.getState().reorderProjects(0, 1);

    setRuntimeKey('runtime-b');
    emitRuntimeEndpointChanged({ runtimeKey: 'runtime-b', previousRuntimeKey: 'runtime-a' });
    useProjectsStore.getState().resetForRuntimeSwitch();
    expect(useProjectsStore.getState().manualProjectOrder).toEqual([]);

    setRuntimeKey('runtime-a');
    emitRuntimeEndpointChanged({ runtimeKey: 'runtime-a', previousRuntimeKey: 'runtime-b' });
    useProjectsStore.getState().resetForRuntimeSwitch();

    expect(useProjectsStore.getState().manualProjectOrder).toEqual([projectB.id, projectA.id]);
  });

  test('reads the legacy manual order only for the local runtime', () => {
    storageValues.set('projects:manualOrder', JSON.stringify(['local-b', 'local-a']));
    setRuntimeKey('local');
    useProjectsStore.getState().resetForRuntimeSwitch();

    expect(useProjectsStore.getState().manualProjectOrder).toEqual(['local-b', 'local-a']);

    setRuntimeKey('remote-runtime');
    emitRuntimeEndpointChanged({ runtimeKey: 'remote-runtime', previousRuntimeKey: 'local' });
    useProjectsStore.getState().resetForRuntimeSwitch();

    expect(useProjectsStore.getState().manualProjectOrder).toEqual([]);
  });
});
