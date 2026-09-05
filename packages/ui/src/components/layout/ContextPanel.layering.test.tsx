import React from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

mock.module('@/hooks/useEffectiveDirectory', () => ({
  useEffectiveDirectory: () => '/repo',
}));

mock.module('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({
    themeMode: 'system',
    setThemeMode: () => {},
    lightThemeId: 'light',
    darkThemeId: 'dark',
    currentTheme: 'light',
  }),
  useOptionalThemeSystem: () => null,
}));

mock.module('./ContextSidebarTab', () => ({
  ContextPanelContent: () => React.createElement('div', { 'data-context-content': 'true' }),
}));

mock.module('./RightSidebarTabs', () => ({
  ProjectContextPanel: () => null,
}));

mock.module('./SidebarFilesTree', () => ({
  SidebarFilesTree: () => null,
}));

mock.module('@/components/browser/BrowserPane', () => ({
  BrowserPane: () => null,
}));

mock.module('@/components/views/PullRequestView', () => ({
  PullRequestView: () => null,
}));

mock.module('@/components/views/TerminalView', () => ({
  TerminalView: () => null,
}));

mock.module('@/sync/sync-context', () => ({
  setExternallyViewedSession: () => {},
  useDirectoryStore: () => ({
    subscribe: () => () => {},
    getState: () => ({ session: [] }),
  }),
}));

const { ContextPanel } = await import('./ContextPanel');

let windowInstance: Window;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  windowInstance = new Window();
  Object.assign(globalThis, {
    window: windowInstance,
    document: windowInstance.document,
    HTMLElement: windowInstance.HTMLElement,
    Element: windowInstance.Element,
    Node: windowInstance.Node,
    ResizeObserver: windowInstance.ResizeObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  host = document.createElement('div');
  document.body.append(host);
  const stylesheet = document.createElement('style');
  stylesheet.textContent = '.z-10 { position: relative; z-index: 10; } .z-20 { position: relative; z-index: 20; }';
  document.head.append(stylesheet);
  root = createRoot(host);
  useUIStore.setState({ contextPanelByDirectory: {} });
  useUIStore.getState().openContextPanelTab('/repo', { mode: 'context' });
});

afterEach(async () => {
  await act(async () => root.unmount());
  windowInstance.close();
});

describe('ContextPanel layering', () => {
  test('keeps open docked and expanded panels above the chat composer layer', async () => {
    expect(useUIStore.getState().contextPanelByDirectory['/repo']?.isOpen).toBe(true);

    await act(async () => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement('div', { className: 'z-10', 'data-chat-composer-layer': 'true' }),
          React.createElement(I18nProvider, null, React.createElement(ContextPanel)),
        ),
      );
    });

    const panel = host.querySelector<HTMLElement>('[data-context-panel="true"]');
    const composer = host.querySelector<HTMLElement>('[data-chat-composer-layer="true"]');
    if (!panel || !composer) {
      throw new Error('Expected the context panel and composer layer to render');
    }

    expect(Number.parseInt(window.getComputedStyle(panel).zIndex, 10)).toBeGreaterThan(
      Number.parseInt(window.getComputedStyle(composer).zIndex, 10),
    );

    await act(async () => {
      useUIStore.getState().toggleContextPanelExpanded('/repo');
    });

    expect(Number.parseInt(window.getComputedStyle(panel).zIndex, 10)).toBeGreaterThan(
      Number.parseInt(window.getComputedStyle(composer).zIndex, 10),
    );
  });
});
