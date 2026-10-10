import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { AssistantMessage, Part, Session, UserMessage } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { RevertedMessagesStrip } from './RevertedMessagesStrip';

const directory = '/repo';
const sessionId = 'session-1';
const session: Session = {
  id: sessionId, projectID: 'project', directory, title: 'test', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 1 },
};
const user = (id: string, created: number): UserMessage => ({ id, sessionID: sessionId, role: 'user', time: { created } });
const assistant = (id: string, created: number): AssistantMessage => ({
  id, sessionID: sessionId, role: 'assistant', agent: 'build', providerID: 'test', modelID: 'test',
  time: { created, completed: created + 1 }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});
const text = (id: string, messageID: string, value: string): Part => ({ id, sessionID: sessionId, messageID, type: 'text', text: value });

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

describe('RevertedMessagesStrip', () => {
  let root: Root;
  let dom: ReturnType<typeof installDom>;
  // Bootstrap stays pending, so each test owns the directory store's contents.
  const sdk = OpenCode.make({ baseUrl: 'http://revert.test', fetch: () => new Promise<Response>(() => undefined) });
  const store = () => {
    const result = getSyncChildStores().getChild(directory);
    if (!result) throw new Error('Expected mounted directory store');
    return result;
  };
  const stage = (reverted: string[]) => act(async () => {
    const messages = [user('u0', 1), assistant('a0', 2), ...reverted.flatMap((value, index) => [user(`u${index + 1}`, 10 + index * 2), assistant(`a${index + 1}`, 11 + index * 2)])];
    store().setState({
      session: [{ ...session, revert: reverted.length ? { messageID: 'u1' } : undefined }],
      message: { [sessionId]: messages },
      part: Object.fromEntries(reverted.map((value, index) => [`u${index + 1}`, [text(`p${index + 1}`, `u${index + 1}`, value)]])),
    });
  });
  const buttons = () => [...dom.container.querySelectorAll('button')];
  const button = (label: string) => buttons().find((item) => item.textContent === label);

  beforeEach(async () => {
    dom = installDom();
    root = createRoot(dom.container);
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory={directory}>
        <I18nProvider><RevertedMessagesStrip sessionId={sessionId} directory={directory} /></I18nProvider>
      </SyncProvider>,
    ));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    dom.restore();
  });

  test('renders nothing without a staged revert', async () => {
    await stage([]);
    expect(dom.container.textContent).toBe('');
  });

  test('one reverted message is its own row with Restore and nothing else', async () => {
    await stage(['Try the other approach']);
    expect(dom.container.textContent).toContain('Try the other approach');
    expect(dom.container.querySelector('[aria-expanded]')).toBeNull();
    expect(buttons().map((item) => item.textContent)).toEqual(['Restore']);
  });

  test('several collapse into a count whose list carries no actions', async () => {
    await stage(['First', 'Second']);
    expect(dom.container.textContent).toContain('Reverted: 2');
    expect(dom.container.textContent).not.toContain('First');
    expect(button('Restore all')).toBeDefined();

    const header = dom.container.querySelector<HTMLButtonElement>('[aria-expanded]');
    await act(async () => header?.click());
    expect(header?.getAttribute('aria-expanded')).toBe('true');
    expect(dom.container.textContent).toContain('First');
    expect(dom.container.textContent).toContain('Second');
    expect(buttons()).toHaveLength(2);
  });

  test('Restore clears the staged revert', async () => {
    const clear = spyOn(opencodeClient, 'clearRevert').mockResolvedValue(undefined);
    const getSession = spyOn(opencodeClient, 'getSession').mockResolvedValue(session);
    try {
      await stage(['Try the other approach']);
      await act(async () => button('Restore')?.click());
      expect(clear.mock.calls[0]?.[0]).toBe(sessionId);
    } finally {
      clear.mockRestore();
      getSession.mockRestore();
    }
  });
});
