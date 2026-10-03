import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { AgentWithExtras } from './useAgentsStore';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, Node: browser.Node, Element: browser.Element,
  HTMLElement: browser.HTMLElement, HTMLInputElement: browser.HTMLInputElement,
  DocumentFragment: browser.DocumentFragment, Event: browser.Event,
  MouseEvent: browser.MouseEvent, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const DIRECTORY = '/workspace/project';
const agent = (name: string, hidden = false, native = false): AgentWithExtras => ({
  id: name, name, displayName: name, mode: 'subagent', hidden, native,
  request: { settings: {}, headers: {}, body: {} }, permissions: [],
});
let listedAgents: AgentWithExtras[] = [];
let failingConfigLookups = new Set<string>();
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const path = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
  if (path.endsWith('/agent')) return Response.json({ data: listedAgents });
  if (path.startsWith('/api/config/agents/')) {
    const name = decodeURIComponent(path.slice('/api/config/agents/'.length).replace(/\/config$/, ''));
    const current = listedAgents.find((entry) => entry.name === name);
    if (failingConfigLookups.has(name)) return new Response('boom', { status: 500 });
    if (path.endsWith('/config')) {
      return Response.json({ source: 'md', scope: 'user', path: `/config/agents/${name}.md`, legacy: false,
        config: { hidden: current?.hidden, mode: 'subagent', system: 'Stored instructions' } });
    }
    return Response.json({ isBuiltIn: current?.native === true, scope: current?.native ? null : 'user',
      sources: { md: { exists: !current?.native, scope: 'user', path: `/config/agents/${name}.md` } } });
  }
  if (path.includes('/location')) return Response.json({ directory: DIRECTORY, project: { directory: DIRECTORY } });
  return Response.json({ data: [] });
});

const { useAgentsStore, invalidateAgentsLoadCache } = await import('./useAgentsStore');
const { useProjectsStore } = await import('./useProjectsStore');
const { useUIStore } = await import('./useUIStore');
const { AgentsSidebar } = await import('@/components/sections/agents/AgentsSidebar');
const { I18nProvider } = await import('@/lib/i18n');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  listedAgents = [agent('build', false, true), agent('title', true, true),
    agent('visible-custom'), agent('hidden-custom', true)];
  failingConfigLookups = new Set();
  useProjectsStore.setState({ projects: [{ id: 'project', path: DIRECTORY }], activeProjectId: 'project' });
  useUIStore.setState({ settingsProjectPath: null });
  invalidateAgentsLoadCache(DIRECTORY);
  useAgentsStore.setState({ agents: [], agentsByDirectory: {}, selectedAgentName: null, agentDraft: null });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

afterAll(() => {
  fetchSpy.mockRestore();
  browser.close();
});

const render = async () => {
  await act(async () => {
    await useAgentsStore.getState().loadAgents(DIRECTORY);
    root.render(<ThemeSystemProvider><I18nProvider><TooltipProvider><AgentsSidebar /></TooltipProvider></I18nProvider></ThemeSystemProvider>);
  });
};

describe('Settings hidden custom subagents', () => {
  test('renders hidden custom agents without exposing hidden built-ins or changing pickers', async () => {
    await render();
    expect(container.textContent).toContain('hidden-custom');
    expect(container.textContent).toContain('visible-custom');
    expect(container.textContent).toContain('build');
    expect(container.textContent).not.toContain('title');
    expect(container.textContent).toContain('Total 3');
    expect(useAgentsStore.getState().getVisibleAgents().map((entry) => entry.name)).toEqual(['build', 'visible-custom']);
  });

  test('keeps a hidden agent out when its config lookup fails', async () => {
    // v2 lists agents without a built-in flag; only the config lookup supplies it.
    const { native: _native, ...unflaggedTitle } = agent('title', true);
    listedAgents = [agent('build', false, true), unflaggedTitle, agent('hidden-custom', true)];
    failingConfigLookups = new Set(['title']);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await render();
    } finally {
      warn.mockRestore();
    }
    expect(container.textContent).toContain('hidden-custom');
    expect(container.textContent).not.toContain('title');
  });

  test('keeps the hidden flag from the stored entry when duplicating a custom agent', async () => {
    await render();
    const label = [...container.querySelectorAll('span')].find((entry) => entry.textContent === 'hidden-custom');
    const row = label?.closest('.group');
    const menu = row?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
    if (!menu) throw new Error('Missing hidden agent menu');
    await act(async () => menu.click());
    const duplicate = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.includes('Duplicate'));
    if (!duplicate) throw new Error('Missing Duplicate action');
    await act(async () => duplicate.click());
    expect(useAgentsStore.getState().agentDraft).toMatchObject({ name: 'hidden-custom-copy', hidden: true, system: 'Stored instructions' });
  });
});
