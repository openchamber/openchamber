import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { Session } from '@opencode-ai/sdk/v2';
import type { WorktreeMetadata } from '@/types/worktree';

/**
 * The header session tabs' hover tooltip: the fade mask truncates the tab
 * title, so the tooltip is the only place the full title and the session's
 * own project are readable. The trigger attaches to the existing pill, which
 * already carries the tab handlers and the hover-revealed menu/close buttons,
 * and stays silent while the tab drags, shows its menus, or renders the
 * rename form.
 */

const installDom = (win: Window) => {
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    navigator: win.navigator,
    Node: win.Node,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    DocumentFragment: win.DocumentFragment,
    MutationObserver: win.MutationObserver,
    ResizeObserver: win.ResizeObserver,
    MouseEvent: win.MouseEvent,
    PointerEvent: win.PointerEvent,
    KeyboardEvent: win.KeyboardEvent,
    Event: win.Event,
    DOMRect: win.DOMRect,
    localStorage: win.localStorage,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
};

type Harness = {
  SessionTabsStrip: typeof import('./SessionTabsStrip').SessionTabsStrip;
  SyncProvider: typeof import('@/sync/sync-context').SyncProvider;
  I18nProvider: typeof import('@/lib/i18n').I18nProvider;
  useI18nStore: typeof import('@/lib/i18n').useI18nStore;
  TooltipProvider: typeof import('@/components/ui/tooltip').TooltipProvider;
  useSessionTabsStore: typeof import('@/stores/useSessionTabsStore').useSessionTabsStore;
  useGlobalSessionsStore: typeof import('@/stores/useGlobalSessionsStore').useGlobalSessionsStore;
  useProjectsStore: typeof import('@/stores/useProjectsStore').useProjectsStore;
  useDirectoryStore: typeof import('@/stores/useDirectoryStore').useDirectoryStore;
  useSessionUIStore: typeof import('@/sync/session-ui-store').useSessionUIStore;
  createOpencodeClient: typeof import('@opencode-ai/sdk/v2').createOpencodeClient;
  opencodeClient: typeof import('@/lib/opencode/client').opencodeClient;
};

const makeSession = (id: string, title: string, directory: string): Session => ({
  id, slug: id, projectID: 'project', directory, title, version: '1', time: { created: 0, updated: 1 },
});

const makeWorktree = (path: string, projectDirectory: string): WorktreeMetadata => ({
  path, projectDirectory, branch: 'feat', label: 'feat',
});

describe('header session tab tooltip', () => {
  let win: Window;
  let root: Root;
  let container: HTMLElement;
  let h: Harness;
  let requestHomeInfo: ReturnType<typeof spyOn>;

  const render = async (suppressActiveTabControls = false) => {
    await act(async () => {
      root.render(
        <h.SyncProvider sdk={h.createOpencodeClient({ baseUrl: 'http://tooltip.test', fetch: () => new Promise<Response>(() => undefined) })} directory="/repo">
          <h.I18nProvider>
            <h.TooltipProvider delayDuration={0}>
              <h.SessionTabsStrip renderMenu={() => <div>menu-item</div>} suppressActiveTabControls={suppressActiveTabControls}>
                <span>active content</span>
              </h.SessionTabsStrip>
            </h.TooltipProvider>
          </h.I18nProvider>
        </h.SyncProvider>,
      );
    });
  };

  const pills = () => [...container.querySelectorAll<HTMLElement>('.session-tab')];
  const tooltip = () => document.querySelector('[data-slot="tooltip-content"]');

  const hover = async (target: Element) => {
    await act(async () => {
      target.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
      target.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
      target.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }));
      target.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, movementX: 20 }));
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
  };

  const leave = async (target: Element) => {
    await act(async () => {
      target.dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: false }));
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
  };

  beforeEach(async () => {
    win = new Window({ url: 'http://localhost' });
    installDom(win);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // The shared UI modules bind `document` at import time, so the DOM shim
    // must be installed before any of them load.
    const [opencodeClientModule, sdkModule] = await Promise.all([
      import('@/lib/opencode/client'),
      import('@opencode-ai/sdk/v2'),
    ]);
    requestHomeInfo = spyOn(opencodeClientModule.opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({
      home: '/home/user',
      chatsRoot: '/srv/chats',
    });
    const [strip, sync, i18n, tooltip, tabsStore, sessionsStore, projectsStore, directoryStore, uiStore] = await Promise.all([
      import('./SessionTabsStrip'),
      import('@/sync/sync-context'),
      import('@/lib/i18n'),
      import('@/components/ui/tooltip'),
      import('@/stores/useSessionTabsStore'),
      import('@/stores/useGlobalSessionsStore'),
      import('@/stores/useProjectsStore'),
      import('@/stores/useDirectoryStore'),
      import('@/sync/session-ui-store'),
    ]);
    h = {
      SessionTabsStrip: strip.SessionTabsStrip,
      SyncProvider: sync.SyncProvider,
      I18nProvider: i18n.I18nProvider,
      useI18nStore: i18n.useI18nStore,
      TooltipProvider: tooltip.TooltipProvider,
      useSessionTabsStore: tabsStore.useSessionTabsStore,
      useGlobalSessionsStore: sessionsStore.useGlobalSessionsStore,
      useProjectsStore: projectsStore.useProjectsStore,
      useDirectoryStore: directoryStore.useDirectoryStore,
      useSessionUIStore: uiStore.useSessionUIStore,
      createOpencodeClient: sdkModule.createOpencodeClient,
      opencodeClient: opencodeClientModule.opencodeClient,
    };
    h.useSessionTabsStore.setState({ tabIds: [] });
    h.useProjectsStore.setState({ projects: [], activeProjectId: null });
    h.useDirectoryStore.setState({ homeDirectory: '/home/user' });
    h.useSessionUIStore.setState({ currentSessionId: 'session-1', availableWorktreesByProject: new Map() });
    h.useGlobalSessionsStore.getState().applySnapshot([
      makeSession('session-1', 'Short title', '/repo'),
      makeSession('session-2', 'A very long session title that the tab truncates with the fade mask', '/other/loose-dir'),
    ], [], 'ready');
    await render();
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.useSessionUIStore.setState({ currentSessionId: null });
    requestHomeInfo.mockRestore();
    await win.happyDOM.close();
  });

  test('attaches the tooltip to the pill without a native title or nested button trigger', async () => {
    await act(async () => { h.useSessionTabsStore.setState({ tabIds: ['session-1', 'session-2'] }); });
    const rendered = pills();
    expect(rendered).toHaveLength(2);
    expect(rendered[0]?.getAttribute('data-slot')).toBe('tooltip-trigger');
    expect(rendered[0]?.hasAttribute('title')).toBe(false);
    expect(rendered[0]?.getAttribute('role')).toBe('tab');
    // The pill is the trigger element itself, directly inside the sortable
    // slot: the tooltip wraps no extra element around it, so the slot's only
    // child is the pill.
    const slot = rendered[0]?.closest('.session-tab-slot');
    if (!slot) throw new Error('tab slot missing');
    expect(rendered[0]?.parentElement).toBe(slot);
    expect(slot.children).toHaveLength(1);
  });

  test('shows the full title and the owning project label on hover', async () => {
    await act(async () => {
      h.useProjectsStore.setState({ projects: [{ id: 'project', path: '/repo', label: 'My Repo' }] });
      h.useSessionTabsStore.setState({ tabIds: ['session-1', 'session-2'] });
    });
    await hover(pills()[1]!);
    const popup = tooltip();
    if (!popup) throw new Error('tooltip did not open');
    expect(popup.textContent).toContain('A very long session title that the tab truncates with the fade mask');
    // /other/loose-dir owns no project, so the directory name stands in.
    expect(popup.textContent).toContain('loose-dir');

    await leave(pills()[1]!);
    await hover(pills()[0]!);
    const activePopup = tooltip();
    if (!activePopup) throw new Error('tooltip did not open on the active tab');
    expect(activePopup.textContent).toContain('Short title');
    expect(activePopup.textContent).toContain('My Repo');
  });

  test('worktree sessions resolve to their project label', async () => {
    await act(async () => {
      h.useGlobalSessionsStore.getState().applySnapshot([
        makeSession('worktree-1', 'Worktree session', '/outside/managed-worktree'),
      ], [], 'ready');
      h.useProjectsStore.setState({ projects: [{ id: 'project', path: '/repo', label: 'Repo Label' }] });
      h.useSessionUIStore.setState({
        availableWorktreesByProject: new Map([['/repo', [makeWorktree('/outside/managed-worktree', '/repo')]]]),
      });
      h.useSessionTabsStore.setState({ tabIds: ['worktree-1'] });
    });
    const rendered = pills();
    if (!rendered[0]) throw new Error('worktree tab missing');
    await hover(rendered[0]);
    const popup = tooltip();
    if (!popup) throw new Error('tooltip did not open for worktree tab');
    expect(popup.textContent).toContain('Worktree session');
    expect(popup.textContent).toContain('Repo Label');
  });

  test('chats directories use the chats label', async () => {
    // Chat directories are only classified once the runtime has reported its
    // chats root, exactly as bootstrap warms it in the app.
    const { ensureChatsRootDirectory } = await import('@/lib/chatDirectories');
    await ensureChatsRootDirectory();
    await act(async () => {
      h.useGlobalSessionsStore.getState().applySnapshot([
        makeSession('chat-1', 'Managed chat', '/srv/chats/day/session-chat'),
      ], [], 'ready');
      h.useSessionTabsStore.setState({ tabIds: ['chat-1'] });
    });
    const rendered = pills();
    if (!rendered[0]) throw new Error('chat tab missing');
    await hover(rendered[0]);
    const popup = tooltip();
    if (!popup) throw new Error('tooltip did not open for chat tab');
    // Read the content box's rows directly instead of one concatenated
    // string, which would also depend on there being no whitespace between
    // them: the first row is the session title, the second the owner label.
    const rows = [...(popup.firstElementChild?.children ?? [])];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent?.trim()).toBe('Managed chat');
    // The chats branch fired: the owner row reads the chats label (not the
    // directory name `session-chat`), independent of the active dictionary.
    const chatsLabel = h.useI18nStore.getState().dictionary['sessions.sidebar.activity.chatsTitle'];
    expect(rows[1]?.textContent?.trim()).toBe(chatsLabel);
    expect(popup.textContent).not.toContain('session-chat');
  });

  test('suppresses the tooltip while the tab menu is open', async () => {
    await act(async () => { h.useSessionTabsStore.setState({ tabIds: ['session-1', 'session-2'] }); });
    const pill = pills()[1]!;
    const menuButton = pill.querySelector<HTMLButtonElement>('button[aria-label]');
    if (!menuButton) throw new Error('menu button missing');
    await act(async () => { menuButton.click(); });
    expect(pill.hasAttribute('data-trigger-disabled')).toBe(true);
    await hover(pill);
    expect(tooltip()).toBeNull();
    await act(async () => { menuButton.click(); });
    expect(pill.hasAttribute('data-trigger-disabled')).toBe(false);
  });

  test('closes an already-open tooltip when the tab menu opens', async () => {
    await act(async () => { h.useSessionTabsStore.setState({ tabIds: ['session-1', 'session-2'] }); });
    const pill = pills()[1]!;
    await hover(pill);
    expect(tooltip()).not.toBeNull();
    const menuButton = pill.querySelector<HTMLButtonElement>('button[aria-label]');
    if (!menuButton) throw new Error('menu button missing');
    await act(async () => {
      menuButton.click();
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(tooltip()).toBeNull();
  });

  test('suppresses the tooltip for the active tab while renaming', async () => {
    await act(async () => { h.useSessionTabsStore.setState({ tabIds: ['session-1', 'session-2'] }); });
    await render(true);
    const activePill = pills()[0]!;
    expect(activePill.hasAttribute('data-trigger-disabled')).toBe(true);
    await hover(activePill);
    expect(tooltip()).toBeNull();
  });

  test('closes the tooltip when a drag starts', async () => {
    await act(async () => { h.useSessionTabsStore.setState({ tabIds: ['session-1', 'session-2'] }); });
    const pill = pills()[1]!;
    await hover(pill);
    expect(tooltip()).not.toBeNull();
    const slot = pill.closest('.session-tab-slot');
    if (!slot) throw new Error('slot missing');
    await act(async () => {
      slot.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
      slot.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: 40, clientY: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(pill.hasAttribute('data-trigger-disabled')).toBe(true);
    expect(tooltip()).toBeNull();
    await act(async () => {
      slot.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, button: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  test('right-click opens the context menu and suppresses the tooltip', async () => {
    await act(async () => { h.useSessionTabsStore.setState({ tabIds: ['session-1', 'session-2'] }); });
    const pill = pills()[1]!;
    await act(async () => {
      pill.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.body.textContent).toContain('menu-item');
    expect(pill.hasAttribute('data-trigger-disabled')).toBe(true);
    await hover(pill);
    expect(tooltip()).toBeNull();
  });

  test('middle click closes the tab', async () => {
    await act(async () => { h.useSessionTabsStore.setState({ tabIds: ['session-1', 'session-2'] }); });
    const pill = pills()[1]!;
    await act(async () => {
      pill.dispatchEvent(new window.MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(h.useSessionTabsStore.getState().tabIds).toEqual(['session-1']);
  });

  test('a session without a directory shows only its title', async () => {
    await act(async () => {
      h.useGlobalSessionsStore.getState().applySnapshot([
        makeSession('no-directory', 'Directoryless session', ''),
      ], [], 'ready');
      h.useSessionTabsStore.setState({ tabIds: ['no-directory'] });
    });
    const rendered = pills();
    if (!rendered[0]) throw new Error('tab missing');
    await hover(rendered[0]);
    const popup = tooltip();
    if (!popup) throw new Error('tooltip did not open');
    expect(popup.textContent?.trim()).toBe('Directoryless session');
  });

  test('the transient draft pill carries no tooltip trigger', async () => {
    await act(async () => {
      h.useSessionTabsStore.setState({ tabIds: [] });
      h.useSessionUIStore.setState({ currentSessionId: null });
    });
    expect(container.querySelectorAll('[data-slot="tooltip-trigger"]')).toHaveLength(0);
    expect(container.querySelector('.session-tab-slot')?.textContent).toContain('active content');
  });

  test('keyboard focus opens the tooltip and blur closes it', async () => {
    await act(async () => { h.useSessionTabsStore.setState({ tabIds: ['session-1', 'session-2'] }); });
    const pill = pills()[1]!;
    await act(async () => {
      pill.focus();
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    // Positive control: focus must actually open the tooltip, otherwise the
    // blur assertion below would pass for a tooltip that never opened.
    expect(tooltip()).not.toBeNull();
    await act(async () => {
      pill.blur();
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(tooltip()).toBeNull();
  });

  test('click and keyboard activation keep working with the tooltip attached', async () => {
    await act(async () => { h.useSessionTabsStore.setState({ tabIds: ['session-1', 'session-2'] }); });
    await act(async () => { pills()[1]!.click(); });
    expect(h.useSessionUIStore.getState().currentSessionId).toBe('session-2');

    await act(async () => { h.useSessionUIStore.setState({ currentSessionId: 'session-1' }); });
    await act(async () => {
      pills()[1]!.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(h.useSessionUIStore.getState().currentSessionId).toBe('session-2');
  });
});
