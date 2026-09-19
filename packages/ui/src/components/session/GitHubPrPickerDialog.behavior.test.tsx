import React, { act } from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

const project = { id: 'project-a', path: '/workspace/project-a' };
const projectStoreState = { getActiveProject: () => project };
const githubAuthState = { status: { connected: true }, hasChecked: true };
const uiState = {
  isMobile: false,
  setSettingsDialogOpen: () => undefined,
  setSettingsPage: () => undefined,
};

const prsList = mock(async () => ({
  connected: true,
  repo: { owner: 'acme', repo: 'app' },
  page: 1,
  hasMore: false,
  incomplete: true,
  prs: [
    {
      number: 10,
      title: 'Enriched fix',
      url: 'https://github.com/acme/app/pull/10',
      state: 'open',
      draft: false,
      base: 'main',
      head: 'feat',
      sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
    },
    {
      number: 11,
      title: 'Lightweight fix',
      url: 'https://github.com/acme/app/pull/11',
      state: 'open',
      draft: false,
      base: '',
      head: '',
      sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
    },
  ],
}));

const passthrough = ({ children }: React.PropsWithChildren) => <div>{children}</div>;

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: React.PropsWithChildren<{ open: boolean }>) => open ? <>{children}</> : null,
  DialogContent: passthrough,
  DialogHeader: passthrough,
  DialogTitle: passthrough,
  DialogDescription: passthrough,
}));
mock.module('@/components/ui/MobileOverlayPanel', () => ({ MobileOverlayPanel: passthrough }));
mock.module('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: passthrough }));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/ui', () => ({ toast: { error: () => undefined, success: () => undefined } }));
mock.module('@/components/ui/checkbox', () => ({
  Checkbox: () => <input type="checkbox" />,
}));
mock.module('@/hooks/useDebouncedValue', () => ({
  useDebouncedValue: (value: string) => value,
}));
mock.module('@/lib/device', () => ({
  useDeviceInfo: () => ({ isMobile: false, isTablet: false }),
}));
const selectProjectState = <T,>(selector: (state: typeof projectStoreState) => T): T => selector(projectStoreState);
const selectGitHubAuthState = <T,>(selector: (state: typeof githubAuthState) => T): T => selector(githubAuthState);
const selectUIState = <T,>(selector: (state: typeof uiState) => T): T => selector(uiState);

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: selectProjectState,
}));
mock.module('@/stores/useGitHubAuthStore', () => ({
  useGitHubAuthStore: selectGitHubAuthState,
}));
mock.module('@/stores/useUIStore', () => ({
  useUIStore: selectUIState,
}));
const githubApi = { prsList, prContext: async () => ({ connected: true }) };
mock.module('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({ github: githubApi }),
}));

const { GitHubPrPickerDialog } = await import('./GitHubPrPickerDialog');
const { I18nProvider } = await import('@/lib/i18n');

const DOM_GLOBAL_NAMES = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLIFrameElement',
  'HTMLInputElement',
  'localStorage',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

const installDom = () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const values = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    Node: happyWindow.Node,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    HTMLIFrameElement: happyWindow.HTMLIFrameElement,
    HTMLInputElement: happyWindow.HTMLInputElement,
    localStorage: happyWindow.localStorage,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of DOM_GLOBAL_NAMES) {
    Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container,
    happyWindow,
    restore: () => {
      happyWindow.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

describe('GitHubPrPickerDialog incomplete search', () => {
  test('keeps lightweight matches and shows an incomplete notice', async () => {
    const dom = installDom();
    const root = createRoot(dom.container);
    try {
      await act(async () => root.render(
        <I18nProvider>
          <GitHubPrPickerDialog open onOpenChange={() => undefined} />
        </I18nProvider>,
      ));
      await act(async () => { await Promise.resolve(); });

      expect(dom.container.textContent).toContain('Enriched fix');
      expect(dom.container.textContent).toContain('Lightweight fix');
      expect(dom.container.textContent).toContain('This search is incomplete. Some matching pull requests could not be fully loaded.');
      expect(dom.container.textContent).not.toContain('No pull requests found');
      expect(dom.container.querySelector('[role="status"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
