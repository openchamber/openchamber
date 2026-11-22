import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { Session, SubagentPolicy } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSubsessionDraftStore } from '@/stores/useSubsessionDraftStore';
import { useUIStore } from '@/stores/useUIStore';

/**
 * The subsession models picker opened, used and reopened as a person would:
 * through its footer button, the shared model list, and the store or session
 * record the choice lands in. The oracle for what is checked is the draft
 * store or the re-read session record, never the component's own state.
 */

// Base UI and React DOM probe for a DOM when first imported.
const importWindow = new Window();
const importGlobals = ['window', 'document'] as const;
const previousImportGlobals = importGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, 'window', { value: importWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: importWindow.document, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { SubsessionModelsControl } = await import('./SubsessionModelsControl');
for (const [name, descriptor] of previousImportGlobals) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
void importWindow.happyDOM.close();

const directory = '/repo';
const sessionId = 'ses_parent';

const catalogModel = (providerID: string, modelID: string, name: string) => ({
  id: modelID,
  modelID,
  providerID,
  name,
  capabilities: { tools: true, input: ['text'], output: ['text'] },
  variants: [],
  time: { released: 0 },
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  status: 'active' as const,
  enabled: true,
  limit: { context: 0, output: 0 },
});

const providers = [{
  id: 'lab',
  name: 'Lab',
  activation: 'enabled' as const,
  package: 'lab',
  models: [catalogModel('lab', 'alpha', 'Alpha'), catalogModel('lab', 'beta', 'Beta'), catalogModel('lab', 'gamma', 'Gamma')],
}];

const sessionWith = (subagentPolicy: SubagentPolicy | undefined): Session => ({
  id: sessionId, projectID: 'project', directory, title: 'parent', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 1 },
  subagentPolicy,
});

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT', 'Event', 'CustomEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'FocusEvent', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver'] as const;
const installDom = () => {
  const win = new Window({ url: 'http://localhost', width: 1280, height: 800 });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = { window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element,
    HTMLElement: win.HTMLElement, HTMLInputElement: win.HTMLInputElement, localStorage: win.localStorage,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
    Event: win.Event, CustomEvent: win.CustomEvent, MouseEvent: win.MouseEvent, PointerEvent: win.PointerEvent,
    KeyboardEvent: win.KeyboardEvent, FocusEvent: win.FocusEvent, MutationObserver: win.MutationObserver,
    ResizeObserver: win.ResizeObserver, IntersectionObserver: win.IntersectionObserver };
  for (const name of DOM_GLOBAL_NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  // happy-dom lays nothing out; the list's scroller gets a menu's height so
  // the virtual list mounts the rows in view, as it does in a browser.
  for (const [name, size] of [['clientHeight', 400], ['clientWidth', 380]] as const) {
    Object.defineProperty(win.HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains('overlay-scrollbar-target') ? size : 0; },
    });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container, restore: () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    void win.happyDOM.close();
  } };
};

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });

const trigger = () => {
  const button = document.querySelector<HTMLButtonElement>('button[aria-label="Subsession models"]');
  if (!button) throw new Error('Expected the subsession models button');
  return button;
};

const toggleMenu = async () => {
  await act(async () => { trigger().click(); });
  await settle();
};

const isOpen = () => document.querySelector('[role="listbox"]') !== null;

const nameOf = (option: Element) => option.querySelector('[id$="-name"]')?.textContent ?? '';

const row = (name: string) => {
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((element) => nameOf(element) === name);
  if (!option) throw new Error(`Expected a row for ${name}`);
  return option;
};

const checkedNames = () => Array.from(document.querySelectorAll('[role="option"][aria-selected="true"]')).map(nameOf);

const searchField = () => {
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]');
  if (!input) throw new Error('Expected the search field');
  return input;
};

const pressKey = async (key: string) => {
  await act(async () => {
    searchField().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
  await settle();
};

describe('SubsessionModelsControl', () => {
  let root: Root;
  let dom: ReturnType<typeof installDom>;
  let restoreFetch: () => void;
  const sdk = OpenCode.make({ baseUrl: 'http://subsession.test', fetch: () => new Promise<Response>(() => undefined) });

  const render = (props: { sessionId: string | null; draftOpen?: boolean }) => act(async () => root.render(
    <SyncProvider sdk={sdk} directory={directory}>
      <I18nProvider>
        <SubsessionModelsControl
          sessionId={props.sessionId}
          directory={directory}
          draftOpen={props.draftOpen}
          footerIconButtonClass=""
          iconSizeClass=""
        />
      </I18nProvider>
    </SyncProvider>,
  ));

  beforeEach(() => {
    dom = installDom();
    // The stores read here start background loads; keep them pending.
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined));
    restoreFetch = () => fetch.mockRestore();
    useConfigStore.setState({ providers });
    useUIStore.setState({ hiddenModels: [], favoriteModels: [], recentModels: [], providerOrder: [] });
    useSubsessionDraftStore.setState({ models: [] });
    root = createRoot(dom.container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    restoreFetch();
    dom.restore();
  });

  test('in a new-session draft a click and Enter check models, the menu stays open, and reopening shows them', async () => {
    await render({ sessionId: null, draftOpen: true });
    await toggleMenu();
    expect(isOpen()).toBe(true);
    expect(checkedNames()).toEqual([]);

    await act(async () => { row('Beta').click(); });
    await settle();
    expect(useSubsessionDraftStore.getState().models).toEqual(['lab/beta']);
    expect(isOpen()).toBe(true);

    // The highlight starts on the first row; Enter checks it like the main picker chooses it.
    await pressKey('Enter');
    expect(useSubsessionDraftStore.getState().models).toEqual(['lab/beta', 'lab/alpha']);
    expect(isOpen()).toBe(true);

    await pressKey('Escape');
    expect(isOpen()).toBe(false);

    await toggleMenu();
    expect(isOpen()).toBe(true);
    expect(checkedNames()).toEqual(['Alpha', 'Beta']);

    // Choosing a checked row unchecks it.
    await act(async () => { row('Alpha').click(); });
    await settle();
    expect(useSubsessionDraftStore.getState().models).toEqual(['lab/beta']);
  });

  test('the search field filters the list like the main picker', async () => {
    await render({ sessionId: null, draftOpen: true });
    await toggleMenu();
    await act(async () => {
      const input = searchField();
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(input, 'gam');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    const names = Array.from(document.querySelectorAll('[role="option"]')).map(nameOf);
    expect(names).toEqual(['Gamma']);
  });

  test('on a session, quick toggles save in order to that session and reopening shows the saved record', async () => {
    let record = sessionWith({ models: ['other/*', 'lab/alpha'], excludedModels: ['lab/old'] });
    const writes: Array<{ id: string; policy: SubagentPolicy; directory: string | null | undefined }> = [];
    const releases: Array<() => void> = [];
    const updateSpy = spyOn(opencodeClient, 'updateSessionSubagentPolicy').mockImplementation((id, policy, writeDirectory) => {
      writes.push({ id, policy, directory: writeDirectory });
      return new Promise<void>((resolve) => {
        releases.push(() => {
          record = sessionWith(policy);
          resolve();
        });
      });
    });
    const getSpy = spyOn(opencodeClient, 'getSession').mockImplementation(async () => record);

    try {
      await render({ sessionId, draftOpen: false });
      await act(async () => {
        getSyncChildStores().getChild(directory)?.setState({ session: [record] });
      });
      await toggleMenu();
      expect(checkedNames()).toEqual(['Alpha']);
      // Entries set through config stay visible as read-only lines.
      expect(document.body.textContent).toContain('other/*');

      // Two toggles before the first save settles: both show at once. A
      // language change between them must not start a second save queue.
      await act(async () => { row('Beta').click(); });
      await act(async () => { useI18nStore.getState().setLocale('de'); });
      await settle();
      await act(async () => { row('Gamma').click(); });
      await settle();
      expect(checkedNames()).toEqual(['Alpha', 'Beta', 'Gamma']);
      expect(writes).toHaveLength(1);
      await act(async () => { useI18nStore.getState().setLocale('en'); });
      await settle();

      await act(async () => { releases[0]?.(); });
      await settle();
      expect(writes).toHaveLength(2);
      await act(async () => { releases[1]?.(); });
      await settle();

      expect(writes.map((write) => write.id)).toEqual([sessionId, sessionId]);
      expect(writes.map((write) => write.directory)).toEqual([directory, directory]);
      expect(writes[1]?.policy).toEqual({ models: ['other/*', 'lab/alpha', 'lab/beta', 'lab/gamma'], excludedModels: ['lab/old'] });

      await pressKey('Escape');
      expect(isOpen()).toBe(false);
      await toggleMenu();
      // Nothing is pending now: the checks come from the re-read session record.
      expect(checkedNames()).toEqual(['Alpha', 'Beta', 'Gamma']);
      expect(getSyncChildStores().getChild(directory)?.getState().session.find((session) => session.id === sessionId)?.subagentPolicy?.models)
        .toEqual(['other/*', 'lab/alpha', 'lab/beta', 'lab/gamma']);
    } finally {
      updateSpy.mockRestore();
      getSpy.mockRestore();
    }
  });
});
