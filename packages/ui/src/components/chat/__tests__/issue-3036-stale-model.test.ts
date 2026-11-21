import { describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { getDefaultTheme } from '@/lib/theme/themes';
import { I18nProvider } from '@/lib/i18n';

describe('issue #3036 stale persisted models', () => {
  test('changes the agent only after its persisted model is accepted', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}));
    const dom = new Window({ url: 'http://localhost' });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries({
      window: dom, document: dom.document, navigator: dom.navigator,
      localStorage: dom.localStorage, Event: dom.Event, CustomEvent: dom.CustomEvent,
      Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLIFrameElement: dom.HTMLIFrameElement, Node: dom.Node,
      MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
      getComputedStyle: dom.getComputedStyle.bind(dom),
      requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
      cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const { ModelControls } = await import('../ModelControls');
    const { SyncProvider } = await import('@/sync/sync-context');
    const { useConfigStore } = await import('@/stores/useConfigStore');
    const { useSelectionStore } = await import('@/sync/selection-store');
    const { useSessionUIStore } = await import('@/sync/session-ui-store');
    const { useContextStore } = await import('@/stores/contextStore');
    const { createWebAPIs } = await import('../../../../../web/src/api/index');
    const configBefore = useConfigStore.getState();
    const selectionsBefore = useSelectionStore.getState();
    const sessionBefore = useSessionUIStore.getState();
    const contextBefore = useContextStore.getState();
    const sessionId = 'ses_stale_model';
    const agents = ['plan', 'review', 'build'].map((name) => ({
      id: name, name, displayName: name, mode: 'primary' as const, hidden: false,
      request: { settings: {}, headers: {}, body: {} }, permissions: [],
    }));
    const currentModel = {
      id: 'provider/current', modelID: 'current', name: 'Current', providerID: 'provider',
      capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [],
      time: { released: 0 },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      status: 'active' as const, enabled: true, limit: { context: 0, output: 0 },
    };
    const restoredModel = { ...currentModel, id: 'provider/removed', modelID: 'removed', name: 'Restored' };
    const provider = {
      id: 'provider', name: 'Provider', activation: 'enabled' as const, package: 'provider', models: [currentModel],
    };
    const theme = getDefaultTheme(false);
    const themeContext: ThemeContextValue = {
      currentTheme: theme, availableThemes: [theme], customThemeIds: [], customThemesLoading: false,
      reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
      setTheme: () => {}, isSystemPreference: false, setSystemPreference: () => {},
      themeMode: 'light', setThemeMode: () => {}, lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id,
      setLightThemePreference: () => {}, setDarkThemePreference: () => {},
    };
    try {
      useConfigStore.setState({
        providers: [provider], agents, providersLoaded: true, agentsLoaded: true, settingsDefaultsLoaded: true,
        currentProviderId: provider.id, currentModelId: currentModel.id, currentAgentName: 'build',
        directoryScoped: {}, agentModelSelections: {},
      });
      useSessionUIStore.setState({ currentSessionId: sessionId });
      useContextStore.setState({ hasHydrated: true });
      useSelectionStore.setState({
        sessionAgentSelections: new Map(), sessionModelSelections: new Map(),
        sessionAgentModelSelections: new Map([[sessionId, new Map([
          ['plan', { providerId: provider.id, modelId: restoredModel.id }],
          ['review', { providerId: provider.id, modelId: 'also-removed' }],
        ])]]),
      });
      const sdk = OpenCode.make({ baseUrl: 'http://stale-model.test', fetch: () => new Promise<Response>(() => {}) });
      await act(async () => root.render(React.createElement(I18nProvider, null,
        React.createElement(ThemeSystemContext.Provider, { value: themeContext },
          React.createElement(RuntimeAPIContext.Provider, { value: createWebAPIs() },
            React.createElement(SyncProvider, { sdk, directory: '/workspace', children: React.createElement(ModelControls) }),
          ),
        ),
      )));

      expect(useConfigStore.getState().currentAgentName).toBe('build');
      expect(useConfigStore.getState().currentModelId).toBe(currentModel.id);
      expect(useSelectionStore.getState().getSessionAgentSelection(sessionId)).toBeNull();
      expect(host.querySelector('.model-controls__agent-label')?.textContent).toBe('build');

      await act(async () => {
        useConfigStore.setState({ providers: [{ ...provider, models: [currentModel, restoredModel] }] });
      });
      expect(useConfigStore.getState().currentAgentName).toBe('plan');
      expect(useConfigStore.getState().currentModelId).toBe(restoredModel.id);
      expect(useSelectionStore.getState().getSessionAgentSelection(sessionId)).toBe('plan');
      expect(host.querySelector('.model-controls__agent-label')?.textContent).toBe('plan');
    } finally {
      await act(async () => root.unmount());
      useConfigStore.setState(configBefore, true);
      useSelectionStore.setState(selectionsBefore, true);
      useSessionUIStore.setState(sessionBefore, true);
      useContextStore.setState(contextBefore, true);
      await dom.happyDOM.close();
      fetchSpy.mockRestore();
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
});
