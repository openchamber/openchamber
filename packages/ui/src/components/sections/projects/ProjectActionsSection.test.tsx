import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';

const desktopSshState = { instances: [], load: async () => undefined };

mock.module('@/lib/desktop', () => ({ isDesktopShell: () => false }));
mock.module('@/stores/useDesktopSshStore', () => ({
  useDesktopSshStore: <T,>(selector: (state: typeof desktopSshState) => T): T => selector(desktopSshState),
}));
mock.module('@/lib/openchamberConfig', () => ({
  getProjectActionsState: async () => ({
    actions: [{ id: 'build', name: 'Build', command: 'echo build', icon: 'build' }],
    primaryActionId: null,
  }),
  saveProjectActionsState: async () => true,
}));

const { ProjectActionsSection } = await import('./ProjectActionsSection');

describe('ProjectActionsSection', () => {
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
      MutationObserver: windowInstance.MutationObserver,
      getComputedStyle: windowInstance.getComputedStyle.bind(windowInstance),
      requestAnimationFrame: windowInstance.requestAnimationFrame.bind(windowInstance),
      cancelAnimationFrame: windowInstance.cancelAnimationFrame.bind(windowInstance),
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    windowInstance.close();
  });

  test('shows the current worktree label when runIn is omitted', async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <ProjectActionsSection projectRef={{ id: 'project-1', path: '/repo' }} />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    const actionTrigger = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Build'));
    if (!actionTrigger) {
      throw new Error('expected saved action trigger');
    }

    await act(async () => {
      actionTrigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const runInTrigger = host.querySelector<HTMLButtonElement>('button[aria-label="Working directory for this action"]');
    expect(runInTrigger?.textContent).toContain('Current worktree');
    expect(runInTrigger?.textContent).not.toContain('__project__');
  });
});
