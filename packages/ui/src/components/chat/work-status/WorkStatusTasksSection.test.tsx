import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { createOpencodeClient, type Todo } from '@opencode-ai/sdk/v2';
import { useUIStore } from '@/stores/useUIStore';
import { useTodosPersistStore } from '@/stores/useTodosPersistStore';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';

let WorkStatusTasksSection: typeof import('./WorkStatusTasksSection').WorkStatusTasksSection;
const directory = '/tasks-test';
const sessionId = 'tasks-session';
const task = (content: string, status: string): Todo => ({ content, status, priority: 'medium' });
const initialTodos = [task('Waiting', 'pending'), task('First active', 'in_progress'), task('Second active', 'in_progress'), task('Finished', 'completed')];

describe('collapsible work-status tasks', () => {
  let win: Window;
  let root: Root;
  let container: HTMLElement;
  let restoreGlobals: () => void;
  const sdk = createOpencodeClient({ baseUrl: 'http://tasks.test', fetch: () => new Promise<Response>(() => undefined) });
  const render = async (visible = true, selectedSession = sessionId, selectedDirectory = directory) => {
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory={directory}>
        <I18nProvider>{visible ? <WorkStatusTasksSection sessionId={selectedSession} directory={selectedDirectory} /> : null}</I18nProvider>
      </SyncProvider>,
    ));
  };
  const publish = async (todos: Todo[], selectedSession = sessionId, selectedDirectory = directory) => {
    const store = getSyncChildStores().getChild(selectedDirectory);
    if (!store) throw new Error('Expected directory store');
    await act(async () => store.setState((state) => ({ todo: { ...state.todo, [selectedSession]: todos } })));
  };
  const heading = () => {
    const button = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    if (!button) throw new Error('Expected Tasks heading');
    return button;
  };
  const toggle = async () => { await act(async () => heading().click()); };

  beforeEach(async () => {
    win = new Window({ url: 'http://localhost' });
    const values = {
      window: win, document: win.document, navigator: win.navigator,
      Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
      HTMLIFrameElement: win.HTMLIFrameElement, localStorage: win.localStorage,
      getComputedStyle: win.getComputedStyle.bind(win), ResizeObserver: win.ResizeObserver,
      requestAnimationFrame: win.requestAnimationFrame.bind(win),
      cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    restoreGlobals = () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    };
    ({ WorkStatusTasksSection } = await import('./WorkStatusTasksSection'));
    useUIStore.setState({ workStatusExpandedSections: {} });
    useTodosPersistStore.setState({ sessions: {} });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await render();
    await publish(initialTodos);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await win.happyDOM.close();
    restoreGlobals();
  });

  test('starts expanded, then keeps only the first active task and restores the collapsed state on remount', async () => {
    expect(heading().getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toBe('Tasks1/4First activeSecond activeWaitingFinished');
    await toggle();
    expect(container.textContent).toBe('Tasks1/4First active');
    expect(useUIStore.getState().workStatusExpandedSections.tasks).toBe(false);
    await render(false);
    await render();
    expect(heading().getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).toBe('Tasks1/4First active');
    await toggle();
    expect(container.textContent).toContain('Second activeWaitingFinished');
  });

  test('updates the preview while collapsed and removes it when no task is active', async () => {
    await toggle();
    await publish([task('First active', 'completed'), task('Second active', 'in_progress')]);
    expect(container.textContent).toBe('Tasks1/2Second active');
    expect(heading().getAttribute('aria-expanded')).toBe('false');
    await publish([task('First active', 'completed'), task('Second active', 'completed')]);
    expect(container.textContent).toBe('Tasks2/2');
    await publish([task('Waiting', 'pending')]);
    expect(container.textContent).toBe('Tasks0/1');
    await toggle();
    expect(container.textContent).toBe('Tasks0/1Waiting');
  });

  test('switches the collapsed preview to the selected session and directory', async () => {
    await toggle();
    await publish([task('Another session', 'in_progress')], 'other');
    await render(true, 'other');
    expect(container.textContent).toBe('Tasks0/1Another session');
    await render(true, sessionId, '/other-tasks');
    await publish([task('Another directory', 'in_progress')], sessionId, '/other-tasks');
    expect(container.textContent).toBe('Tasks0/1Another directory');
    expect(heading().getAttribute('aria-expanded')).toBe('false');
  });

  test('uses persisted tasks only until a live list, including empty, arrives', async () => {
    await act(async () => useTodosPersistStore.getState().setSessionTodos(directory, 'restored', [task('Old task', 'in_progress')]));
    await render(true, 'restored');
    expect(container.textContent).toContain('Old task');
    await publish([], 'restored');
    expect(container.textContent).toBe('');
    await publish([task('Cancelled task', 'cancelled')], 'restored');
    expect(container.textContent).toBe('');
  });
});
