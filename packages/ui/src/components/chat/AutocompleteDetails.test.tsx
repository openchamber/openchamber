import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
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
    skillsByDirectory: { [directory]: [{ name: 'oc-scroll', description: 'First details', scope: 'project', source: 'agents', path: `${directory}/skills/oc-scroll/SKILL.md` }] },
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

const waitForDetails = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 230));
});
const details = () => document.querySelector('[data-slot="tooltip-content"]');
const row = (index = 0) => {
  const result = host.querySelectorAll<HTMLElement>('.cursor-pointer')[index];
  if (!result) throw new Error(`Missing autocomplete row ${index}`);
  return result;
};
const scrollList = (scroller: HTMLElement, top: number) => act(async () => {
  scroller.scrollTop = top;
  scroller.dispatchEvent(new Event('scroll'));
});
const moveToRow = (index = 0) => act(async () => {
  row(index).dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 30, clientY: 30 }));
});

async function mountPicker(kind: 'command' | 'skill') {
  const handle = React.createRef<CommandAutocompleteHandle>();
  let closes = 0;
  function Picker() {
    const [open, setOpen] = React.useState(true);
    const close = () => { closes += 1; setOpen(false); };
    return <>
      <input defaultValue={draft} onKeyDown={(event) => handle.current?.handleKeyDown(event.key)} />
      {open && (kind === 'command'
        ? <CommandAutocomplete ref={handle} searchQuery="oc-scroll" onClose={close} onCommandSelect={(item) => selections.push(item.name)} />
        : <SkillAutocomplete ref={handle} searchQuery="oc-scroll" onClose={close} onSkillSelect={(name) => selections.push(name)} />)}
    </>;
  }
  await act(async () => root.render(
    <SyncProvider sdk={sdk} directory=""><I18nProvider><Picker /></I18nProvider></SyncProvider>,
  ));
  const scroller = host.querySelector<HTMLElement>('.overlay-scrollbar-target');
  const input = host.querySelector('input');
  if (!scroller || !input) throw new Error('Missing autocomplete list or draft');
  const press = (key: string) => act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key }));
  });
  return { scroller, input, press, closes: () => closes };
}

// Happy DOM has no layout. Model the synchronous movement and deferred native
// scroll event, leaving browser scrollIntoView acceptance to a live run.
function modelScrollIntoView(target: HTMLElement, scroller: HTMLElement, top: number) {
  Object.defineProperty(target, 'scrollIntoView', { configurable: true, value: () => {
    scroller.scrollTop = top;
    window.setTimeout(() => scroller.dispatchEvent(new Event('scroll')), 0);
  } });
}

for (const kind of ['command', 'skill'] as const) {
  test(`${kind}: scroll closes details, preserves selection and requires fresh hover`, async () => {
    const { scroller, input, press, closes } = await mountPicker(kind);
    expect(details() === null).toBe(true);
    await waitForDetails();
    expect(details()?.textContent).toBe('First details');
    const unrelated = document.createElement('div');
    document.body.appendChild(unrelated);
    await scrollList(unrelated, 20);
    expect(details() !== null).toBe(true);
    unrelated.remove();
    await scrollList(scroller, 20);
    expect(details() === null).toBe(true);
    expect(row().classList.contains('bg-interactive-selection')).toBe(true);
    await waitForDetails();
    expect(details() === null).toBe(true);
    await moveToRow();
    expect(details() === null).toBe(true);
    await waitForDetails();
    expect(details()?.textContent).toBe('First details');
    expect(closes()).toBe(0);
    expect(input.value).toBe(draft);
    expect(selections).toEqual([]);
    await press('Enter');
    await press('Tab');
    expect(selections).toEqual(['oc-scroll', 'oc-scroll']);
    await press('Escape');
    expect(closes()).toBe(1);
    expect(host.querySelector('.overlay-scrollbar-target') === null).toBe(true);
    expect(details() === null).toBe(true);
  });

  test(`${kind}: scrolling cancels the delay and suppresses hover until a new interaction`, async () => {
    const { scroller, input, press } = await mountPicker(kind);
    for (const top of [20, 40, 60]) {
      await scrollList(scroller, top);
      await moveToRow();
    }
    await waitForDetails();
    expect(details() === null).toBe(true);
    modelScrollIntoView(row(), scroller, 0);
    await press('ArrowDown');
    await waitForDetails();
    expect(scroller.scrollTop).toBe(0);
    expect(details()?.textContent).toBe('First details');
    await scrollList(scroller, 10);
    expect(details() === null).toBe(true);
    await press('ArrowUp');
    await press('Escape');
    await waitForDetails();
    expect(details() === null).toBe(true);
    expect(input.value).toBe(draft);
    expect(selections).toEqual([]);
  });

  test(`${kind}: keyboard navigation across rows survives its own scrolling`, async () => {
    const { useCommandsStore } = await import('@/stores/useCommandsStore');
    const { useSkillsStore } = await import('@/stores/useSkillsStore');
    const commands = useCommandsStore.getState().commandsByDirectory[directory];
    const skills = useSkillsStore.getState().skillsByDirectory[directory];
    const firstCommand = commands?.[0];
    const firstSkill = skills?.[0];
    if (!firstCommand || !firstSkill) throw new Error('Missing autocomplete fixtures');
    useCommandsStore.setState({ commandsByDirectory: { [directory]: [firstCommand, { ...firstCommand, name: 'oc-scroll-next', description: 'Next details' }] } });
    useSkillsStore.setState({ skillsByDirectory: { [directory]: [firstSkill, { ...firstSkill, name: 'oc-scroll-next', description: 'Next details' }] } });
    const { scroller, input, press } = await mountPicker(kind);
    await waitForDetails();
    await scrollList(scroller, 50);
    modelScrollIntoView(row(1), scroller, 100);
    await press('ArrowDown');
    await waitForDetails();
    expect(scroller.scrollTop).toBe(100);
    expect(details()?.textContent).toBe('Next details');
    expect(row(1).classList.contains('bg-interactive-selection')).toBe(true);
    await press('Enter');
    expect(selections).toEqual(['oc-scroll-next']);
    modelScrollIntoView(row(), scroller, 0);
    await press('ArrowDown');
    await waitForDetails();
    expect(details()?.textContent).toBe('First details');
    expect(row().classList.contains('bg-interactive-selection')).toBe(true);
    await scrollList(scroller, 30);
    expect(details() === null).toBe(true);
    await waitForDetails();
    await moveToRow(1);
    await waitForDetails();
    expect(details()?.textContent).toBe('Next details');
    await act(async () => row(1).click());
    expect(selections).toEqual(['oc-scroll-next', 'oc-scroll-next']);
    expect(input.value).toBe(draft);
  });

  test(`${kind}: closing the list cancels a pending detail`, async () => {
    const { press, input } = await mountPicker(kind);
    await press('Escape');
    await waitForDetails();
    expect(details() === null).toBe(true);
    expect(input.value).toBe(draft);
  });

  test(`${kind}: sustained scrolling stays closed beyond the display delay`, async () => {
    const { scroller, input, closes } = await mountPicker(kind);
    await waitForDetails();
    expect(details()?.textContent).toBe('First details');
    for (const top of [20, 40, 60, 80, 100]) {
      await scrollList(scroller, top);
      await moveToRow();
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
      expect(details() === null).toBe(true);
    }
    await waitForDetails();
    expect(details() === null).toBe(true);
    await moveToRow();
    expect(details() === null).toBe(true);
    await waitForDetails();
    expect(details()?.textContent).toBe('First details');
    expect(closes()).toBe(0);
    expect(input.value).toBe(draft);
    expect(selections).toEqual([]);
  });

  test(`${kind}: keyboard navigation does not swallow a pending manual scroll`, async () => {
    const { scroller, press } = await mountPicker(kind);
    await waitForDetails();
    // A wheel can update the offset before its scroll event is delivered.
    // Selecting an already visible row must not record that movement as ours.
    scroller.scrollTop = 30;
    modelScrollIntoView(row(), scroller, 30);
    await press('ArrowDown');
    await waitForDetails();
    expect(details() === null).toBe(true);
    await press('ArrowUp');
    await waitForDetails();
    expect(details()?.textContent).toBe('First details');
    await scrollList(scroller, 60);
    expect(details() === null).toBe(true);
  });
}
