import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useUIStore } from '@/stores/useUIStore';
import { I18nProvider } from '@/lib/i18n';
import type { OpenChamberProjectAction } from '@/lib/openchamberConfig';
import type { ProjectActionRun, ProjectActionsRunner } from './useProjectActionsRunner';

let ProjectActionsDialog: typeof import('./ProjectActionsDialog').ProjectActionsDialog;
let ProjectActionsRunnerContext: typeof import('./projectActionsRunnerContext').ProjectActionsRunnerContext;

const dev: OpenChamberProjectAction = { id: 'dev', name: 'Dev', command: 'bun run dev' };
const build: OpenChamberProjectAction = { id: 'build', name: 'Build', command: 'bun run build' };

describe('project actions dialog', () => {
  let win: Window;
  let root: Root;
  let restoreGlobals: () => void;
  let calls: string[];
  let runs: Map<string, ProjectActionRun>;

  const runner = (shown: OpenChamberProjectAction | null): ProjectActionsRunner => ({
    available: true,
    actions: [dev, build],
    shown,
    isLoading: false,
    observe: () => () => undefined,
    runOf: (action) => runs.get(action.id) ?? null,
    select: (action) => { calls.push(`select:${action.id}`); },
    run: (action) => { calls.push(`run:${action.id}`); },
    stop: (action) => { calls.push(`stop:${action.id}`); },
    toggle: (action) => { calls.push(`toggle:${action.id}`); },
    openSettings: () => { calls.push('settings'); },
  });

  const render = async (value: ProjectActionsRunner) => {
    await act(async () => root.render(
      <I18nProvider>
        <ProjectActionsRunnerContext.Provider value={value}>
          <ProjectActionsDialog />
        </ProjectActionsRunnerContext.Provider>
      </I18nProvider>,
    ));
  };
  const items = () => [...document.querySelectorAll<HTMLElement>('[cmdk-item]')];
  const highlighted = () => document.querySelector<HTMLElement>('[cmdk-item][data-selected="true"]');

  beforeEach(async () => {
    win = new Window({ url: 'http://localhost' });
    const values = {
      window: win, document: win.document, navigator: win.navigator,
      Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
      HTMLButtonElement: win.HTMLButtonElement, HTMLInputElement: win.HTMLInputElement,
      SVGElement: win.SVGElement, Document: win.Document, DocumentFragment: win.DocumentFragment,
      DOMRect: win.DOMRect, Event: win.Event, CustomEvent: win.CustomEvent,
      MouseEvent: win.MouseEvent, KeyboardEvent: win.KeyboardEvent,
      MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
      localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win),
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
    ({ ProjectActionsDialog } = await import('./ProjectActionsDialog'));
    ({ ProjectActionsRunnerContext } = await import('./projectActionsRunnerContext'));
    calls = [];
    runs = new Map();
    useUIStore.setState({ isProjectActionsDialogOpen: true });
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useUIStore.setState({ isProjectActionsDialogOpen: false });
    await win.happyDOM.close();
    restoreGlobals();
  });

  test('opens on the shown action, and choosing one picks it, toggles it and closes', async () => {
    await render(runner(build));
    expect(items().map((item) => item.getAttribute('aria-label'))).toEqual(['Run Dev', 'Run Build', null]);
    expect(highlighted()?.getAttribute('aria-label')).toBe('Run Build');

    await act(async () => items()[0]?.click());
    expect(calls).toEqual(['select:dev', 'toggle:dev']);
    expect(useUIStore.getState().isProjectActionsDialogOpen).toBe(false);
  });

  test('a running action offers stop, and one already stopping cannot be chosen', async () => {
    runs = new Map([
      ['dev', { directory: '/repo', actionId: 'dev', tabId: 't1', sessionId: 's1', executionId: 'e1', status: 'running' }],
      ['build', { directory: '/repo', actionId: 'build', tabId: 't2', sessionId: 's2', executionId: 'e2', status: 'stopping' }],
    ]);
    await render(runner(dev));
    expect(items()[0]?.getAttribute('aria-label')).toBe('Stop Dev');
    expect(items()[1]?.getAttribute('data-disabled')).toBe('true');
  });

  test('the last item opens the project action settings', async () => {
    await render(runner(dev));
    await act(async () => items().at(-1)?.click());
    expect(calls).toEqual(['settings']);
    expect(useUIStore.getState().isProjectActionsDialogOpen).toBe(false);
  });

  test('without a project it says what to do and lists nothing', async () => {
    await render({ ...runner(null), available: false, actions: [] });
    expect(items()).toEqual([]);
    expect(document.body.textContent).toContain('Open a session in a project to run its actions.');
  });
});
