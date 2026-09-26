import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { Model } from '@/lib/opencode/model';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useModelLists } from './useModelLists';

const base: Model = {
  id: 'gpt-6-luna', modelID: 'gpt-6-luna', providerID: 'openai', name: 'GPT-6 Luna',
  capabilities: { tools: true, input: ['text'], output: ['text'] },
  variants: [{ id: 'low' }], time: { released: 0 },
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  limit: { context: 400_000, output: 128_000 }, enabled: true, status: 'active',
};
const fast: Model = { ...base, id: `${base.id}-fast`, name: 'GPT-6 Luna Fast', variants: [{ id: 'high' }] };
const copilot: Model = { ...base, providerID: 'github-copilot' };
const providers = [
  { id: 'openai', name: 'OpenAI', activation: 'enabled' as const, package: 'openai', models: [fast, base] },
  { id: 'github-copilot', name: 'Copilot', activation: 'enabled' as const, package: 'copilot', models: [copilot] },
];

describe('model favorites and recents', () => {
  let dom: Window;
  let root: Root;
  let lists: ReturnType<typeof useModelLists>;
  const Probe = ({ directory }: { directory?: string }) => {
    lists = useModelLists(directory);
    return null;
  };

  beforeEach(() => {
    dom = new Window({ url: 'http://localhost/' });
    Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, IS_REACT_ACT_ENVIRONMENT: true });
    useConfigStore.setState({ providers, activeDirectoryKey: '/active', directoryScoped: {} });
    useUIStore.setState({ favoriteModels: [], recentModels: [], hiddenModels: [] });
    root = createRoot(document.createElement('div'));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await dom.happyDOM.close();
  });

  test('adding, removing and reordering Fast favorites keeps the provider and model identities', async () => {
    await act(async () => root.render(<Probe />));
    await act(async () => {
      const store = useUIStore.getState();
      store.toggleFavoriteModel('openai', base.id);
      store.toggleFavoriteModel('openai', fast.id);
      store.toggleFavoriteModel('github-copilot', copilot.id);
    });
    expect(lists.favoriteModelsList.map((entry) => entry.model)).toEqual([copilot, fast, base]);
    await act(async () => useUIStore.getState().reorderFavoriteModel('openai', fast.id, 'github-copilot', copilot.id));
    expect(lists.favoriteModelsList.map((entry) => entry.model)).toEqual([fast, copilot, base]);
    await act(async () => useUIStore.getState().toggleFavoriteModel('openai', fast.id));
    expect(lists.favoriteModelsList.map((entry) => entry.model)).toEqual([copilot, base]);
  });

  test('old favorite keys render canonical rows and unfavorite removes duplicate aliases only in that provider', async () => {
    const preferences = [
      { providerID: 'openai', modelID: `openai/${base.id}` },
      { providerID: 'openai', modelID: base.id },
      { providerID: 'openai', modelID: `openai/${fast.id}` },
      { providerID: 'github-copilot', modelID: base.id },
    ];
    useUIStore.setState({ favoriteModels: preferences });
    await act(async () => root.render(<Probe />));
    expect(lists.favoriteModelsList.map((entry) => entry.modelID)).toEqual([base.id, fast.id, copilot.id]);
    expect(useUIStore.getState().favoriteModels).toBe(preferences);
    expect(lists.getFavoriteModelKey('openai', base.id)).toBe(`openai/${base.id}`);
    expect(useUIStore.getState().isFavoriteModel('openai', lists.getFavoriteModelKey('openai', base.id))).toBe(true);
    await act(async () => useUIStore.getState().toggleFavoriteModel('openai', base.id, lists.getFavoriteModelAliases('openai', base.id)));
    expect(useUIStore.getState().favoriteModels).toEqual(preferences.slice(2));
    expect(lists.favoriteModelsList.map((entry) => entry.model)).toEqual([fast, copilot]);
  });

  test('reordering legacy favorites moves all aliases together in either direction', async () => {
    const preferences = [
      { providerID: 'openai', modelID: `openai/${base.id}` },
      { providerID: 'openai', modelID: base.id },
      { providerID: 'openai', modelID: `openai/${fast.id}` },
      { providerID: 'github-copilot', modelID: base.id },
    ];
    useUIStore.setState({ favoriteModels: preferences });
    await act(async () => root.render(<Probe />));
    const reorder = (overProvider: string, overModel: string) => useUIStore.getState().reorderFavoriteModel(
      'openai', lists.getFavoriteModelKey('openai', base.id),
      overProvider, lists.getFavoriteModelKey(overProvider, overModel),
      lists.getFavoriteModelAliases('openai', base.id),
    );
    await act(async () => reorder('github-copilot', base.id));
    expect(lists.favoriteModelsList.map((entry) => entry.model)).toEqual([fast, copilot, base]);
    expect(useUIStore.getState().favoriteModels).toEqual([...preferences.slice(2), ...preferences.slice(0, 2)]);
    await act(async () => reorder('openai', fast.id));
    expect(lists.favoriteModelsList.map((entry) => entry.model)).toEqual([base, fast, copilot]);
    expect(useUIStore.getState().favoriteModels).toEqual(preferences);
  });

  test('recents exclude favorites across saved key spellings, and missing catalogs do not delete preferences', async () => {
    const favoriteModels = [{ providerID: 'openai', modelID: `openai/${base.id}` }];
    const recentModels = [
      { providerID: 'openai', modelID: base.id },
      { providerID: 'openai', modelID: fast.id },
      { providerID: 'openai', modelID: `openai/${fast.id}` },
      { providerID: 'github-copilot', modelID: base.id },
      { providerID: 'absent', modelID: 'unknown' },
    ];
    useUIStore.setState({ favoriteModels, recentModels });
    await act(async () => root.render(<Probe />));
    expect(lists.recentModelsList.map((entry) => entry.model)).toEqual([fast, copilot]);
    await act(async () => useConfigStore.setState({ providers: [] }));
    expect(lists.favoriteModelsList).toEqual([]);
    expect(useUIStore.getState().favoriteModels).toBe(favoriteModels);
    expect(useUIStore.getState().recentModels).toBe(recentModels);
    await act(async () => useConfigStore.setState({ providers }));
    expect(lists.favoriteModelsList[0].model).toBe(base);
  });

  test('the settings directory resolves its own catalog and hidden favorites stay hidden', async () => {
    const settingsModel = { ...base, id: `openai/${base.id}`, name: 'Settings model' };
    useConfigStore.setState({ directoryScoped: { '/settings': {
      providers: [{ ...providers[0], models: [settingsModel] }], agents: [],
      currentProviderId: '', currentModelId: '', currentAgentName: '', selectedProviderId: '', agentModelSelections: {}, defaultProviders: {},
    } } });
    useUIStore.setState({ favoriteModels: [{ providerID: 'openai', modelID: base.id }] });
    await act(async () => root.render(<Probe directory="/settings" />));
    expect(lists.favoriteModelsList[0].model).toBe(settingsModel);
    expect(lists.getFavoriteModelKey('openai', settingsModel.id)).toBe(base.id);
    await act(async () => useUIStore.setState({ hiddenModels: [{ providerID: 'openai', modelID: settingsModel.id }] }));
    expect(lists.favoriteModelsList).toEqual([]);
  });
});
