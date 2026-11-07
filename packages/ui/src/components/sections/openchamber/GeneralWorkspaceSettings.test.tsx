import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

import { GeneralWorkspaceSettings } from './GeneralWorkspaceSettings';

const ROW_SELECTOR = '[data-settings-item="general.command-palette-show-archived-sessions"]';

// SAFETY: The rendered General page only reads the optional terminal methods, so no other runtime API can be called.
const runtimeAPIs = { terminal: {} } as RuntimeAPIs;

describe('GeneralWorkspaceSettings command palette archived sessions row', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let initialState: ReturnType<typeof useUIStore.getState>;
  let globalDescriptors: Map<string, PropertyDescriptor | undefined>;

  const globalNames = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'localStorage', 'sessionStorage', 'IS_REACT_ACT_ENVIRONMENT'];

  beforeEach(() => {
    initialState = useUIStore.getState();
    windowInstance = new Window();
    globalDescriptors = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      localStorage: windowInstance.localStorage,
      sessionStorage: windowInstance.sessionStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      useUIStore.setState(initialState, true);
      windowInstance.close();
      for (const [name, descriptor] of globalDescriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  const renderGeneral = async (): Promise<void> => {
    await act(async () => root.render(
      <RuntimeAPIContext.Provider value={runtimeAPIs}>
        <ThemeSystemProvider>
          <I18nProvider>
            <GeneralWorkspaceSettings firstSection />
          </I18nProvider>
        </ThemeSystemProvider>
      </RuntimeAPIContext.Provider>,
    ));
  };

  const expectEnabledRowThatToggles = async (): Promise<void> => {
    const row = host.querySelector<HTMLElement>(ROW_SELECTOR);
    expect(row).not.toBeNull();
    expect(row?.getAttribute('aria-disabled')).toBeNull();
    expect(row?.getAttribute('aria-pressed')).toBe('false');

    await act(async () => row?.click());
    expect(useUIStore.getState().commandPaletteShowArchivedSessions).toBe(true);
    expect(host.querySelector(ROW_SELECTOR)?.getAttribute('aria-pressed')).toBe('true');
  };

  test('is present and enabled on the web runtime while message search is off', async () => {
    useUIStore.setState({ messageSearchEnabled: false, commandPaletteShowArchivedSessions: false });
    await renderGeneral();
    await expectEnabledRowThatToggles();
  });

  test('is present and enabled under the VS Code runtime while message search is off', async () => {
    Object.assign(windowInstance, { __VSCODE_CONFIG__: { workspaceFolder: '/workspace' } });
    useUIStore.setState({ messageSearchEnabled: false, commandPaletteShowArchivedSessions: false });
    await renderGeneral();
    await expectEnabledRowThatToggles();
  });
});
