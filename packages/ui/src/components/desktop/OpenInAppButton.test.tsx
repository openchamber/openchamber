import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import { OPEN_IN_APPS } from '@/lib/openInApps';
import { useOpenInAppsStore } from '@/stores/useOpenInAppsStore';

mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  DropdownMenuContent: ({ children, ...props }: React.ComponentProps<'div'>) => React.createElement('div', props, children),
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => React.createElement('button', { type: 'button', onClick }, children),
  DropdownMenuSeparator: () => React.createElement('hr'),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));
mock.module('@/components/ui', () => ({
  toast: {
    success: () => undefined,
    error: () => undefined,
    info: () => undefined,
  },
}));

// The component renders nothing unless it believes it runs in the desktop shell,
// so the shell checks answer yes and the installed-app scan stays empty.
const desktop = await import('@/lib/desktop');
mock.module('@/lib/desktop', () => ({
  ...desktop,
  isDesktopShell: () => true,
  isDesktopLocalOriginActive: () => true,
  fetchDesktopInstalledApps: async () => ({
    apps: [
      { name: 'Ghostty', iconDataUrl: undefined },
      { name: 'Visual Studio Code', iconDataUrl: undefined },
    ],
    success: true,
    hasCache: true,
    isCacheStale: false,
  }),
}));

const { OpenInAppButton } = await import('./OpenInAppButton');

describe('OpenInAppButton', () => {
  let windowInstance: Window;
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    windowInstance = new Window({ url: 'http://localhost/' });
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      navigator: windowInstance.navigator,
      Node: windowInstance.Node,
      Element: windowInstance.Element,
      HTMLElement: windowInstance.HTMLElement,
      Event: windowInstance.Event,
      MouseEvent: windowInstance.MouseEvent,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    useOpenInAppsStore.setState({
      selectedAppId: 'vscode',
      availableApps: OPEN_IN_APPS.filter((app) => app.id === 'vscode' || app.id === 'ghostty'),
      hasLoadedApps: true,
      isScanning: false,
      isCacheStale: false,
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  // A menu in the floating work-status card renders in a body portal, so the
  // card's outside-press dismissal needs the marker to know the press is its own.
  test('the app picker menu carries the work-status popup marker', async () => {
    await act(async () => {
      root.render(
        React.createElement(I18nProvider, null,
          React.createElement(OpenInAppButton, { directory: '/repo' }),
        ),
      );
    });
    await act(async () => { await Promise.resolve(); });

    expect(host.querySelector('[data-work-status-popup]')).not.toBeNull();
  });
});
