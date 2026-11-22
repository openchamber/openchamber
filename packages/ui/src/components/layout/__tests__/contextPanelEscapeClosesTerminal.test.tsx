/**
 * Regression guard for https://github.com/openchamber/openchamber/issues/2644
 *
 * Escape while focus is inside the terminal must reach the PTY (e.g. Vim
 * Normal mode). The context panel still closes on Escape when focus is on
 * non-terminal panel chrome. The mobile workspace drawer keeps the same
 * exception: its terminal tab owns Escape, every other tab closes on it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  DIRECTORY,
  TERMINAL_DIRECTORY,
  installDom,
  pressEscape,
  ptyKeys,
  renderContextPanels,
} from './contextPanelHarness';

// The drawer mounts every tab's body, hidden or not. Their own tests cover them, so they stand in here.
mock.module('@/apps/MobileChangesSurface', () => ({ MobileChangesSurface: () => null }));
mock.module('@/apps/MobileFilesSurface', () => ({ MobileFilesSurface: () => null }));
mock.module('@/components/layout/RightSidebarTabs', () => ({ ProjectContextPanel: () => null }));

const dom = installDom();
const { useUIStore } = await import('@/stores/useUIStore');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');

afterAll(async () => {
  await dom.restore();
});

describe('issue #2644: Escape in terminal must not close the context panel', () => {
  let root: Root;

  const isPanelOpen = (): boolean => useUIStore.getState().contextPanelByDirectory[DIRECTORY]?.isOpen === true;
  const terminalInput = (): HTMLInputElement => {
    const input = document.querySelector<HTMLInputElement>('[aria-label="terminal input"]');
    if (!input) throw new Error('the terminal is not mounted');
    return input;
  };

  beforeEach(async () => {
    useUIStore.setState({ contextPanelByDirectory: {} });
    useDirectoryStore.setState({ currentDirectory: DIRECTORY });
    ptyKeys.length = 0;
    // Opening the terminal reveals the right zone with the terminal active.
    useUIStore.getState().openContextPanelTab(DIRECTORY, { mode: 'terminal', targetDirectory: TERMINAL_DIRECTORY });
    root = createRoot(dom.container);
    await renderContextPanels(root);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  test('Escape typed in the terminal reaches the PTY and leaves the panel open', async () => {
    expect(isPanelOpen()).toBe(true);

    const notPrevented = await pressEscape(terminalInput());

    expect(ptyKeys).toEqual(['Escape']);
    expect(notPrevented).toBe(true);
    expect(isPanelOpen()).toBe(true);
  });

  // Escape no longer closes a context zone (upstream a6dc1101c1); the drawer below keeps its own rule.
});

describe('issue #2644: the mobile drawer keeps its terminal Escape exception', () => {
  let root: Root;
  let closes = 0;

  const renderDrawer = async (tab: 'terminal' | 'changes'): Promise<void> => {
    const { I18nProvider } = await import('@/lib/i18n');
    const { MobileWorkspaceDrawer } = await import('@/apps/MobileWorkspaceDrawer');
    await act(async () => {
      root.render(
        <I18nProvider>
          <MobileWorkspaceDrawer
            open
            variant="panel"
            tab={tab}
            onClose={() => { closes += 1; }}
            onTabChange={() => undefined}
            registerPreviewBackHandler={() => undefined}
            pendingChangesDiff={null}
            pendingChangesCommit={null}
            onOpenPlan={() => undefined}
            onOpenReceivedPage={() => undefined}
          />
        </I18nProvider>,
      );
    });
  };

  beforeEach(() => {
    closes = 0;
    root = createRoot(dom.container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  test('Escape while the terminal tab is active leaves the drawer open', async () => {
    await renderDrawer('terminal');

    await pressEscape(document.body);

    expect(closes).toBe(0);
  });

  test('Escape on another tab closes the drawer', async () => {
    await renderDrawer('changes');

    await pressEscape(document.body);

    expect(closes).toBe(1);
  });
});
