import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import { useMcpStore } from '@/stores/useMcpStore';
import { useUIStore } from '@/stores/useUIStore';
import type { McpServerStatus } from '@/lib/opencode/model';

// Imported once a DOM exists: the tooltip's layout effects check for one when
// their module loads.
let WorkStatusMcpSection: typeof import('./WorkStatusMcpSection').WorkStatusMcpSection;

let win: Window;
let root: Root;
let container: HTMLElement;
let restoreGlobals: () => void;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  win = new Window({ url: 'http://localhost' });
  const values = {
    window: win, document: win.document, navigator: win.navigator,
    Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
    HTMLButtonElement: win.HTMLButtonElement, HTMLInputElement: win.HTMLInputElement,
    HTMLIFrameElement: win.HTMLIFrameElement, SVGElement: win.SVGElement,
    Document: win.Document, DocumentFragment: win.DocumentFragment,
    DOMRect: win.DOMRect, Event: win.Event, CustomEvent: win.CustomEvent,
    MouseEvent: win.MouseEvent, KeyboardEvent: win.KeyboardEvent, FocusEvent: win.FocusEvent,
    MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
    localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  restoreGlobals = () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
  // No server: the section's freshness check finds the status below recent.
  globalThis.fetch = Object.assign(async () => new Response(null, { status: 503 }), originalFetch);
  ({ WorkStatusMcpSection } = await import('./WorkStatusMcpSection'));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

const previousExpanded = useUIStore.getState().workStatusExpandedSections;

afterEach(async () => {
  await act(async () => root.unmount());
  useUIStore.setState({ workStatusExpandedSections: previousExpanded });
  useMcpStore.getState().resetForRuntimeSwitch();
  globalThis.fetch = originalFetch;
  await win.happyDOM.close();
  restoreGlobals();
});

const server = (name: string, status: McpServerStatus['status']): McpServerStatus => ({ name, status });
const label = (name: string) => [...container.querySelectorAll('span[id]')].find((span) => span.textContent === name);

test('only a server that is not connected steps back', async () => {
  useMcpStore.setState({
    byDirectory: {
      '/repo': {
        live: server('live', { status: 'connected' }),
        off: server('off', { status: 'disabled' }),
      },
    },
    refreshedAtKeys: { '/repo': Date.now() },
  });
  // The section starts folded.
  useUIStore.setState({ workStatusExpandedSections: { mcp: true } });
  await act(async () => root.render(
    <I18nProvider>
      <WorkStatusMcpSection sessionId={null} directory="/repo" />
    </I18nProvider>,
  ));

  // Positive control: both rows rendered.
  expect(label('live')).toBeDefined();
  expect(label('off')).toBeDefined();
  expect(label('off')?.classList.contains('opacity-75')).toBe(true);
  expect(label('live')?.classList.contains('opacity-75')).toBe(false);
});
