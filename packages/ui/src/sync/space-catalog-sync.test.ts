import { afterEach, describe, expect, test } from 'bun:test';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSpacesStore, type SpaceMark } from '@/lib/spaces/spaces-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { foldersOfSpaces, spaceFoldersOfProject, spacesWithNewProject, subscribeSpaceCatalogs } from './space-catalog-sync';

const ID = 'a1b2c3d4e5f6';
const OTHER = '0f0f0f0f0f0f';
const mark = (id: string, projectDirectory: string | null): SpaceMark => ({
  id, name: id, state: 'complete', projectDirectory, directory: projectDirectory ? `/spaces/${id}/app` : null,
});

type Snapshot = ReturnType<typeof useConfigStore.getState>['directoryScoped'][string];
const snapshot = (providersLoaded: boolean): Snapshot => ({
  providersLoaded, providers: [], agents: [], currentProviderId: '', currentModelId: '', currentVariant: undefined, currentAgentName: undefined,
  selectedProviderId: '', agentModelSelections: {}, defaultProviders: {}, opencodeDefaultAgent: undefined, opencodeDefaultModel: undefined,
  selectionSource: 'auto', agentSelectionSource: 'auto',
});

const originalLoadProviders = useConfigStore.getState().loadProviders;
afterEach(() => {
  useSpacesStore.getState().applyMarks([]);
  useConfigStore.setState({ loadProviders: originalLoadProviders, directoryScoped: {} });
});

describe('spacesWithNewProject', () => {
  test('names a space whose project appears or changes, and no other', () => {
    const before = new Map([[ID, mark(ID, null)], [OTHER, mark(OTHER, '/repo/other')]]);
    const after = new Map([[ID, mark(ID, '/repo/app')], [OTHER, mark(OTHER, '/repo/other')]]);
    expect([...spacesWithNewProject(after, before)]).toEqual([ID]);
    expect([...spacesWithNewProject(after, after)]).toEqual([]);
    expect([...spacesWithNewProject(new Map([[ID, mark(ID, '/repo/moved')]]), after)]).toEqual([ID]);
    expect([...spacesWithNewProject(new Map([[ID, mark(ID, null)]]), after)]).toEqual([]);
  });
});

describe('foldersOfSpaces', () => {
  test('keeps the folders inside the named spaces', () => {
    expect(foldersOfSpaces(new Set([ID]), [`/spaces/${ID}/app`, `/spaces/${ID}/app/src`, `/spaces/${OTHER}/app`, '/repo/app']))
      .toEqual([`/spaces/${ID}/app`, `/spaces/${ID}/app/src`]);
  });
});

describe('subscribeSpaceCatalogs', () => {
  test('reads the open catalog of a space again when its project becomes known, and nothing else', () => {
    const loads: Array<{ directory?: string | null; fresh?: boolean }> = [];
    useConfigStore.setState({
      activeDirectoryKey: `/spaces/${ID}/app`,
      loadProviders: async (options) => { loads.push({ directory: options?.directory, fresh: options?.fresh }); },
    });
    const unsubscribe = subscribeSpaceCatalogs(getRuntimeKey());
    try {
      useSpacesStore.getState().applyMarks([mark(ID, '/repo/app'), mark(OTHER, null)]);
      expect(loads.map((load) => load.directory)).toEqual([`/spaces/${ID}/app`]);
      expect(loads.every((load) => load.fresh === true)).toBe(true);
      loads.length = 0;
      // The same list again reads nothing.
      useSpacesStore.getState().applyMarks([mark(ID, '/repo/app'), mark(OTHER, null)]);
      expect(loads).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  test('reads a folder this page loaded, and not one only saved from an earlier visit', () => {
    const loads: Array<string | null | undefined> = [];
    useConfigStore.setState({
      activeDirectoryKey: '/repo/app',
      directoryScoped: { [`/spaces/${ID}/app/src`]: snapshot(true), [`/spaces/${ID}/old`]: snapshot(false), '/repo/app': snapshot(true) },
      loadProviders: async (options) => { loads.push(options?.directory); },
    });
    const unsubscribe = subscribeSpaceCatalogs(getRuntimeKey());
    try {
      useSpacesStore.getState().applyMarks([mark(ID, '/repo/app')]);
      expect(loads).toEqual([`/spaces/${ID}/app/src`]);
    } finally {
      unsubscribe();
    }
  });
});

describe('spaceFoldersOfProject', () => {
  test('names the loaded folders of the spaces made from a host project, for its catalog events', () => {
    useConfigStore.setState({
      activeDirectoryKey: `/spaces/${ID}/app`,
      directoryScoped: { [`/spaces/${OTHER}/app`]: snapshot(true), [`/spaces/${ID}/old`]: snapshot(false) },
    });
    useSpacesStore.getState().applyMarks([mark(ID, '/repo/app'), mark(OTHER, '/repo/other')]);
    expect(spaceFoldersOfProject('/repo/app')).toEqual([`/spaces/${ID}/app`]);
    expect(spaceFoldersOfProject('/repo/other')).toEqual([`/spaces/${OTHER}/app`]);
    expect(spaceFoldersOfProject('/repo/none')).toEqual([]);
  });
});
