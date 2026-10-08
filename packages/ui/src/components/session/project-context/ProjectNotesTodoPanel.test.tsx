import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import type { fetchProjectContext, ProjectNote } from '@/lib/projectContextApi';

class TestEventSource {
  static CLOSED = 2;
  static instances: TestEventSource[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { TestEventSource.instances.push(this); }
  close() { this.readyState = TestEventSource.CLOSED; }
}

const browser = new Window({ url: 'http://runtime.test' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  HTMLElement: browser.HTMLElement,
  Element: browser.Element,
  Node: browser.Node,
  HTMLInputElement: browser.HTMLInputElement,
  HTMLTextAreaElement: browser.HTMLTextAreaElement,
  ResizeObserver: browser.ResizeObserver,
  MutationObserver: browser.MutationObserver,
  EventSource: TestEventSource,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

type Context = Awaited<ReturnType<typeof fetchProjectContext>>;
const emptyContext = (): Context => ({ notes: [], todos: [], plans: [], sharedPlansDir: null });
const peerNote: ProjectNote = {
  id: 'peer-note', body: 'Peer note', source: 'manual', pinned: false, createdAt: 1, updatedAt: 1,
};
let serverContext = emptyContext();
let readFailed = false;
let readContext = async (): Promise<Response> => Response.json(serverContext);
let reads = 0;
const noteWrites: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), 'http://runtime.test');
  if (url.pathname.startsWith('/api/project-context/')) {
    if (init?.method === 'PATCH') {
      noteWrites.push(String(init.body));
      const saved = { ...peerNote, body: 'Local autosave draft', updatedAt: 2 };
      serverContext = { ...serverContext, notes: [saved] };
      return Response.json({ note: saved });
    }
    reads += 1;
    if (readFailed) return Response.json({ error: 'offline' }, { status: 503 });
    return readContext();
  }
  return Response.json({ error: 'Unavailable in this fixture' }, { status: 503 });
}, originalFetch);

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { resolveProjectContextId } = await import('@/lib/projectContextApi');
const { subscribeOpenchamberEvents } = await import('@/lib/openchamberEvents');
const { useProjectContextStore } = await import('@/stores/useProjectContextStore');
const { useUIStore } = await import('@/stores/useUIStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { ProjectNotesTodoPanel } = await import('./ProjectNotesTodoPanel');

const project = { id: 'chats', path: '/fixture/chats' };
const host = document.createElement('div');
document.body.append(host);
let root: ReturnType<typeof createRoot> | null = null;
let releaseStream = () => {};

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const announce = async (projectId = resolveProjectContextId(project)) => {
  await act(async () => {
    TestEventSource.instances[0].onmessage?.({
      data: JSON.stringify({ type: 'openchamber:project-context-changed', properties: { projectId } }),
    });
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};
const render = async (visible = true) => {
  await act(async () => root?.render(<I18nProvider><ProjectNotesTodoPanel projectRef={project} visible={visible} /></I18nProvider>));
  await settle();
};
const mount = async () => {
  root = createRoot(host);
  await render();
};

beforeEach(() => {
  TestEventSource.instances = [];
  serverContext = emptyContext();
  readFailed = false;
  readContext = async () => Response.json(serverContext);
  reads = 0;
  noteWrites.length = 0;
  Object.defineProperty(browser.document, 'visibilityState', { value: 'visible', configurable: true });
  Object.defineProperty(browser.navigator, 'onLine', { value: true, configurable: true });
  useProjectContextStore.getState().reset();
  useUIStore.setState({ projectContextTab: 'notes', isMobile: false });
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null });
  // App already owns this shared connection before its knowledge panel opens.
  releaseStream = subscribeOpenchamberEvents(() => {});
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  releaseStream();
  useProjectContextStore.getState().reset();
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await browser.happyDOM.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('adopts peer note creation, edits, and todo completion without remounting', async () => {
  await mount();
  expect(host.querySelectorAll('li')).toHaveLength(0);

  serverContext = { ...serverContext, notes: [peerNote] };
  await announce();
  expect(host.textContent).toContain('Peer note');

  serverContext = { ...serverContext, notes: [{ ...peerNote, body: 'Peer edited note', updatedAt: 2 }] };
  await announce();
  expect(host.textContent).toContain('Peer edited note');
  expect(host.querySelectorAll('li')).toHaveLength(1);

  serverContext = { ...serverContext, todos: [{ id: 'peer-todo', text: 'Peer todo', completed: false, createdAt: 1 }] };
  await announce();
  const todoTab = Array.from(host.querySelectorAll<HTMLButtonElement>('nav button'))
    .find(button => button.textContent?.startsWith('Todo'));
  if (!todoTab) throw new Error('Todo tab missing');
  await act(async () => todoTab.click());
  expect(host.textContent).toContain('Peer todo');
  expect(host.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('false');

  serverContext = { ...serverContext, todos: [{ ...serverContext.todos[0], completed: true }] };
  await announce();
  expect(host.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true');
  expect(TestEventSource.instances).toHaveLength(1);
});

test('refreshing an edited note preserves its unsaved draft and ignores another owner', async () => {
  serverContext = { ...serverContext, notes: [peerNote] };
  await mount();
  const card = host.querySelector<HTMLElement>('li[role="button"]');
  if (!card) throw new Error('Note card missing');
  await act(async () => card.click());
  const editor = Array.from(browser.document.querySelectorAll('textarea')).find(element => element.closest('li'));
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, 'value')?.set;
  if (!editor || !setter) throw new Error('Note editor missing');
  await act(async () => {
    setter.call(editor, 'Unsaved local draft');
    editor.dispatchEvent(new browser.Event('input', { bubbles: true }));
    editor.dispatchEvent(new browser.Event('change', { bubbles: true }));
  });

  const initialReads = reads;
  serverContext = { ...serverContext, notes: [{ ...peerNote, body: 'Peer replacement', updatedAt: 2 }] };
  await announce(resolveProjectContextId({ id: 'other', path: '/fixture/other' }));
  expect(reads).toBe(initialReads);
  await announce();
  expect(useProjectContextStore.getState().getEntry(project).notes[0].body).toBe('Peer replacement');
  expect(editor.value).toBe('Unsaved local draft');
});

test('peer refreshes do not postpone the local note autosave', async () => {
  serverContext = { ...serverContext, notes: [peerNote] };
  await mount();
  const card = host.querySelector<HTMLElement>('li[role="button"]');
  if (!card) throw new Error('Note card missing');
  await act(async () => card.click());
  const editor = Array.from(browser.document.querySelectorAll('textarea')).find(element => element.closest('li'));
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, 'value')?.set;
  if (!editor || !setter) throw new Error('Note editor missing');
  await act(async () => {
    setter.call(editor, 'Local autosave draft');
    editor.dispatchEvent(new browser.Event('input', { bubbles: true }));
    editor.dispatchEvent(new browser.Event('change', { bubbles: true }));
  });
  for (let index = 0; index < 8; index += 1) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });
    serverContext = { ...serverContext, todos: [{ id: 'peer-todo', text: `Peer edit ${index}`, completed: false, createdAt: 1 }] };
    await announce();
  }
  expect(noteWrites).toEqual([JSON.stringify({ body: 'Local autosave draft' })]);
});

test('hidden panels stop refreshing and re-read when they become visible again', async () => {
  await mount();
  const initialReads = reads;
  await render(false);
  serverContext = { ...serverContext, notes: [peerNote] };
  await announce();
  await act(async () => browser.dispatchEvent(new browser.Event('focus')));
  expect(reads).toBe(initialReads);

  await render();
  expect(reads).toBe(initialReads + 1);
  expect(host.textContent).toContain('Peer note');
});

test('hidden and offline documents catch up on return without background reads', async () => {
  await mount();
  const initialReads = reads;
  Object.defineProperty(browser.document, 'visibilityState', { value: 'hidden', configurable: true });
  serverContext = { ...serverContext, notes: [peerNote] };
  await announce();
  expect(reads).toBe(initialReads);

  Object.defineProperty(browser.document, 'visibilityState', { value: 'visible', configurable: true });
  Object.defineProperty(browser.navigator, 'onLine', { value: false, configurable: true });
  await act(async () => browser.document.dispatchEvent(new browser.Event('visibilitychange')));
  expect(reads).toBe(initialReads);

  Object.defineProperty(browser.navigator, 'onLine', { value: true, configurable: true });
  await act(async () => {
    browser.dispatchEvent(new browser.Event('online'));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(reads).toBe(initialReads + 1);
  expect(host.textContent).toContain('Peer note');
});

test('failed refreshes keep the last good snapshot and a reconnect recovers missed changes', async () => {
  serverContext = { ...serverContext, notes: [peerNote] };
  await mount();
  readFailed = true;
  await announce();
  expect(host.textContent).toContain('Peer note');
  expect(useProjectContextStore.getState().getEntry(project).error).toBe('offline');

  readFailed = false;
  serverContext = { ...serverContext, notes: [{ ...peerNote, body: 'Changed while disconnected' }] };
  await act(async () => {
    TestEventSource.instances[0].onmessage?.({ data: JSON.stringify({ type: 'openchamber:event-stream-ready', properties: {} }) });
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(host.textContent).toContain('Changed while disconnected');
  expect(useProjectContextStore.getState().getEntry(project).error).toBeNull();
  expect(TestEventSource.instances).toHaveLength(1);
});

test('bursts share one read and changes during that read earn only one trailing refresh', async () => {
  await mount();
  const initialReads = reads;
  let releaseRead: (response: Response) => void = () => { throw new Error('No pending read'); };
  const pending = new Promise<Response>(resolve => { releaseRead = resolve; });
  readContext = () => pending;
  const event = { data: JSON.stringify({ type: 'openchamber:project-context-changed', properties: { projectId: resolveProjectContextId(project) } }) };
  await act(async () => {
    for (let index = 0; index < 20; index += 1) TestEventSource.instances[0].onmessage?.(event);
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(reads).toBe(initialReads + 1);

  serverContext = { ...serverContext, notes: [peerNote] };
  readContext = async () => Response.json(serverContext);
  await act(async () => {
    for (let index = 0; index < 20; index += 1) TestEventSource.instances[0].onmessage?.(event);
    releaseRead(Response.json(emptyContext()));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(reads).toBe(initialReads + 2);
  expect(host.textContent).toContain('Peer note');
});
