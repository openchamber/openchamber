import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window, type HTMLElement as HappyHTMLElement } from 'happy-dom';
import { OpenCode } from '@opencode/client';

import type { CommandAutocompleteHandle } from './CommandAutocomplete';

let CommandAutocomplete: typeof import('./CommandAutocomplete')['CommandAutocomplete'];
let SkillAutocomplete: typeof import('./SkillAutocomplete')['SkillAutocomplete'];
let I18nProvider: typeof import('@/lib/i18n')['I18nProvider'];
let SyncProvider: typeof import('@/sync/sync-context')['SyncProvider'];
let dom: Window;
let root: Root;
let host: HTMLDivElement;
let selections: string[];
let restoreStores: Array<() => void>;
let restoreFetch: () => void;
const globals = new Map<string, PropertyDescriptor | undefined>();
const directory = '/autocomplete-test';
const draft = 'https://example.com/a/b';
const sdk = OpenCode.make({ baseUrl: 'http://autocomplete.test', fetch: () => new Promise<Response>(() => undefined) });

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
  // Keep unrelated bootstrap requests pending while exercising the real pickers.
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined));
  restoreFetch = () => fetch.mockRestore();
  ({ I18nProvider } = await import('@/lib/i18n'));
  ({ SyncProvider } = await import('@/sync/sync-context'));
  ({ CommandAutocomplete } = await import('./CommandAutocomplete'));
  ({ SkillAutocomplete } = await import('./SkillAutocomplete'));
  const { useCommandsStore } = await import('@/stores/useCommandsStore');
  const { useSkillsStore } = await import('@/stores/useSkillsStore');
  const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
  const { useUIStore } = await import('@/stores/useUIStore');
  const priorCommands = useCommandsStore.getState();
  const priorSkills = useSkillsStore.getState();
  const priorDirectory = useDirectoryStore.getState();
  const priorUI = useUIStore.getState();
  restoreStores = [
    () => useCommandsStore.setState(priorCommands),
    () => useSkillsStore.setState(priorSkills),
    () => useDirectoryStore.setState(priorDirectory),
    () => useUIStore.setState(priorUI),
  ];
  useDirectoryStore.setState({ currentDirectory: directory });
  useUIStore.setState({ isMobile: false });
  useCommandsStore.setState({
    commandsByDirectory: { [directory]: [{ name: 'oc-scroll', description: 'First details', scope: 'project' }] },
    loadCommands: async () => true,
  });
  useSkillsStore.setState({
    skillsByDirectory: { [directory]: [{ id: 'oc-scroll', name: 'oc-scroll', description: 'First details', scope: 'project', source: 'agents', path: `${directory}/skills/oc-scroll/SKILL.md` }] },
    loadSkills: async () => true,
  });
  selections = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  const { createRoot } = await import('react-dom/client');
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  restoreStores.forEach((restore) => restore());
  restoreFetch();
  host.remove();
  await dom.happyDOM.close();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  globals.clear();
});

const details = () => document.querySelector('[data-slot="tooltip-content"]');
const row = (index = 0) => {
  const result = host.querySelectorAll<HTMLElement>('.cursor-pointer')[index];
  if (!result) throw new Error(`Missing autocomplete row ${index}`);
  return result;
};

async function mountPicker(kind: 'command' | 'skill') {
  const handle = React.createRef<CommandAutocompleteHandle>();
  function Picker() {
    return <>
      <input defaultValue={draft} onKeyDown={(event) => handle.current?.handleKeyDown(event.key)} />
      {kind === 'command'
        ? <CommandAutocomplete ref={handle} searchQuery="oc-scroll" onClose={() => undefined} onCommandSelect={(item) => selections.push(item.name)} />
        : <SkillAutocomplete ref={handle} searchQuery="oc-scroll" onClose={() => undefined} onSkillSelect={(name) => selections.push(name)} />}
    </>;
  }
  await act(async () => root.render(
    <SyncProvider sdk={sdk} directory=""><I18nProvider><Picker /></I18nProvider></SyncProvider>,
  ));
  const input = host.querySelector('input');
  if (!input) throw new Error('Missing draft');
  const press = (key: string) => act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key }));
  });
  return { press };
}

for (const kind of ['command', 'skill'] as const) {
  test(`${kind}: the row reads name, description, then its scope; nothing pops up on selection`, async () => {
    const { press } = await mountPicker(kind);
    const item = row();
    expect(Array.from(item.querySelectorAll('.uppercase')).map((badge) => badge.textContent)).toEqual(['project']);
    expect(item.querySelector('.font-normal')?.textContent).toBe('First details');

    await act(async () => {
      item.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 30, clientY: 30 }));
      await new Promise((resolve) => setTimeout(resolve, 260));
    });
    await press('ArrowDown');
    expect(details()).toBeNull();
    await press('Enter');
    expect(selections).toEqual(['oc-scroll']);
  });

  test(`${kind}: a list placed below the caret keeps the height its placement gave it`, async () => {
    // A list placed below the line grows downward: its bottom edge is its top
    // plus its height, here 12px under the chat area's top. The phone's
    // keyboard puts a composer there (#5687).
    const rect = spyOn(dom.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HappyHTMLElement) {
      const top = this.tagName === 'MAIN' ? 288 : 300;
      const height = this.classList.contains('oc-glass-popover') ? Number.parseFloat(this.style.maxHeight) || 256 : 0;
      return new dom.DOMRect(0, top, 378, height);
    });
    const placed = { top: '48px', bottom: 'auto', maxHeight: '120px' };
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory="">
        <I18nProvider>
          <main>
            {kind === 'command'
              ? <CommandAutocomplete searchQuery="" onClose={() => undefined} onCommandSelect={() => undefined} style={placed} />
              : <SkillAutocomplete searchQuery="" onClose={() => undefined} onSkillSelect={() => undefined} style={placed} />}
          </main>
        </I18nProvider>
      </SyncProvider>,
    ));
    rect.mockRestore();
    expect(host.querySelector<HTMLElement>('.oc-glass-popover')?.style.maxHeight).toBe('120px');
  });
}

test('skill: loads in one row until the project\'s skills are read, then says there are none at the same height', async () => {
  const { useSkillsStore } = await import('@/stores/useSkillsStore');
  useSkillsStore.setState({ skillsByDirectory: {} });
  const picker = <SyncProvider sdk={sdk} directory=""><I18nProvider><SkillAutocomplete searchQuery="" onClose={() => undefined} onSkillSelect={() => undefined} /></I18nProvider></SyncProvider>;
  await act(async () => root.render(picker));
  const loadingRow = host.querySelector('[data-spinner]')?.closest('div');
  expect(loadingRow).not.toBeNull();
  expect(host.textContent).not.toContain('No skills found');

  await act(async () => useSkillsStore.setState({ skillsByDirectory: { [directory]: [] } }));
  expect(host.querySelector('[data-spinner]')).toBeNull();
  const emptyRow = Array.from(host.querySelectorAll('div')).filter((node) => node.textContent === 'No skills found').pop();
  // The same box, so the popup keeps its height between the two.
  expect(emptyRow?.className.split(' ').filter((name) => name.startsWith('p'))).toEqual(
    loadingRow?.className.split(' ').filter((name) => name.startsWith('p')),
  );
});
