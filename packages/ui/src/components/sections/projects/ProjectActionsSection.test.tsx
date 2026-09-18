import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';

const desktopSshState = { instances: [], load: async () => undefined };

mock.module('@/stores/useDesktopSshStore', () => ({
  useDesktopSshStore: <T,>(selector: (state: typeof desktopSshState) => T): T => selector(desktopSshState),
}));
mock.module('@/lib/openchamberConfig', () => ({
  getProjectSetup: async () => ({
    trust: { hash: 'sha256:abc', trusted: true },
    setupWorktree: [],
    setupWorktreeWait: false,
    projectActions: [{ id: 'build', name: 'Build', command: 'echo build', icon: 'build', source: 'personal' }],
    projectActionsPrimaryId: null,
    draftStarters: [],
    shared: {
      status: 'ok',
      path: '.openchamber/project.json',
      setupWorktree: [],
      setupWorktreeWait: null,
      projectActions: [{ id: 'dev', name: 'Team dev', command: 'bun run dev', icon: null }],
      draftStarters: [],
      plansDir: null,
    },
    personal: {
      setupWorktree: [],
      setupWorktreeWait: null,
      setupWorktreeMode: 'append',
      projectActions: [{ id: 'build', name: 'Build', command: 'echo build', icon: 'build' }],
      projectActionsPrimaryId: null,
      draftStarters: [],
      hiddenSharedActionIds: [],
      sharedTrust: { hash: 'sha256:abc', trustedAt: 1 },
    },
  }),
  saveProjectActionsState: async () => true,
  updateProjectSetup: async () => true,
  updateSharedProjectSetup: async () => null,
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

  test('lists the team\'s shared actions read-only, marked as shared, above the editable ones', async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <ProjectActionsSection projectRef={{ id: 'project-1', path: '/repo' }} />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    const text = host.textContent ?? '';
    expect(text).toContain('Team dev');
    expect(text).toContain('Stored in the repository (.openchamber/project.json)');
    // The shared row is not a collapsible editor: no button carries its name.
    const sharedTrigger = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Team dev'));
    expect(sharedTrigger).toBe(undefined);
    expect(text.indexOf('Team dev')).toBeLessThan(text.indexOf('Build'));
  });
});
