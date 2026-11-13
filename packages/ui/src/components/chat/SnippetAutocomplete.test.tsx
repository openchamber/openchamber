import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { Snippet } from '@/types/snippet';
import type { SnippetAutocompleteHandle } from './SnippetAutocomplete';

let SnippetAutocomplete: typeof import('./SnippetAutocomplete')['SnippetAutocomplete'];
let I18nProvider: typeof import('@/lib/i18n')['I18nProvider'];
let useSnippetsStore: typeof import('@/stores/useSnippetsStore')['useSnippetsStore'];
let dom: Window;
let root: Root;
let host: HTMLDivElement;
let restore: Array<() => void>;
const globals = new Map<string, PropertyDescriptor | undefined>();

const snippet = (name: string, aliases: string[] = []): Snippet => ({
  name,
  content: `${name} body`,
  aliases,
  filePath: `/snippets/${name}.md`,
  source: 'global',
});

beforeEach(async () => {
  dom = new Window({ url: 'http://localhost' });
  const values = {
    window: dom, document: dom.document, navigator: dom.navigator,
    localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
    Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
    HTMLInputElement: dom.HTMLInputElement, HTMLButtonElement: dom.HTMLButtonElement,
    SVGElement: dom.SVGElement, Document: dom.Document, ShadowRoot: dom.ShadowRoot,
    Event: dom.Event, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent,
    KeyboardEvent: dom.KeyboardEvent, CustomEvent: dom.CustomEvent,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(values)) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined));
  ({ I18nProvider } = await import('@/lib/i18n'));
  ({ SnippetAutocomplete } = await import('./SnippetAutocomplete'));
  ({ useSnippetsStore } = await import('@/stores/useSnippetsStore'));
  const { useUIStore } = await import('@/stores/useUIStore');
  const priorSnippets = useSnippetsStore.getState();
  const priorUI = useUIStore.getState();
  restore = [
    () => fetch.mockRestore(),
    () => useSnippetsStore.setState(priorSnippets),
    () => useUIStore.setState(priorUI),
  ];
  useUIStore.setState({ isMobile: false });
  useSnippetsStore.setState({ snippets: [snippet('fix-pr', ['ship']), snippet('deploy')], loadSnippets: async () => true, quickCreate: null });
  host = document.createElement('div');
  document.body.appendChild(host);
  const { createRoot } = await import('react-dom/client');
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  restore.forEach((undo) => undo());
  host.remove();
  await dom.happyDOM.close();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  globals.clear();
});

const rowLabels = () => Array.from(host.querySelectorAll<HTMLElement>('.cursor-pointer')).map((row) => row.textContent?.trim());

async function mountPicker(searchQuery: string, draftText?: string) {
  const handle = React.createRef<SnippetAutocompleteHandle>();
  const selected: string[] = [];
  const saved: string[] = [];
  await act(async () => root.render(
    <I18nProvider>
      <SnippetAutocomplete
        ref={handle}
        searchQuery={searchQuery}
        onClose={() => undefined}
        onSnippetSelect={(_snippet, trigger) => selected.push(trigger)}
        draftText={draftText}
        onDraftSaved={(name) => saved.push(name)}
      />
    </I18nProvider>,
  ));
  const press = (key: string) => act(async () => handle.current?.handleKeyDown(key));
  return { press, selected, saved };
}

test('a new name in a draft offers to save the draft first, and Enter opens the dialog without writing', async () => {
  const { press, saved } = await mountPicker('ship-it', 'Run the CI and push');
  expect(rowLabels().slice(0, 2)).toEqual(['Save draft as #ship-it', 'Create #ship-it']);

  await press('Enter');
  const request = useSnippetsStore.getState().quickCreate;
  expect(request?.name).toBe('ship-it');
  expect(request?.content).toBe('Run the CI and push');
  // The token leaves the composer only once the dialog saves.
  expect(saved).toEqual([]);
  request?.onSaved?.('ship-it');
  expect(saved).toEqual(['ship-it']);
});

test('a name a snippet answers to offers no create row, and Enter picks the match', async () => {
  const { press, selected } = await mountPicker('ship', 'Run the CI');
  expect(rowLabels()).not.toContain('Create #ship');
  expect(rowLabels()[0]).toBe('Add new snippet');

  await press('Enter');
  expect(selected).toEqual(['ship']);
  expect(useSnippetsStore.getState().quickCreate).toBeNull();
});

test('an empty draft offers only to create the typed name', async () => {
  await mountPicker('brand-new', '  ');
  expect(rowLabels()[0]).toBe('Create #brand-new');
  expect(rowLabels()).not.toContain('Save draft as #brand-new');
});
