import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { createOpencodeClient, type Part, type Session } from '@opencode-ai/sdk/v2';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';

let WorkStatusPinnedSection: typeof import('./WorkStatusPinnedSection').WorkStatusPinnedSection;

const directory = '/repo';
const sessionId = 'session-1';
const otherSessionId = 'other-1';
const pinnedMessageId = 'pinned-message-1';
const otherMessageId = 'other-message-1';

const textPart = (id: string, text: string): Part => ({
  id,
  sessionID: sessionId,
  messageID: 'message',
  type: 'text',
  text,
});

const makeSession = (id: string, pinnedMessageIds: readonly string[]): Session => ({
  id,
  slug: id,
  projectID: 'project',
  directory,
  title: id,
  version: '1',
  time: { created: 0, updated: 0 },
  metadata: {
    openchamber: {
      context_obligatory_messages: pinnedMessageIds.map((messageId) => ({
        id: messageId,
        createdAt: 1,
        role: 'user',
      })),
    },
  },
});

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLIFrameElement', 'localStorage', 'getComputedStyle', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const installDom = () => {
  const win = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = {
    window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element,
    HTMLElement: win.HTMLElement, HTMLIFrameElement: win.HTMLIFrameElement, localStorage: win.localStorage,
    getComputedStyle: win.getComputedStyle.bind(win), ResizeObserver: win.ResizeObserver,
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of DOM_GLOBAL_NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container,
    restore: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      void win.happyDOM.close();
    },
  };
};

describe('mounted pinned section with live sync stores', () => {
  let root: Root;
  let dom: ReturnType<typeof installDom>;
  let commits = 0;
  // Keep bootstrap pending so each test controls real store publications.
  const sdk = createOpencodeClient({ baseUrl: 'http://pinned.test', fetch: () => new Promise<Response>(() => undefined) });

  const store = (dir = directory) => {
    const result = getSyncChildStores().getChild(dir);
    if (!result) throw new Error('Expected mounted directory store');
    return result;
  };

  const render = async () => {
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory={directory}>
        <I18nProvider>
          <React.Profiler id="pinned" onRender={() => { commits += 1; }}>
            <WorkStatusPinnedSection sessionId={sessionId} directory={directory} />
          </React.Profiler>
        </I18nProvider>
      </SyncProvider>,
    ));
  };

  beforeEach(async () => {
    dom = installDom();
    ({ WorkStatusPinnedSection } = await import('./WorkStatusPinnedSection'));
    root = createRoot(dom.container);
    commits = 0;
    await render();
    await act(async () => store().setState({
      session: [makeSession(sessionId, [pinnedMessageId]), makeSession(otherSessionId, [])],
      part: { [pinnedMessageId]: [textPart('part-1', 'pinned text')] },
    }));
    commits = 0;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    dom.restore();
  });

  test('renders the pinned message text', () => {
    expect(dom.container.textContent).toContain('pinned text');
  });

  // The section subscribes to the pinned messages' part arrays only, so a part
  // publication for any other message clones `state.part` without changing the
  // pinned arrays; the scoped snapshot keeps its reference and React bails out.
  test('an unrelated message part update does not re-render the section', async () => {
    commits = 0;
    await act(async () => store().setState({
      part: { ...store().getState().part, [otherMessageId]: [textPart('part-other', 'other text')] },
    }));
    expect(commits).toBe(0);
  });

  test('a pinned message part text change re-renders with the new text', async () => {
    commits = 0;
    await act(async () => store().setState({
      part: { ...store().getState().part, [pinnedMessageId]: [textPart('part-1', 'updated text')] },
    }));
    expect(commits).toBeGreaterThan(0);
    expect(dom.container.textContent).toContain('updated text');
    expect(dom.container.textContent).not.toContain('pinned text');
  });
});
