import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

// Page contents are unrelated to the search sidebar; keep the real view,
// search registry and config subscriptions mounted.
for (const [folder, names] of [
  ['agents', ['AgentsSidebar', 'AgentsPage']],
  ['behavior', ['BehaviorPage']],
  ['websearch', ['WebSearchPage']],
  ['commands', ['CommandsSidebar', 'CommandsPage']],
  ['mcp', ['McpPage']],
  ['skills', ['SkillsSidebar', 'SkillsPage']],
  ['projects', ['ProjectsSidebar', 'ProjectsPage']],
  ['remote-instances', ['RemoteInstancesPage']],
  ['providers', ['ProvidersPage']],
  ['usage', ['UsageSidebar', 'UsagePage']],
  ['magic-prompts', ['MagicPromptsSidebar', 'MagicPromptsPage']],
  ['snippets', ['SnippetsSidebar', 'SnippetsPage']],
  ['git-identities', ['GitPage']],
  ['integrations', ['IntegrationsPage']],
  ['routing', ['RoutingPage']],
  ['extensions', ['ExtensionsPage']],
  ['openchamber', ['OpenChamberPage', 'AboutSettings']],
] as const) {
  for (const name of names) {
    mock.module(`@/components/sections/${folder}/${name}`, () => ({ [name]: () => null }));
  }
}
mock.module('@/components/sections/plugins', () => ({ PluginsPage: () => null }));

import { I18nProvider } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';
const { SettingsView } = await import('./SettingsView');

describe('SettingsView voice search availability', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let descriptors: Map<string, PropertyDescriptor | undefined>;
  let initialConfig: ReturnType<typeof useConfigStore.getState>;

  beforeEach(async () => {
    windowInstance = new Window();
    initialConfig = useConfigStore.getState();
    const globals = {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      Event: windowInstance.Event,
      ResizeObserver: windowInstance.ResizeObserver,
      requestAnimationFrame: windowInstance.requestAnimationFrame.bind(windowInstance),
      cancelAnimationFrame: windowInstance.cancelAnimationFrame.bind(windowInstance),
      localStorage: windowInstance.localStorage,
      sessionStorage: windowInstance.sessionStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
      fetch: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }),
    };
    descriptors = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.assign(globalThis, globals);
    windowInstance.HTMLElement.prototype.scrollIntoView = () => {};
    host = document.createElement('div');
    document.body.append(host);
    const { createRoot } = await import('react-dom/client');
    root = createRoot(host);
  });

  afterEach(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      useConfigStore.setState(initialConfig);
      windowInstance.close();
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  for (const runtime of ['web', 'desktop']) {
    test(`updates endpoint results on ${runtime} without changing the query`, async () => {
      if (runtime === 'desktop') {
        Object.assign(windowInstance, { __OPENCHAMBER_ELECTRON__: { runtime: 'electron' } });
      }
      useConfigStore.setState({
        voiceProvider: 'openai-compatible', sttProvider: 'openai-compatible',
        showMessageTTSButtons: true, autoReadAloudEnabled: false, dictationEnabled: true,
      });
      await act(async () => root.render(<I18nProvider><SettingsView visiblePageSlugs={['voice']} /></I18nProvider>));
      const input = host.querySelector<HTMLInputElement>('[data-settings-search]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(windowInstance.HTMLInputElement.prototype, 'value')!.set!.call(input, 'endpoint path');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const endpointResults = () => Array.from(host.querySelectorAll('button')).filter((button) => button.textContent?.includes('Endpoint path'));
      expect(endpointResults()).toHaveLength(2);
      await act(async () => { useConfigStore.setState({ showMessageTTSButtons: false }); });
      expect(endpointResults()).toHaveLength(1);
      await act(async () => { useConfigStore.setState({ autoReadAloudEnabled: true }); });
      expect(endpointResults()).toHaveLength(2);
      await act(async () => { useConfigStore.setState({ voiceProvider: 'local' }); });
      expect(endpointResults()).toHaveLength(1);
      await act(async () => { useConfigStore.setState({ dictationEnabled: false }); });
      expect(endpointResults()).toHaveLength(0);
      await act(async () => { useConfigStore.setState({ dictationEnabled: true }); });
      expect(endpointResults()).toHaveLength(1);
      await act(async () => { useConfigStore.setState({ sttProvider: 'local' }); });
      expect(endpointResults()).toHaveLength(0);
      await act(async () => { useConfigStore.setState({ voiceProvider: 'openai-compatible', sttProvider: 'openai-compatible' }); });
      expect(endpointResults()).toHaveLength(2);
      expect(input.value).toBe('endpoint path');
    });
  }
});
