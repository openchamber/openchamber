/**
 * Regression coverage for https://github.com/openchamber/openchamber/issues/6112
 *
 * Mobile web has no back button event, so Back left the app with a layer open.
 * These tests run the hook against a history that traverses for real: entries,
 * an index, truncation on push, and `popstate` delivered a task later. Happy DOM
 * reloads the document on Back instead.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AppRouteState } from '@/lib/router';
import type { Session } from '@/lib/opencode/model';

for (const [folder, names] of [
  ['behavior', ['BehaviorPage']],
  ['websearch', ['WebSearchPage']],
  ['commands', ['CommandsSidebar', 'CommandsPage']],
  ['mcp', ['McpPage']],
  ['skills', ['SkillsSidebar', 'SkillsPage']],
  ['projects', ['ProjectsSidebar', 'ProjectsPage']],
  ['remote-instances', ['RemoteInstancesPage']],
  ['providers', ['ProvidersPage']],
  ['usage', ['UsageSidebar', 'UsagePage']],
  ['magic-prompts', ['MagicPromptsSidebar', 'MagicPromptsPage']],
  ['snippets', ['SnippetsSidebar', 'SnippetsPage']],
  ['git-identities', ['GitPage']],
  ['integrations', ['IntegrationsPage']],
  ['routing', ['RoutingPage']],
  ['extensions', ['ExtensionsPage']],
  ['openchamber', ['OpenChamberPage', 'AboutSettings']],
] as const) {
  for (const name of names) {
    mock.module(`@/components/sections/${folder}/${name}`, () => ({ [name]: () => null }));
  }
}
mock.module('@/components/sections/plugins', () => ({ PluginsPage: () => null }));
mock.module('@/components/sections/agents/AgentsPage', () => ({ AgentsPage: () => null }));
mock.module('@/components/sections/agents/AgentsSidebar', () => ({
  AgentsSidebar: ({ onItemSelect }: { onItemSelect?: () => void }) => (
    <button type="button" data-testid="open-item" onClick={onItemSelect}>item</button>
  ),
}));

const dom = new Window({ url: 'http://localhost/mobile.html' });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  ResizeObserver: dom.ResizeObserver,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
  fetch: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }),
});
dom.HTMLElement.prototype.scrollIntoView = () => {};

const { closeTopmostBackLayer, registerBackLayer } = await import('@/lib/mobileBackLayers');
const { updateBrowserURL } = await import('@/lib/router');
const { I18nProvider } = await import('@/lib/i18n');
const { openSession } = await import('@/lib/router/openSessionFromRoute');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useRouter } = await import('@/hooks/useRouter');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useUIStore } = await import('@/stores/useUIStore');
const { SettingsView } = await import('@/components/views/SettingsView');
const { useMobileWebBackButton } = await import('./mobileNativeChrome');

type EntryState = { route?: AppRouteState; __openchamberBackGuard?: boolean } | null;
type Entry = { state: EntryState; url: string };

/** Browser session history: a push drops the forward entries, traversal is async. */
class TraversableHistory {
  entries: Entry[] = [];
  index = -1;
  traversals = 0;

  reset(urls: string[]): void {
    this.entries = urls.map((url) => ({ state: null, url }));
    this.index = urls.length - 1;
    this.traversals = 0;
    dom.happyDOM.setURL(this.entries[this.index].url);
  }

  get state(): EntryState {
    return this.entries[this.index]?.state ?? null;
  }

  get length(): number {
    return this.entries.length;
  }

  pushState(state: EntryState, _unused: string, url?: string): void {
    const next = this.resolve(url);
    this.entries.splice(this.index + 1);
    this.entries.push({ state, url: next });
    this.index += 1;
    dom.happyDOM.setURL(next);
  }

  replaceState(state: EntryState, _unused: string, url?: string): void {
    const next = this.resolve(url);
    this.entries[this.index] = { state, url: next };
    dom.happyDOM.setURL(next);
  }

  back(): void {
    this.go(-1);
  }

  forward(): void {
    this.go(1);
  }

  go(delta: number): void {
    this.traversals += 1;
    dom.setTimeout(() => {
      const target = this.index + delta;
      if (target < 0 || target >= this.entries.length) return;
      this.index = target;
      dom.happyDOM.setURL(this.entries[target].url);
      dom.dispatchEvent(new dom.PopStateEvent('popstate'));
    }, 0);
  }

  private resolve(url?: string): string {
    return url === undefined ? dom.location.href : new URL(url, dom.location.href).href;
  }
}

const history = new TraversableHistory();
Object.defineProperty(dom, 'history', { configurable: true, value: history });

const OUTSIDE = 'http://localhost/elsewhere';
const APP = 'http://localhost/mobile.html?session=a';

const settle = async () => {
  await act(async () => {
    for (let round = 0; round < 6; round += 1) {
      await new Promise((resolve) => dom.setTimeout(resolve, 0));
    }
  });
};

const press = async (direction: 'back' | 'forward') => {
  await act(async () => history[direction]());
  await settle();
};

type ShellHandle = {
  ladderRuns: number;
  open: (layer: 'drawer' | 'settings' | 'sheet' | 'popup') => void;
  close: (layer: 'drawer' | 'settings' | 'sheet' | 'popup') => void;
};

const shell: ShellHandle = { ladderRuns: 0, open: () => {}, close: () => {} };

const Sheet: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  React.useEffect(() => registerBackLayer(onClose), [onClose]);
  return <div data-testid="sheet" />;
};

const Popup: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => ref.current?.focus(), []);
  return (
    <div
      ref={ref}
      data-testid="popup"
      data-open=""
      role="menu"
      tabIndex={-1}
      onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}
    />
  );
};

const Shell: React.FC = () => {
  const [open, setOpen] = React.useState<Record<string, boolean>>({});
  const settingsBack = React.useRef<(() => boolean) | null>(null);
  const registerBackHandler = React.useCallback((handler: (() => boolean) | null) => {
    settingsBack.current = handler;
  }, []);
  const close = React.useCallback((layer: string) => setOpen((current) => ({ ...current, [layer]: false })), []);
  const closeSheet = React.useCallback(() => close('sheet'), [close]);
  const closePopup = React.useCallback(() => close('popup'), [close]);
  shell.open = (layer) => setOpen((current) => ({ ...current, [layer]: true }));
  shell.close = close;

  // MobileShell's ladder, in its order.
  const handleBack = React.useCallback(() => {
    shell.ladderRuns += 1;
    if (closeTopmostBackLayer()) return true;
    if (open.settings && settingsBack.current?.()) return true;
    if (open.settings) {
      close('settings');
      return true;
    }
    if (open.drawer) {
      close('drawer');
      return true;
    }
    return false;
  }, [close, open]);

  useMobileWebBackButton(handleBack, Boolean(open.settings || open.drawer));

  return (
    <I18nProvider>
      {open.drawer ? <div data-testid="drawer" /> : null}
      {open.settings ? (
        <SettingsView
          forceMobile
          isWindowed
          initialMobileStage="page-content"
          visiblePageSlugs={['agents']}
          registerBackHandler={registerBackHandler}
        />
      ) : null}
      {open.sheet ? <Sheet onClose={closeSheet} /> : null}
      {open.popup ? <Popup onClose={closePopup} /> : null}
    </I18nProvider>
  );
};

const visible = (testId: string) => document.querySelector(`[data-testid="${testId}"]`) !== null;
const inApp = () => history.entries[history.index].url !== OUTSIDE;

let container: HTMLElement;
let root: Root;

const mountShell = async () => {
  await act(async () => root.render(<Shell />));
  await settle();
};

const RoutedShell: React.FC = () => {
  useRouter();
  return <Shell />;
};

const show = async (layer: Parameters<ShellHandle['open']>[0]) => {
  await act(async () => shell.open(layer));
  await settle();
};

const hide = async (layer: Parameters<ShellHandle['close']>[0]) => {
  await act(async () => shell.close(layer));
  await settle();
};

beforeEach(() => {
  history.reset([OUTSIDE, APP]);
  shell.ladderRuns = 0;
  useUIStore.setState({ settingsPage: 'agents', isSettingsDialogOpen: false });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  Reflect.deleteProperty(dom, 'Capacitor');
});

describe('useMobileWebBackButton', () => {
  test('with nothing open, Back leaves the app without running the ladder', async () => {
    await mountShell();
    expect(history.length).toBe(2);
    await press('back');
    expect(inApp()).toBe(false);
    expect(shell.ladderRuns).toBe(0);
  });

  test('each Back closes one nested layer before navigation can leave the app', async () => {
    await mountShell();
    await show('drawer');
    await show('sheet');
    await show('popup');

    await press('back');
    expect([visible('popup'), visible('sheet'), visible('drawer')]).toEqual([false, true, true]);
    await press('back');
    expect([visible('popup'), visible('sheet'), visible('drawer')]).toEqual([false, false, true]);
    await press('back');
    expect(visible('drawer')).toBe(false);
    expect(inApp()).toBe(true);
    expect(history.entries[history.index].url).toBe(APP);

    await press('back');
    expect(inApp()).toBe(false);
  });

  test('a popup opened directly over the chat is closed by Back', async () => {
    await mountShell();
    await show('popup');
    await press('back');
    expect(visible('popup')).toBe(false);
    expect(inApp()).toBe(true);
  });

  test('a press after the ladder runs out of layers leaves the guard for good', async () => {
    await mountShell();
    await show('sheet');
    await press('back');
    await press('back');
    expect(inApp()).toBe(false);
    expect(shell.ladderRuns).toBe(1);
  });

  test('Back walks the Settings stages with one traversal per press', async () => {
    await mountShell();
    await show('settings');
    const label = () => container.querySelector('button[aria-label]')?.getAttribute('aria-label');
    expect(label()).toBe('Back');

    const before = history.traversals;
    await press('back');
    expect(label()).toBe('Back to settings');
    expect(history.traversals).toBe(before + 1);
    expect(shell.ladderRuns).toBe(1);

    await press('back');
    expect(container.querySelector('[data-settings-search]')).not.toBeNull();
    expect(label()).toBeUndefined();
    expect(history.traversals).toBe(before + 2);

    await press('back');
    expect(container.querySelector('[data-settings-search]')).toBeNull();
    expect(inApp()).toBe(true);
  });

  test('moving through a split page in Settings writes and walks no history', async () => {
    await mountShell();
    await show('settings');
    const length = history.length;
    const traversals = history.traversals;
    const header = () => container.querySelector<HTMLButtonElement>('button[aria-label]')!;

    await act(async () => header().click());
    await settle();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="open-item"]')!.click());
    await settle();
    expect(header().getAttribute('aria-label')).toBe('Back');
    await act(async () => header().click());
    await settle();
    expect(header().getAttribute('aria-label')).toBe('Back to settings');

    expect(history.length).toBe(length);
    expect(history.traversals).toBe(traversals);
    expect(shell.ladderRuns).toBe(0);
  });

  test('repeated open and close through the UI leaves no stack of empty presses', async () => {
    await mountShell();
    for (let cycle = 0; cycle < 5; cycle += 1) {
      await show('drawer');
      await hide('drawer');
    }
    expect(history.index).toBe(1);
    expect(history.entries[history.index].url).toBe(APP);

    await press('back');
    expect(inApp()).toBe(false);
    expect(shell.ladderRuns).toBe(0);
  });

  test('a session opened from under a layer keeps its route entry', async () => {
    await mountShell();
    await show('drawer');
    await act(async () => {
      updateBrowserURL({ sessionId: 'b', isSettingsOpen: false, settingsPath: '' });
      shell.close('drawer');
    });
    await settle();

    expect(dom.location.search).toBe('?session=b');
    await press('back');
    expect(dom.location.search).toBe('?session=a');
    expect(shell.ladderRuns).toBe(0);
    await press('back');
    expect(inApp()).toBe(false);
  });

  test('a route written while a layer stays open keeps the layer on Back', async () => {
    await mountShell();
    await show('drawer');
    await act(async () => updateBrowserURL({ sessionId: 'b', isSettingsOpen: false, settingsPath: '' }));
    await settle();

    await press('back');
    expect(visible('drawer')).toBe(false);
    expect(dom.location.search).toBe('?session=b');
    await press('back');
    expect(dom.location.search).toBe('?session=a');
  });

  test('a fork resolved to its parent under a layer costs Back no extra stop', async () => {
    const session = (id: string, metadata?: Session['metadata']): Session => ({
      id,
      projectID: 'project',
      directory: '/project',
      title: id,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 2 },
      metadata,
    });
    const known = (sessions: Session[], hasLoaded: boolean) => ({
      activeSessions: sessions,
      archivedSessions: [],
      entityById: new Map(sessions.map((entry) => [entry.id, entry])),
      hasLoaded,
      status: 'ready' as const,
    });
    const all = [
      session('a'),
      session('parent'),
      session('fork', { openchamber: { kind: 'btw', originalSessionID: 'parent' } }),
    ];
    useProjectsStore.setState({ projects: [{ id: '/project', path: '/project' }] });
    const loadSessions = useGlobalSessionsStore.getState().loadSessions;
    useGlobalSessionsStore.setState(known(all, true));
    useSessionUIStore.getState().setCurrentSession('a', '/project');
    await act(async () => root.render(<RoutedShell />));
    await settle();
    await show('drawer');

    // A cold link: the fork is selected first and resolves once the list loads.
    useGlobalSessionsStore.setState({
      ...known([session('a')], false),
      loadSessions: async () => {
        useGlobalSessionsStore.setState(known(all, true));
        return { activeSessions: all, archivedSessions: [] };
      },
    });
    await act(async () => openSession('fork', { directory: '/project' }));
    await settle();
    useGlobalSessionsStore.setState({ loadSessions });
    expect(dom.location.search).toBe('?session=parent');

    await hide('drawer');
    expect(dom.location.search).toBe('?session=parent');
    expect(useSessionUIStore.getState().currentSessionId).toBe('parent');

    await press('back');
    expect(dom.location.search).toBe('?session=a');
    expect(shell.ladderRuns).toBe(0);
  });

  test('Forward never runs the ladder and does not end on a spent guard', async () => {
    await mountShell();
    await show('drawer');
    await press('back');
    expect(shell.ladderRuns).toBe(1);

    await press('forward');
    expect(shell.ladderRuns).toBe(1);
    expect(history.entries[history.index].url).toBe(APP);
    expect(history.index).toBe(1);

    history.pushState({}, '', '?session=b');
    await press('back');
    await show('sheet');
    await press('back');
    expect(shell.ladderRuns).toBe(2);
    await press('forward');
    expect(shell.ladderRuns).toBe(2);
  });

  test('a reload on the guard takes the spent guard off the stack', async () => {
    history.pushState({ __openchamberBackGuard: true }, '');
    await mountShell();
    expect(history.index).toBe(1);
    await press('back');
    expect(inApp()).toBe(false);
    expect(shell.ladderRuns).toBe(0);
  });

  test('does nothing on Capacitor, where the native button owns back', async () => {
    Object.assign(dom, { Capacitor: { isNativePlatform: () => true } });
    await mountShell();
    await show('drawer');
    expect(history.length).toBe(2);
    await press('back');
    expect(shell.ladderRuns).toBe(0);
  });
});
