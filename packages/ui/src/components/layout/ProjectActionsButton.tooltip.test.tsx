import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import { AUTO_DISCOVER_ACTION_ID } from '@/lib/projectActions';
import type { OpenChamberProjectAction } from '@/lib/openchamberConfig';
import type { ProjectActionsRunner } from './useProjectActionsRunner';

// Imported once a DOM exists: the tooltip's layout effects check for one when
// their module loads, and without it the popup never mounts.
let ProjectActionsButton: typeof import('./ProjectActionsButton').ProjectActionsButton;
let ProjectActionsRunnerContext: typeof import('./projectActionsRunnerContext').ProjectActionsRunnerContext;

const autoDiscover: OpenChamberProjectAction = { id: AUTO_DISCOVER_ACTION_ID, name: 'Auto-discover dev server', command: '', icon: 'scan-2' };
const build: OpenChamberProjectAction = { id: 'build', name: 'Build every package in the workspace', command: 'bun run build' };

const runner = (shown: OpenChamberProjectAction): ProjectActionsRunner => ({
  available: true,
  actions: [build, autoDiscover],
  shown,
  isLoading: false,
  observe: () => () => undefined,
  runOf: () => null,
  select: () => undefined,
  run: () => undefined,
  stop: () => undefined,
  toggle: () => undefined,
  openSettings: () => undefined,
});

const tooltip = () => document.querySelector('[data-slot="tooltip-content"]');
const tooltipText = () => tooltip()?.textContent ?? null;
const rowButton = (action: OpenChamberProjectAction) => document.querySelector(`button[aria-label="Run ${action.name}"]`);
const label = (action: OpenChamberProjectAction) => [...document.querySelectorAll('span')]
  .find((span) => span.textContent === action.name);

/** Makes the browser report `element` narrower than its text, as `truncate` cuts it. */
const cutOff = (element: Element | undefined) => {
  if (!element) throw new Error('Nothing to cut off');
  Object.defineProperty(element, 'scrollWidth', { configurable: true, get: () => 240 });
  Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => 80 });
};
const focus = async (element: Element | null) => {
  if (!(element instanceof HTMLElement)) throw new Error('Nothing to focus');
  await act(async () => element.focus());
};
const blur = async () => {
  const active = document.activeElement;
  if (active instanceof HTMLElement) await act(async () => active.blur());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
};

/*
 * The panel's width cuts this row's name off at larger interface sizes, as it
 * does every row's. Auto-discovery's tooltip held only its description, so
 * its cut name could never be read, and other actions had no tooltip at all.
 */
describe('project action row tooltip', () => {
  let win: Window;
  let root: Root;
  let restoreGlobals: () => void;

  const render = async (value: ProjectActionsRunner) => {
    await act(async () => root.render(
      <I18nProvider>
        <ProjectActionsRunnerContext.Provider value={value}>
          <ProjectActionsButton />
        </ProjectActionsRunnerContext.Provider>
      </I18nProvider>,
    ));
  };

  beforeEach(async () => {
    win = new Window({ url: 'http://localhost' });
    const values = {
      window: win, document: win.document, navigator: win.navigator,
      Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
      HTMLButtonElement: win.HTMLButtonElement, HTMLIFrameElement: win.HTMLIFrameElement,
      SVGElement: win.SVGElement, Document: win.Document, DocumentFragment: win.DocumentFragment,
      DOMRect: win.DOMRect, Event: win.Event, CustomEvent: win.CustomEvent,
      MouseEvent: win.MouseEvent, KeyboardEvent: win.KeyboardEvent, FocusEvent: win.FocusEvent,
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
    ({ ProjectActionsButton } = await import('./ProjectActionsButton'));
    ({ ProjectActionsRunnerContext } = await import('./projectActionsRunnerContext'));
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await win.happyDOM.close();
    restoreGlobals();
  });

  test('auto-discovery names itself first and its description after, whether or not its name fits', async () => {
    await render(runner(autoDiscover));
    const lines = () => [...tooltip()?.querySelectorAll('p') ?? []].map((line) => line.textContent);
    const expected = [autoDiscover.name, 'Automatically discover and run the development server'];

    await focus(rowButton(autoDiscover));
    expect(lines()).toEqual(expected);
    await blur();

    cutOff(label(autoDiscover));
    await focus(rowButton(autoDiscover));
    expect(lines()).toEqual(expected);
  });

  test('a project action whose name the panel cuts off shows it in full, and one that fits shows nothing', async () => {
    await render(runner(build));

    await focus(rowButton(build));
    expect(tooltipText()).toBeNull();
    await blur();

    cutOff(label(build));
    await focus(rowButton(build));
    expect(tooltipText()).toBe(build.name);
  });
});
