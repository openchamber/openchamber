import React, { act } from 'react';
import { beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { GitWorkspacePanes } from './GitWorkspacePanes';
import { clampGitGraphPaneHeight } from './gitWorkspacePanesModel';

const directory = '/repo';
const otherDirectory = '/repo-b';

const DOM_GLOBAL_NAMES = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLButtonElement',
  'PointerEvent',
  'KeyboardEvent',
  'Event',
  'MouseEvent',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

const installDomStub = () => {
  const windowInstance = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = {
    window: windowInstance,
    document: windowInstance.document,
    navigator: windowInstance.navigator,
    Node: windowInstance.Node,
    Element: windowInstance.Element,
    HTMLElement: windowInstance.HTMLElement,
    HTMLButtonElement: windowInstance.HTMLButtonElement,
    PointerEvent: windowInstance.PointerEvent,
    KeyboardEvent: windowInstance.KeyboardEvent,
    Event: windowInstance.Event,
    MouseEvent: windowInstance.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  };

  for (const name of DOM_GLOBAL_NAMES) {
    Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  }

  const container = document.createElement('div');
  document.body.appendChild(container);

  return {
    container,
    restore: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

const flushEffects = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const renderPanesIntoRoot = async (root: Root, targetDirectory = directory) => {
  await act(async () => {
    root.render(
      React.createElement(
        I18nProvider,
        null,
        React.createElement(GitWorkspacePanes, {
          directory: targetDirectory,
          changes: React.createElement('div', null, 'changes'),
          commit: React.createElement('div', null, 'commit'),
          graph: React.createElement('div', { 'data-graph-body': 'true' }, 'graph'),
          graphHeaderControls: React.createElement('span', { 'data-graph-header-controls': 'true' }, 'controls'),
        }),
      ),
    );
    await flushEffects();
  });
};

const renderPanesMarkup = (targetDirectory = directory) => renderToStaticMarkup(
  React.createElement(
    I18nProvider,
    null,
    React.createElement(GitWorkspacePanes, {
      directory: targetDirectory,
      changes: React.createElement('div', null, 'changes'),
      commit: React.createElement('div', null, 'commit'),
      graph: React.createElement('div', null, 'graph'),
      graphHeaderControls: React.createElement('span', { 'data-graph-header-controls': 'true' }, 'controls'),
    }),
  ),
);

beforeEach(() => {
  useUIStore.setState({
    gitRepositoryPaneStates: {},
    gitGraphPaneCollapsed: true,
    gitGraphPaneHeight: 280,
  });
});

describe('GitWorkspacePanes helpers', () => {
  test('clamps graph pane height to supported bounds', () => {
    expect(clampGitGraphPaneHeight(10)).toBe(180);
    expect(clampGitGraphPaneHeight(280)).toBe(280);
    expect(clampGitGraphPaneHeight(999)).toBe(720);
    expect(clampGitGraphPaneHeight(Number.NaN)).toBe(280);
    expect(clampGitGraphPaneHeight(Number.POSITIVE_INFINITY)).toBe(280);
  });

  test('renders a horizontal resize handle with a three-dot grip', () => {
    const markup = renderPanesMarkup();

    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-orientation="horizontal"');
    expect(markup).toContain('cursor-row-resize');
    expect(markup.match(/data-git-resize-handle/g)?.length ?? 0).toBe(1);
    expect(markup.match(/data-git-resize-dot/g)?.length ?? 0).toBe(3);
  });

  test('renders expanded graph header controls outside the collapse button only while expanded', async () => {
    const dom = installDomStub();
    const root = createRoot(dom.container);

    try {
      await act(async () => {
        useUIStore.setState({ gitGraphPaneCollapsed: false });
        await flushEffects();
      });
      await renderPanesIntoRoot(root);
      const graphHeaderControls = dom.container.querySelector('[data-graph-header-controls="true"]');
      const graphButton = dom.container.querySelector('button[aria-controls="git-graph-pane-body"]');

      expect(graphHeaderControls).not.toBeNull();
      expect(graphButton?.parentElement?.lastElementChild).toBe(graphHeaderControls?.parentElement);

      await act(async () => {
        useUIStore.setState({ gitGraphPaneCollapsed: true });
        await flushEffects();
      });
      await renderPanesIntoRoot(root);

      expect(dom.container.querySelector('[data-graph-header-controls="true"]')).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
        await flushEffects();
      });
      dom.restore();
    }
  });

  test('renders graph expansion and height from one global layout shared across repositories', async () => {
    const dom = installDomStub();
    const root = createRoot(dom.container);

    useUIStore.getState().setGitGraphPaneCollapsed(false);
    useUIStore.getState().setGitGraphPaneHeight(432);
    useUIStore.getState().setGitRepositoryPaneState(directory, { changesCollapsed: true, graphFilterMode: 'manual' });
    useUIStore.getState().setGitRepositoryPaneState(otherDirectory, { changesCollapsed: false });

    try {
      await renderPanesIntoRoot(root, directory);
      expect(dom.container.querySelector('#git-graph-pane-body')?.getAttribute('style')).toContain('height: 432px');
      expect(dom.container.querySelector('button[aria-controls="git-graph-pane-body"]')?.getAttribute('aria-expanded')).toBe('true');

      await renderPanesIntoRoot(root, otherDirectory);
      expect(dom.container.querySelector('#git-graph-pane-body')?.getAttribute('style')).toContain('height: 432px');
      expect(dom.container.querySelector('button[aria-controls="git-graph-pane-body"]')?.getAttribute('aria-expanded')).toBe('true');
    } finally {
      await act(async () => {
        root.unmount();
        await flushEffects();
      });
      dom.restore();
    }
  });

  test('routes graph toggle, keyboard resize, pointer resize, and remount through the global layout store', async () => {
    const dom = installDomStub();
    const root: Root = createRoot(dom.container);

    try {
      await renderPanesIntoRoot(root, directory);

      const buttons = Array.from(dom.container.querySelectorAll('button'));
      const graphButton = buttons.find((button) => button.getAttribute('aria-controls') === 'git-graph-pane-body');
      const resizeHandle = dom.container.querySelector('[data-git-resize-handle="true"]');

      if (!graphButton || !resizeHandle) {
        throw new Error('Expected graph controls to render');
      }

      await act(async () => {
        graphButton.dispatchEvent(new window.Event('click', { bubbles: true }));
        await flushEffects();
      });

      expect(useUIStore.getState().gitGraphPaneCollapsed).toBe(false);
      expect(dom.container.querySelector('#git-graph-pane-body')?.getAttribute('style')).toContain('height: 280px');

      await act(async () => {
        resizeHandle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        await flushEffects();
      });

      expect(useUIStore.getState().gitGraphPaneHeight).toBe(304);

      await act(async () => {
        resizeHandle.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, clientY: 200 }));
        window.dispatchEvent(new window.PointerEvent('pointermove', { bubbles: true, clientY: 120 }));
        window.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, clientY: 120 }));
        await flushEffects();
      });

      expect(useUIStore.getState().gitGraphPaneHeight).toBe(384);

      await act(async () => {
        root.unmount();
        await flushEffects();
      });

      const remountRoot = createRoot(dom.container);
      await renderPanesIntoRoot(remountRoot, otherDirectory);

      expect(useUIStore.getState().gitGraphPaneCollapsed).toBe(false);
      expect(dom.container.querySelector('#git-graph-pane-body')?.getAttribute('style')).toContain('height: 384px');

      await act(async () => {
        remountRoot.unmount();
        await flushEffects();
      });
    } finally {
      dom.restore();
    }
  });

  test('renders the changes pane body as a fill-height flex column', () => {
    const markup = renderPanesMarkup();

    expect(markup).toContain('id="git-changes-pane-body" class="min-h-0 flex-1 flex flex-col"');
  });
});
