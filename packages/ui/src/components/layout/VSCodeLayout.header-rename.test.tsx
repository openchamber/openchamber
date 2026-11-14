import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { create } from 'zustand';
import { Window } from 'happy-dom';
import { opencodeClient } from '@/lib/opencode/client';

const browser = new Window({ url: 'http://localhost' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: browser, document: browser.document, Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent, HTMLElement: browser.HTMLElement, HTMLInputElement: browser.HTMLInputElement, Node: browser.Node, localStorage: browser.localStorage, navigator: browser.navigator, ResizeObserver: browser.ResizeObserver, IS_REACT_ACT_ENVIRONMENT: true })) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true });
}
// The directory store asks for the home folder on import; no server answers here.
const homeSpy = spyOn(opencodeClient, 'getFilesystemHome').mockResolvedValue('/home/user');
// Editor tab, not connected: no bootstrap selects a session behind the test's back.
Object.assign(window, {
  __VSCODE_CONFIG__: { workspaceFolder: '', workspaceFolders: [], viewMode: 'editor' },
  __OPENCHAMBER_CONNECTION__: { status: 'disconnected' },
});
const empty = () => null;
const noOp = () => {};
const ui = create(() => ({
  runOverviewKey: null, setRunOverviewKey: noOp, workStatusPanelEnabled: false, setWorkStatusPanelEnabled: noOp,
  workStatusPanelFits: true, workStatusOverlayOpen: false, setWorkStatusOverlayOpen: noOp,
}));
let sessions: Array<{ id: string; title: string }> = [];
const errors: string[] = [];
mock.module('@/stores/useProjectsStore', () => ({ useProjectsStore: create(() => ({ projects: [], activeProjectId: null })) }));
mock.module('@/stores/useSessionDisplayStore', () => ({ useSessionDisplayStore: create(() => ({ showArchivedSessions: false, toggleArchivedSessions: noOp })) }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: ui }));
const syncContext = await import('@/sync/sync-context');
mock.module('@/sync/sync-context', () => ({
  ...syncContext,
  useSessions: () => [],
  useDirectorySync: <T,>(selector: (state: { session: typeof sessions; session_status: object }) => T): T => selector({ session: sessions, session_status: {} }),
  useSessionMessages: () => [], useSessionMessagesResolved: () => true,
}));
mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({}) }));
mock.module('@/hooks/useTerminalSessionKeepalive', () => ({ useTerminalSessionKeepalive: noOp }));
mock.module('@/hooks/useUpdatePolling', () => ({ useUpdatePolling: noOp }));
mock.module('@/hooks/useContextWindowLimits', () => ({ useContextWindowLimits: () => ({ context: 0, output: 0 }) }));
mock.module('@/components/chat/work-status/useSubagentCostRollup', () => ({ useSubagentCostRollup: () => ({ totalCost: 0 }) }));
mock.module('@/components/session/sidebar/list/useSessionListSync', () => ({ useSessionListSync: noOp }));
mock.module('@/components/ui', () => ({ toast: { success: noOp, error: (message: string) => errors.push(message) } }));
mock.module('@/components/views/ChatView', () => ({ ChatView: empty }));
mock.module('@/components/session/SessionSidebar', () => ({ SessionSidebar: empty }));
mock.module('@/components/session/SessionDialogs', () => ({ SessionDialogs: empty }));
mock.module('@/components/multirun/RunOverview', () => ({ RunOverview: empty }));
mock.module('@/components/chat/work-status/useWorkStatusVisibility', () => ({ WORK_STATUS_COLUMN_WIDTH: 324 }));
mock.module('@/lib/multirun/autoFusion', () => ({ RunAutoFusion: empty }));
mock.module('@/components/session/SessionSwitcherDropdown', () => ({ SessionSwitcherDropdown: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
mock.module('@/components/ui/ContextUsageDisplay', () => ({ ContextUsageDisplay: empty }));
mock.module('@/components/session/ArchiveAllDropdown', () => ({ ArchiveAllDropdown: empty }));
mock.module('@/components/session/SessionsTabTitle', () => ({ SessionsTabTitle: empty }));
// The menu as its caller sees it: choosing an item closes it, then reports the close as complete.
type MenuState = { open: boolean; onOpenChange: (open: boolean) => void; onOpenChangeComplete?: (open: boolean) => void };
const Menu = React.createContext<MenuState | null>(null);
mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ onOpenChangeComplete, children }: { onOpenChangeComplete?: (open: boolean) => void; children: React.ReactNode }) => {
    const [open, onOpenChange] = React.useState(false);
    return <Menu.Provider value={{ open, onOpenChange, onOpenChangeComplete }}>{children}</Menu.Provider>;
  },
  DropdownMenuTrigger: ({ children }: { children: React.ReactElement<{ onClick?: () => void }> }) => {
    const menu = React.useContext(Menu);
    return React.cloneElement(children, { onClick: () => menu?.onOpenChange(!menu.open) });
  },
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (React.useContext(Menu)?.open ? <div role="menu">{children}</div> : null),
  DropdownMenuItem: ({ onClick, children }: { onClick?: () => void; children: React.ReactNode }) => {
    const menu = React.useContext(Menu);
    return <button type="button" role="menuitem" onClick={() => { onClick?.(); menu?.onOpenChange(false); menu?.onOpenChangeComplete?.(false); }}>{children}</button>;
  },
}));

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { VSCodeLayout } = await import('./VSCodeLayout');
const initialSessionUI = useSessionUIStore.getState();

let root: Root;
let host: HTMLElement;
let writes: Array<[string, string]>;
let failWrite: boolean;

const actionsButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="Open session actions"]');
const field = () => host.querySelector<HTMLInputElement>('[data-session-rename-form] input');
const headerTitle = () => host.querySelector('button[aria-label="Open session switcher"]')?.textContent;
const select = (id: string | null) => act(async () => useSessionUIStore.setState({ currentSessionId: id }));
async function openRename() {
  await act(async () => actionsButton()?.click());
  await act(async () => host.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click());
  const input = field();
  if (!input) throw new Error('Rename field did not open');
  return input;
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const press = (input: HTMLInputElement, key: string) => act(async () => {
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
});

beforeEach(async () => {
  sessions = [{ id: 'first', title: 'First chat' }, { id: 'second', title: 'Second chat' }];
  writes = [];
  failWrite = false;
  errors.length = 0;
  useSessionUIStore.setState({
    currentSessionId: 'first',
    updateSessionTitle: async (id, title) => {
      writes.push([id, title]);
      if (failWrite) throw new Error('server refused');
      sessions = sessions.map((session) => (session.id === id ? { ...session, title } : session));
    },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<I18nProvider><VSCodeLayout /></I18nProvider>));
});

afterEach(async () => {
  await act(async () => root.unmount());
  useSessionUIStore.setState(initialSessionUI);
  document.body.replaceChildren();
});

afterAll(async () => {
  homeSpy.mockRestore();
  await browser.happyDOM.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('Rename opens the title selected, saves the trimmed title on Enter, and needs a session', async () => {
  const input = await openRename();
  expect(input.value).toBe('First chat');
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'First chat'.length]);

  await type(input, '  Renamed chat  ');
  await press(input, 'Enter');
  expect(writes).toEqual([['first', 'Renamed chat']]);
  expect(field()).toBeNull();
  // The switcher trigger and the menu come back once the field closes.
  expect(headerTitle()).toBeDefined();
  expect(actionsButton()).not.toBeNull();

  await select(null);
  expect(actionsButton()).toBeNull();
});

test('Escape, an unchanged title and an empty title close the field without a write', async () => {
  let input = await openRename();
  await type(input, 'Not kept');
  await press(input, 'Escape');
  expect(field()).toBeNull();

  input = await openRename();
  await press(input, 'Enter');
  expect(field()).toBeNull();

  input = await openRename();
  await type(input, '   ');
  await press(input, 'Enter');
  expect(field()).toBeNull();
  expect(writes).toEqual([]);
});

test('a click outside saves to the session the field opened for; a session switch closes it unsaved', async () => {
  let input = await openRename();
  await type(input, 'Saved by click');
  await act(async () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  expect(writes).toEqual([['first', 'Saved by click']]);
  expect(field()).toBeNull();

  input = await openRename();
  await type(input, 'Typed for first');
  await select('second');
  expect(field()).toBeNull();
  expect(headerTitle()).toContain('Second chat');
  // Back on the first session the field stays closed, and nothing was written to either.
  await select('first');
  expect(field()).toBeNull();
  await act(async () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  expect(writes).toEqual([['first', 'Saved by click']]);
});

test('a failed write closes the field and says the rename failed', async () => {
  failWrite = true;
  const consoleError = spyOn(console, 'error').mockImplementation(noOp);
  const input = await openRename();
  await type(input, 'Refused title');
  await press(input, 'Enter');
  consoleError.mockRestore();
  expect(writes).toEqual([['first', 'Refused title']]);
  expect(field()).toBeNull();
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain('server refused');
});
