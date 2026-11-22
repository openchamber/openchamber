import { act } from 'react';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { FormRequest, Message, Session } from '@/lib/opencode/model';
import { SyncProvider, createEventRoutingIndex, handleEvent } from '@/sync/sync-context';
import type { SyncEvent } from '@/lib/opencode/events';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getSyncChildStores } from '@/sync/sync-refs';
import { I18nProvider } from '@/lib/i18n';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { createWebAPIs } from '../../../../../web/src/api/index';
import { ChatColumnSessionContext } from '../chatColumnSession';
import { resetFormDrafts } from '../formDrafts';
import type { BtwPanelState } from './useBtwPanelState';

// React detects input-event support when its DOM renderer is first imported.
// Give that probe a document, then restore the caller's globals immediately.
const rendererWindow = new Window();
const rendererGlobals = ['window', 'document'] as const;
const previousRendererGlobals = rendererGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, 'window', { value: rendererWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: rendererWindow.document, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
for (const [name, descriptor] of previousRendererGlobals) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
rendererWindow.close();

const { BtwPanel } = await import('./BtwPanel');
const runtimeAPIs = createWebAPIs();

const unexpectedThemeChange = (): never => { throw new Error('Rendering must not change the theme'); };
const theme = getDefaultTheme(false);
const themeContext: ThemeContextValue = {
  currentTheme: theme,
  availableThemes: [theme],
  setTheme: unexpectedThemeChange,
  customThemesLoading: false,
  reloadCustomThemes: unexpectedThemeChange,
  importTheme: unexpectedThemeChange,
  deleteImportedTheme: unexpectedThemeChange,
  customThemeIds: [],
  isSystemPreference: false,
  setSystemPreference: unexpectedThemeChange,
  themeMode: 'light',
  setThemeMode: unexpectedThemeChange,
  lightThemeId: theme.metadata.id,
  darkThemeId: getDefaultTheme(true).metadata.id,
  setLightThemePreference: unexpectedThemeChange,
  setDarkThemePreference: unexpectedThemeChange,
};

const PARENT_DIRECTORY = '/repo/chat';
const FORM_ID = 'frm_same';

type Fork = { parentId: string; forkId: string; directory: string };

const forkSession = ({ parentId, forkId, directory }: Fork): Session => ({
  id: forkId,
  parentID: parentId,
  projectID: 'project',
  directory,
  title: 'btw',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
});

const forkMessage = (forkId: string): Message => ({
  id: `msg_${forkId}`,
  sessionID: forkId,
  role: 'assistant',
  time: { created: 1, completed: 2 },
  modelID: 'model',
  providerID: 'provider',
  agent: 'build',
});

const forkForm = (forkId: string): FormRequest => ({
  id: FORM_ID,
  sessionID: forkId,
  title: 'A note',
  fields: [{ key: 'note', type: 'string', title: 'Note' }],
});

const panelFor = (fork: Fork): BtwPanelState => ({
  parentPromoted: false,
  btwSessionId: fork.forkId,
  btwDirectory: fork.directory,
  boundaryMessageID: null,
  collapsed: false,
  creating: false,
  pending: false,
});

let happyWindow: Window;
let previous: Array<readonly [string, PropertyDescriptor | undefined]>;
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  resetFormDrafts();
  happyWindow = new Window({ url: 'http://localhost' });
  const globals = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    localStorage: happyWindow.localStorage,
    customElements: happyWindow.customElements,
    Node: happyWindow.Node,
    Text: happyWindow.Text,
    NodeList: happyWindow.NodeList,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    HTMLTextAreaElement: happyWindow.HTMLTextAreaElement,
    SVGElement: happyWindow.SVGElement,
    Event: happyWindow.Event,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
    ResizeObserver: happyWindow.ResizeObserver,
    MutationObserver: happyWindow.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  previous = Object.keys(globals).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  await happyWindow.happyDOM.abort();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const noteBox = () => container.querySelector<HTMLTextAreaElement>('textarea');

const sdk = OpenCode.make({
  baseUrl: 'http://localhost',
  fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }),
});
const tree = (parentId: string, fork: Fork | null) => (
  <SyncProvider sdk={sdk} directory={PARENT_DIRECTORY}>
    <RuntimeAPIContext.Provider value={runtimeAPIs}>
      <I18nProvider>
        <ThemeSystemContext.Provider value={themeContext}>
          <TooltipProvider>
            <ChatColumnSessionContext.Provider value={{ sessionId: parentId, directory: PARENT_DIRECTORY }}>
              {fork ? <BtwPanel parentSessionId={parentId} panel={panelFor(fork)} hidden={false} onExit={() => {}} /> : null}
            </ChatColumnSessionContext.Provider>
          </TooltipProvider>
        </ThemeSystemContext.Provider>
      </I18nProvider>
    </RuntimeAPIContext.Provider>
  </SyncProvider>
);
const setForkForms = (fork: Fork, forms: FormRequest[]) => {
  getSyncChildStores().ensureChild(fork.directory, { bootstrap: false }).setState((state) => ({
    session: [...state.session.filter((item) => item.id !== fork.forkId), forkSession(fork)],
    message: { ...state.message, [fork.forkId]: [forkMessage(fork.forkId)] },
    part: { ...state.part, [`msg_${fork.forkId}`]: [] },
    form: { ...state.form, [fork.forkId]: forms },
  }));
};
const typeNote = async (text: string) => {
  const box = noteBox();
  if (!box) throw new Error('missing card');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

// A caller can choose the id of a form, so two /btw forks of two parent sessions can each hold a form with the
// same id. The panel stays mounted when the chat moves to the other parent: the second card must start empty,
// and the first must get its own unsent answer back when the chat returns to it.
test('a /btw form with the same id in another parent session starts empty and keeps its own answer', async () => {
  const first: Fork = { parentId: 'ses_parent_a', forkId: 'ses_fork_a', directory: '/private/repo/fork-a' };
  for (const second of [
    { parentId: 'ses_parent_b', forkId: 'ses_fork_b', directory: '/private/repo/fork-b' },
    { parentId: 'ses_parent_b', forkId: 'ses_fork_b', directory: first.directory },
  ] satisfies Fork[]) {
    const label = `${first.directory} then ${second.directory}`;
    await act(async () => { root.render(tree(first.parentId, null)); });
    for (const fork of [first, second]) setForkForms(fork, [forkForm(fork.forkId)]);

    await act(async () => { root.render(tree(first.parentId, first)); });
    await typeNote('typed in the first fork');
    expect([label, noteBox()?.value]).toEqual([label, 'typed in the first fork']);

    await act(async () => { root.render(tree(second.parentId, second)); });
    expect([label, [...container.querySelectorAll('textarea')].map((item) => item.value)]).toEqual([label, ['']]);

    await act(async () => { root.render(tree(first.parentId, first)); });
    expect([label, [...container.querySelectorAll('textarea')].map((item) => item.value)]).toEqual([label, ['typed in the first fork']]);
    await act(async () => { root.render(tree(second.parentId, second)); });
    expect([label, [...container.querySelectorAll('textarea')].map((item) => item.value)]).toEqual([label, ['']]);
  }
});

// Another client settles the form, OpenCode expires it, and a plugin asks a new question under the same id in the
// same fork. The answer typed for the settled form must not show up in the new one.
test('a /btw form settled elsewhere leaves no answer for a later form that reuses its id', async () => {
  const fork: Fork = { parentId: 'ses_parent_a', forkId: 'ses_fork_a', directory: '/private/repo/fork-a' };
  await act(async () => { root.render(tree(fork.parentId, null)); });
  setForkForms(fork, [forkForm(fork.forkId)]);
  await act(async () => { root.render(tree(fork.parentId, fork)); });
  await typeNote('answer for the old question');

  await act(async () => { setForkForms(fork, []); });
  expect(noteBox()).toBeNull();
  await act(async () => { setForkForms(fork, [{ ...forkForm(fork.forkId), title: 'A different question' }]); });
  expect(noteBox()?.value).toBe('');
});

// The same, while the chat shows another parent: the panel never sees the old form leave, only OpenCode's events
// for that fork. Coming back to the fork must not fill the new question with the old answer.
test('a /btw form settled and reused while the chat shows another parent comes back empty', async () => {
  const fork: Fork = { parentId: 'ses_parent_a', forkId: 'ses_fork_a', directory: '/private/repo/fork-a' };
  const other: Fork = { parentId: 'ses_parent_b', forkId: 'ses_fork_b', directory: '/private/repo/fork-b' };
  await act(async () => { root.render(tree(fork.parentId, null)); });
  for (const item of [fork, other]) setForkForms(item, [forkForm(item.forkId)]);
  await act(async () => { root.render(tree(fork.parentId, fork)); });
  await typeNote('answer for the old question');
  await act(async () => { root.render(tree(other.parentId, other)); });

  const events: SyncEvent[] = [
    { type: 'form.settled', properties: { sessionID: fork.forkId, formID: FORM_ID } },
    { type: 'form.created', properties: { form: { ...forkForm(fork.forkId), title: 'A different question' } } },
  ];
  await act(async () => {
    for (const event of events) handleEvent(fork.directory, event, getSyncChildStores(), createEventRoutingIndex(), getRuntimeKey());
  });
  await act(async () => { root.render(tree(fork.parentId, fork)); });
  expect(noteBox()?.value).toBe('');
});
