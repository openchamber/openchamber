import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Agent } from '@opencode-ai/sdk/v2';
import { useConfigStore } from '@/stores/useConfigStore';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useAgentColors } from './useAgentColors';

test('consumers share allocations and update together on roster and theme changes', async () => {
  const dom = new Window({ url: 'http://agent-colors.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const previousAgents = useConfigStore.getState().agents;
  const previousName = useConfigStore.getState().currentAgentName;
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent,
    fetch: async () => Response.json({ themes: [] }), IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const agent = (name: string): Agent => ({ name, mode: 'primary', native: false, options: {}, permission: [] });
  const agents = ['architect', 'build', 'plan', 'simplifier'].map(agent);
  useConfigStore.setState({ agents });
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const seen = new Set<ReturnType<typeof useAgentColors>>();
  let changeTheme = () => {};
  function Probe() {
    const resolve = useAgentColors();
    seen.add(resolve);
    return <span>{resolve('build').var}</span>;
  }
  function Controls() {
    const theme = useThemeSystem();
    changeTheme = () => theme.setTheme(theme.currentTheme.metadata.variant === 'dark' ? 'openchamber-light' : 'openchamber-dark');
    return null;
  }
  try {
    await act(async () => root.render(<ThemeSystemProvider><Controls />{Array.from({ length: 100 }, (_, index) => <Probe key={index} />)}</ThemeSystemProvider>));
    expect(seen.size).toBe(1);
    await act(async () => useConfigStore.setState({ currentAgentName: 'plan' }));
    expect(seen.size).toBe(1);
    await act(async () => useConfigStore.setState({ agents: [...agents, { ...agent('internal'), hidden: true }] }));
    expect(seen.size).toBe(2);
    const [initial, hiddenAdded] = [...seen];
    for (const { name } of agents) expect(hiddenAdded(name)).toEqual(initial(name));
    await act(async () => changeTheme());
    expect(seen.size).toBe(3);
    for (const resolve of seen) expect(resolve('build').var).toBe('--status-success');
    expect(container.querySelectorAll('span').length).toBe(100);
  } finally {
    await act(async () => root.unmount());
    useConfigStore.setState({ agents: previousAgents, currentAgentName: previousName });
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
});
