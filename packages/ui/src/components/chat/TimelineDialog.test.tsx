import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { Part, Session, UserMessage } from '@/lib/opencode/model';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { ChatColumnSessionContext } from './chatColumnSession';

// React DOM and the Base UI dialog probe for a DOM when first imported; without
// one the dialog never mounts its popup. Give the probe a document, then
// restore the caller's globals.
const importWindow = new Window();
const importGlobals = ['window', 'document'] as const;
const previousImportGlobals = importGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, 'window', { value: importWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: importWindow.document, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { TimelineDialog } = await import('./TimelineDialog');
for (const [name, descriptor] of previousImportGlobals) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
void importWindow.happyDOM.close();

const directory = '/repo';
const sessionId = 'session-1';
const column = { sessionId, directory };
const session: Session = {
  id: sessionId, projectID: 'project', directory, title: 'test', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 1 },
};
const user = (id: string, created: number): UserMessage => ({ id, sessionID: sessionId, role: 'user', time: { created } });

// Counts every read of a part's text: the timeline reads it to build each
// row's preview, so the count is the work the dialog does on a store update.
let textReads = 0;
const countedText = (id: string, messageID: string, value: string): Part => {
  const part: Part = { id, sessionID: sessionId, messageID, type: 'text', text: value };
  Object.defineProperty(part, 'text', {
    enumerable: true,
    get: () => {
      textReads += 1;
      return value;
    },
  });
  return part;
};

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const installDom = () => {
  const win = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = { window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element,
    HTMLElement: win.HTMLElement, localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true };
  for (const name of DOM_GLOBAL_NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
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

describe('TimelineDialog', () => {
  let root: Root;
  let dom: ReturnType<typeof installDom>;
  // Bootstrap stays pending, so each test owns the directory store's contents.
  const sdk = OpenCode.make({ baseUrl: 'http://timeline.test', fetch: () => new Promise<Response>(() => undefined) });
  const store = () => {
    const result = getSyncChildStores().getChild(directory);
    if (!result) throw new Error('Expected mounted directory store');
    return result;
  };
  const stage = (turns: string[]) => act(async () => {
    store().setState({
      session: [session],
      message: { [sessionId]: turns.map((_, index) => user(`u${index}`, 1_700_000_000_000 + index)) },
      part: Object.fromEntries(turns.map((value, index) => [`u${index}`, [countedText(`p${index}`, `u${index}`, value)]])),
    });
  });
  const render = (open: boolean) => act(async () => root.render(
    <SyncProvider sdk={sdk} directory={directory}>
      <I18nProvider>
        <ChatColumnSessionContext.Provider value={column}>
          <TimelineDialog open={open} onOpenChange={() => undefined} />
        </ChatColumnSessionContext.Provider>
      </I18nProvider>
    </SyncProvider>,
  ));

  beforeEach(() => {
    textReads = 0;
    dom = installDom();
    root = createRoot(dom.container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    dom.restore();
  });

  test('a closed timeline reads no messages while the session updates', async () => {
    await render(false);
    await stage(['First prompt']);
    await stage(['First prompt', 'Second prompt']);
    await stage(['First prompt', 'Second prompt', 'Third prompt']);

    expect(textReads).toBe(0);
    expect(document.body.textContent).not.toContain('First prompt');
  });

  test('opening the timeline lists the session prompts', async () => {
    await render(false);
    await stage(['First prompt', 'Second prompt']);
    await render(true);

    expect(textReads).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('First prompt');
    expect(document.body.textContent).toContain('Second prompt');
  });
});
