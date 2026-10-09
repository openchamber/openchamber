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
  PointerEvent: browser.PointerEvent,
  Event: browser.Event,
  CustomEvent: browser.CustomEvent,
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
let summaryFailed = false;
let summaryNoteIds: string[] = [];
let noteConflict = false;
let writeNote: (() => Promise<Response>) | null = null;
let removeNote: (() => Promise<Response>) | null = null;
let writeTodo: (() => Promise<Response>) | null = null;
const noteWrites: string[] = [];
const todoWrites: Array<{ method: string; body: string }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), 'http://runtime.test');
  if (url.pathname === '/api/session-knowledge/summary') {
    return summaryFailed ? Response.json({ error: 'offline' }, { status: 503 }) : Response.json({
      notes: summaryNoteIds.map(id => ({ id, body: 'Attached note' })), plans: [], memory: { global: 0, project: 0 },
    });
  }
  if (url.pathname.startsWith('/api/project-context/')) {
    if (url.pathname.includes('/notes/') && init?.method === 'DELETE' && removeNote) return removeNote();
    if (url.pathname.includes('/todos') && init?.method) {
      todoWrites.push({ method: init.method, body: String(init.body ?? '') });
      if (writeTodo) return writeTodo();
      if (init.method === 'PATCH') {
        serverContext = { ...serverContext, todos: serverContext.todos.map(todo => todo.id === 'peer-todo' ? { ...todo, completed: true } : todo) };
      }
      if (init.method === 'PUT') return Response.json({ error: 'Todos changed' }, { status: 409 });
      return Response.json(serverContext);
    }
    if (init?.method === 'PATCH') {
      noteWrites.push(String(init.body));
      if (writeNote) return writeNote();
      if (noteConflict) return Response.json({ error: 'Note changed' }, { status: 409 });
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
  summaryFailed = false;
  summaryNoteIds = [];
  noteConflict = false;
  writeNote = null;
  removeNote = null;
  writeTodo = null;
  noteWrites.length = 0;
  todoWrites.length = 0;
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
  expect(noteWrites).toEqual([JSON.stringify({ body: 'Local autosave draft', expectedBody: 'Peer note' })]);
});

test('a note conflict retains the dirty editor and the committed peer body', async () => {
  serverContext = { ...serverContext, notes: [peerNote] };
  await mount();
  const card = host.querySelector<HTMLElement>('li[role="button"]');
  if (!card) throw new Error('Note card missing');
  await act(async () => card.click());
  const editor = Array.from(browser.document.querySelectorAll('textarea')).find(element => element.closest('li'));
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, 'value')?.set;
  if (!editor || !setter) throw new Error('Note editor missing');
  await act(async () => {
    setter.call(editor, 'Dirty local draft');
    editor.dispatchEvent(new browser.Event('input', { bubbles: true }));
    editor.dispatchEvent(new browser.Event('change', { bubbles: true }));
  });
  serverContext = { ...serverContext, notes: [{ ...peerNote, body: 'Peer replacement', updatedAt: 2 }] };
  noteConflict = true;
  await announce();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
  expect(noteWrites).toEqual([JSON.stringify({ body: 'Dirty local draft', expectedBody: 'Peer note' })]);
  expect(editor.value).toBe('Dirty local draft');
  expect(useProjectContextStore.getState().getEntry(project).notes[0].body).toBe('Peer replacement');
  expect(useProjectContextStore.getState().getEntry(project).error).toBe('Note changed');
  await announce();
  expect(editor.value).toBe('Dirty local draft');
});

test('overlapping note edits advance expectedBody only after the earlier save succeeds', async () => {
  serverContext = { ...serverContext, notes: [peerNote] };
  await mount();
  const card = host.querySelector<HTMLElement>('li[role="button"]');
  if (!card) throw new Error('Note card missing');
  await act(async () => card.click());
  const editor = Array.from(browser.document.querySelectorAll('textarea')).find(element => element.closest('li'));
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, 'value')?.set;
  if (!editor || !setter) throw new Error('Note editor missing');
  const responses: Array<(response: Response) => void> = [];
  writeNote = () => new Promise(resolve => { responses.push(resolve); });
  for (const text of ['First edit', 'Later edit']) {
    await act(async () => {
      setter.call(editor, text);
      editor.dispatchEvent(new browser.Event('input', { bubbles: true }));
      editor.dispatchEvent(new browser.Event('change', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 450));
    });
  }
  expect(noteWrites).toEqual([JSON.stringify({ body: 'First edit', expectedBody: 'Peer note' })]);
  const saved = { ...peerNote, body: 'First edit', updatedAt: 2 };
  serverContext = { ...serverContext, notes: [saved] };
  await act(async () => responses[0](Response.json({ note: saved })));
  expect(noteWrites).toEqual([
    JSON.stringify({ body: 'First edit', expectedBody: 'Peer note' }),
    JSON.stringify({ body: 'Later edit', expectedBody: 'First edit' }),
  ]);
  expect(editor.value).toBe('Later edit');
  await act(async () => responses[1](Response.json({ error: 'Note changed' }, { status: 409 })));
  expect(editor.value).toBe('Later edit');
  expect(useProjectContextStore.getState().getEntry(project).notes[0].body).toBe('First edit');
});

for (const operation of ['pin', 'delete'] as const) {
  test(`a mounted note retains its saved body after queued ${operation} failure`, async () => {
    serverContext = { ...serverContext, notes: [peerNote] };
    await mount();
    const card = host.querySelector<HTMLElement>('li[role="button"]');
    if (!card) throw new Error('Note card missing');
    await act(async () => card.click());
    const editor = Array.from(browser.document.querySelectorAll('textarea')).find(element => element.closest('li'));
    const setter = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, 'value')?.set;
    if (!editor || !setter) throw new Error('Note editor missing');
    let releaseBody: (response: Response) => void = () => { throw new Error('No body request'); };
    let releaseMutation: (response: Response) => void = () => { throw new Error('No mutation request'); };
    let startedBody = () => {};
    const bodyStarted = new Promise<void>(resolve => { startedBody = resolve; });
    const saved = { ...peerNote, body: 'Saved body', updatedAt: 5 };
    writeNote = () => {
      if (noteWrites.length === 1) {
        serverContext = { ...serverContext, notes: [saved] };
        startedBody();
        return new Promise(resolve => { releaseBody = resolve; });
      }
      return new Promise(resolve => { releaseMutation = resolve; });
    };
    removeNote = () => new Promise(resolve => { releaseMutation = resolve; });
    await act(async () => {
      setter.call(editor, 'Saved body');
      editor.dispatchEvent(new browser.Event('input', { bubbles: true }));
      editor.dispatchEvent(new browser.Event('change', { bubbles: true }));
      // focusout exercises React's onBlur and starts the save without a timer wait.
      editor.dispatchEvent(new browser.Event('focusout', { bubbles: true }));
      await bodyStarted;
    });
    const store = useProjectContextStore.getState;
    expect(store().getEntry(project).notes[0].body).toBe('Peer note');
    expect(serverContext.notes[0].body).toBe('Saved body');
    let mutation: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      mutation = operation === 'pin'
        ? store().setNotePinned(project, peerNote.id, true)
        : store().deleteNote(project, peerNote.id);
    });
    if (operation === 'delete') expect(host.querySelector('li')).toBeNull();
    await act(async () => releaseBody(Response.json({ note: saved })));
    if (operation === 'delete') expect(host.querySelector('li')).toBeNull();
    await act(async () => {
      releaseMutation(Response.json({ error: 'Write rejected' }, { status: 503 }));
      expect(await mutation).toBe(false);
    });
    expect(store().getEntry(project).notes[0]).toEqual(saved);
    expect(serverContext.notes[0]).toEqual(saved);
    if (operation === 'delete' && !host.querySelector('li textarea')) {
      const restored = host.querySelector<HTMLElement>('li[role="button"]');
      if (!restored) throw new Error('Restored note missing');
      await act(async () => restored.click());
    }
    expect(host.querySelector<HTMLTextAreaElement>('li textarea')?.value).toBe('Saved body');
  });
}

test('todo completion and deletion appear before the deferred response and roll back on failure', async () => {
  serverContext = { ...serverContext, todos: [
    { id: 'peer-todo', text: 'First', completed: false, createdAt: 1 },
    { id: 'second', text: 'Second', completed: false, createdAt: 2 },
  ] };
  useUIStore.setState({ projectContextTab: 'todos' });
  await mount();
  let respond: (response: Response) => void = () => { throw new Error('No pending request'); };
  writeTodo = () => new Promise(resolve => { respond = resolve; });
  const checkbox = host.querySelector<HTMLElement>('[role="checkbox"]');
  if (!checkbox) throw new Error('Todo checkbox missing');
  await act(async () => checkbox.click());
  expect(Array.from(host.querySelectorAll('li')).map(row => row.textContent)).toEqual(['Second', 'First']);
  expect(host.querySelectorAll('[role="checkbox"]')[1].getAttribute('aria-checked')).toBe('true');
  await act(async () => respond(Response.json({ error: 'Write rejected' }, { status: 503 })));
  expect(Array.from(host.querySelectorAll('li')).map(row => row.textContent)).toEqual(['First', 'Second']);
  const remove = Array.from(host.querySelectorAll<HTMLButtonElement>('li button')).find(button => button.getAttribute('aria-label') === 'Delete "First"');
  if (!remove) throw new Error('Delete todo control missing');
  await act(async () => remove.click());
  expect(host.textContent).not.toContain('First');
  await act(async () => respond(Response.json({ error: 'Write rejected' }, { status: 503 })));
  expect(host.textContent).toContain('First');
});

test('todo creation clears the input and shows each pending row before acknowledgement', async () => {
  useUIStore.setState({ projectContextTab: 'todos' });
  await mount();
  const responses: Array<(response: Response) => void> = [];
  writeTodo = () => new Promise(resolve => { responses.push(resolve); });
  const editor = browser.document.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, 'value')?.set;
  if (!editor || !setter) throw new Error('Todo input missing');
  const add = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.getAttribute('aria-label') === 'Add todo');
  if (!add) throw new Error('Add todo control missing');
  for (const text of ['First draft', 'Second draft']) {
    await act(async () => {
      setter.call(editor, text);
      editor.dispatchEvent(new browser.Event('input', { bubbles: true }));
      editor.dispatchEvent(new browser.Event('change', { bubbles: true }));
    });
    await act(async () => add.click());
    expect(editor.value).toBe('');
    expect(host.textContent).toContain(text);
  }
  expect(responses).toHaveLength(1);
  const first = { id: 'first-server', text: 'First draft', completed: false, createdAt: 50 };
  serverContext = { ...serverContext, todos: [first] };
  await act(async () => responses[0](Response.json({ todo: first, context: serverContext })));
  expect(responses).toHaveLength(2);
  expect(Array.from(host.querySelectorAll('li')).map(row => row.textContent)).toEqual(['First draft', 'Second draft']);
  await act(async () => responses[1](Response.json({ error: 'Write rejected' }, { status: 503 })));
  expect(Array.from(host.querySelectorAll('li')).map(row => row.textContent)).toEqual(['First draft']);
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

test('ordinary todo completion preserves a peer item that the panel has not read', async () => {
  serverContext = { ...serverContext, todos: [{ id: 'peer-todo', text: 'Visible todo', completed: false, createdAt: 1 }] };
  useUIStore.setState({ projectContextTab: 'todos' });
  await mount();
  serverContext.todos.push({ id: 'unread', text: 'Unread peer item', completed: false, createdAt: 2 });
  const checkbox = host.querySelector<HTMLElement>('[role="checkbox"]');
  if (!checkbox) throw new Error('Todo checkbox missing');
  await act(async () => checkbox.click());
  await settle();
  expect(todoWrites).toEqual([{ method: 'PATCH', body: JSON.stringify({ completed: true }) }]);
  expect(host.textContent).toContain('Unread peer item');
  expect(useProjectContextStore.getState().getEntry(project).todos).toHaveLength(2);
});

test('bulk clear sends the last confirmed list and keeps it after a conflict', async () => {
  const confirmed = [{ id: 'peer-todo', text: 'Finished todo', completed: true, createdAt: 1 }];
  serverContext = { ...serverContext, todos: confirmed };
  useUIStore.setState({ projectContextTab: 'todos' });
  await mount();
  const clear = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Clear completed');
  if (!clear) throw new Error('Clear completed control missing');
  await act(async () => clear.click());
  await settle();
  expect(todoWrites).toEqual([{ method: 'PUT', body: JSON.stringify({ todos: [], expectedTodos: confirmed }) }]);
  expect(host.textContent).toContain('Finished todo');
  expect(useProjectContextStore.getState().getEntry(project).error).toBe('Todos changed');
});

test('peer edits and failed summary refreshes retain the current session attachment', async () => {
  serverContext = { ...serverContext, notes: [peerNote] };
  summaryNoteIds = [peerNote.id];
  useSessionUIStore.setState({ currentSessionId: 'attached-session', currentSessionDirectory: '/fixture/chats' });
  await mount();
  expect(host.querySelector('li button[aria-pressed]')?.getAttribute('aria-pressed')).toBe('true');
  summaryFailed = true;
  serverContext = { ...serverContext, notes: [{ ...peerNote, body: 'Peer updated attached note' }] };
  await announce();
  expect(host.textContent).toContain('Peer updated attached note');
  expect(host.querySelector('li button[aria-pressed]')?.getAttribute('aria-pressed')).toBe('true');

  await act(async () => useSessionUIStore.setState({ currentSessionId: 'other-session' }));
  expect(host.querySelector('li button[aria-pressed]')?.getAttribute('aria-pressed')).toBe('false');
});
