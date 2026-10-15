import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { Session } from '@/lib/opencode/model';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { ChatColumnSessionContext } from '../chatColumnSession';
import { dispatchFrameSelection } from './frameSelection';

// React DOM probes for a DOM when first imported; give it one, then restore
// the caller's globals.
const importWindow = new Window();
const importGlobals = ['window', 'document'] as const;
const previousImportGlobals = importGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, 'window', { value: importWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: importWindow.document, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { TextSelectionMenu } = await import('./TextSelectionMenu');
for (const [name, descriptor] of previousImportGlobals) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
void importWindow.happyDOM.close();

const directory = '/repo';
const sessionId = 'session-1';
const column = { sessionId, directory };
const session = (updated: number, sessionDirectory = directory): Session => ({
  id: sessionId, projectID: 'project', directory: sessionDirectory, title: 'test', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated },
});
const otherSession = (updated: number): Session => ({ ...session(updated), id: 'session-2' });

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'CustomEvent', 'DOMRect', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const installDom = () => {
  const win = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = { window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element,
    HTMLElement: win.HTMLElement, CustomEvent: win.CustomEvent, DOMRect: win.DOMRect, localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win),
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

describe('TextSelectionMenu render subscriptions', () => {
  let root: Root;
  let dom: ReturnType<typeof installDom>;
  let renders = 0;
  // Bootstrap stays pending, so each test owns the directory store's contents.
  const sdk = OpenCode.make({ baseUrl: 'http://selection.test', fetch: () => new Promise<Response>(() => undefined) });
  const containerRef: React.RefObject<HTMLElement | null> = { current: null };
  const store = () => {
    const result = getSyncChildStores().getChild(directory);
    if (!result) throw new Error('Expected mounted directory store');
    return result;
  };
  const stage = (sessions: Session[]) => act(async () => {
    store().setState({ session: sessions });
  });
  const render = () => act(async () => root.render(
    <SyncProvider sdk={sdk} directory={directory}>
      <I18nProvider>
        <ChatColumnSessionContext.Provider value={column}>
          <React.Profiler id="menu" onRender={() => { renders += 1; }}>
            <TextSelectionMenu containerRef={containerRef} readingKey="message-1" canReadAloud={false} />
          </React.Profiler>
        </ChatColumnSessionContext.Provider>
      </I18nProvider>
    </SyncProvider>,
  ));

  beforeEach(() => {
    renders = 0;
    dom = installDom();
    root = createRoot(dom.container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    dom.restore();
  });

  test('a streamed step that replaces the session list does not re-render the menu', async () => {
    await render();
    await stage([session(1), otherSession(1)]);
    const settled = renders;

    // Every streamed step bumps `time.updated` and replaces the list with one
    // of the same length.
    await stage([session(2), otherSession(1)]);
    await stage([session(3), otherSession(2)]);
    await stage([session(4), otherSession(3)]);

    expect(renders).toBe(settled);
  });

  test('a change of the session directory still re-renders the menu', async () => {
    await render();
    await stage([session(1)]);
    const settled = renders;

    await stage([session(2, '/repo/worktree')]);

    expect(renders).toBeGreaterThan(settled);
  });

  test('a selection a page frame reports opens the menu, and clearing it closes the menu', async () => {
    const host = document.createElement('div');
    const frame = document.createElement('iframe');
    host.appendChild(frame);
    document.body.appendChild(host);
    containerRef.current = host;
    await render();
    const report = (text: string) => act(async () => {
      dispatchFrameSelection(frame, { text, rect: { top: 10, left: 20, width: 80, height: 16 } });
    });

    await report('picked words');
    expect(document.body.textContent).toContain('Comment');

    await report('');
    expect(document.body.textContent).not.toContain('Comment');
    containerRef.current = null;
  });

  test('a frame outside the menu\'s message does not open it', async () => {
    const host = document.createElement('div');
    const otherFrame = document.createElement('iframe');
    document.body.append(host, otherFrame);
    containerRef.current = host;
    await render();

    await act(async () => {
      dispatchFrameSelection(otherFrame, { text: 'elsewhere', rect: { top: 0, left: 0, width: 10, height: 10 } });
    });

    expect(document.body.textContent).not.toContain('Comment');
    containerRef.current = null;
  });
});
