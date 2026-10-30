import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { create } from 'zustand';
import { Window } from 'happy-dom';
import type { Session, TextPart } from '@/lib/opencode/model';
import { ChildStoreManager } from '@/sync/child-store';
import { SessionMessageLoader, setImperativeSessionMessageLoader } from '@/sync/session-message-loader';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { opencodeClient } from '@/lib/opencode/client';

const browser = new Window({ url: 'http://localhost' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: browser, document: browser.document, localStorage: browser.localStorage, navigator: browser.navigator, ResizeObserver: browser.ResizeObserver, IS_REACT_ACT_ENVIRONMENT: true })) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true });
}
const rootDirectory = '/home/user/.config/openchamber/chats';
const filesystemSpies = [
  spyOn(opencodeClient, 'getFilesystemHome').mockResolvedValue('/home/user'),
  spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home: '/home/user', chatsRoot: rootDirectory }),
  spyOn(opencodeClient, 'createDirectory').mockResolvedValue({ success: true, path: rootDirectory }),
];
Object.assign(window, {
  __VSCODE_CONFIG__: { workspaceFolder: '', workspaceFolders: [], viewMode: 'editor', initialSessionId: 'second' },
  __OPENCHAMBER_CONNECTION__: { status: 'connected' },
});
const empty = () => null;
const noOp = () => {};
const session = (id: string): Session => ({
  id, title: id, directory: `${rootDirectory}/day/${id}`, projectID: 'global', time: { created: 1, updated: 2 },
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});
const first = session('first');
const second = session('second');
const ui = create(() => ({ runOverviewKey: null, setRunOverviewKey: noOp }));
const projects = create(() => ({ projects: [], activeProjectId: null }));
const display = create(() => ({ showArchivedSessions: false, toggleArchivedSessions: noOp }));
const quota = create(() => ({ results: [], dropdownProviderIds: [], loadSettings: async () => {}, fetchAllQuotas: async () => {}, setDisplayMode: noOp }));
const runtime = { vscode: { executeCommand: async () => {} } };
mock.module('@/stores/useProjectsStore', () => ({ useProjectsStore: projects }));
mock.module('@/stores/useSessionDisplayStore', () => ({ useSessionDisplayStore: display }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: ui }));
mock.module('@/stores/useQuotaStore', () => ({ useQuotaStore: quota, useQuotaAutoRefresh: noOp }));
const { useConfigStore } = await import('@/stores/useConfigStore');
useConfigStore.setState({ isInitialized: true });
const activation = spyOn(useConfigStore.getState(), 'activateDirectory').mockResolvedValue(undefined);
const syncContext = await import('@/sync/sync-context');
mock.module('@/sync/sync-context', () => ({
  ...syncContext,
  useSessions: () => [],
  useDirectorySync: (selector: (state: { session: unknown[]; session_status: object }) => unknown) => selector({ session: [], session_status: {} }),
  useSessionMessages: () => [], useSessionMessagesResolved: () => true,
}));
mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => runtime }));
mock.module('@/hooks/useTerminalSessionKeepalive', () => ({ useTerminalSessionKeepalive: noOp }));
mock.module('@/hooks/useUpdatePolling', () => ({ useUpdatePolling: noOp }));
mock.module('@/hooks/useContextWindowLimits', () => ({ useContextWindowLimits: () => ({ context: 0, output: 0 }) }));
mock.module('@/components/chat/work-status/useSubagentCostRollup', () => ({ useSubagentCostRollup: () => ({ totalCost: 0 }) }));
mock.module('@/components/session/sidebar/list/useSessionListSync', () => ({ useSessionListSync: noOp }));
mock.module('@/components/ui', () => ({ toast: { success: noOp, error: noOp } }));
const { useSessionUIStore: sessionUI } = await import('@/sync/session-ui-store');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
useGlobalSessionsStore.setState({ activeSessions: [first, second], archivedSessions: [], entityById: new Map([[first.id, first], [second.id, second]]) });
const childStores = new ChildStoreManager();
const reads: Array<{ id: string; directory: string | null | undefined }> = [];
const loader = new SessionMessageLoader(childStores, {
  runtimeKey: getRuntimeKey(),
  sdk: { getSessionMessages: async (id, _options, directory) => {
    reads.push({ id, directory });
    return { items: [{ info: { id: `msg_${id}`, sessionID: id, role: 'user', time: { created: 1 } }, parts: [
      { id: `part_${id}`, sessionID: id, messageID: `msg_${id}`, type: 'text', text: `${id} Chat transcript` },
    ] }], cursor: {} };
  } },
});
setImperativeSessionMessageLoader(loader);
// Keep the layout test independent of composer/rendering controls, but read
// the transcript that the real selection action and loader materialized.
function Transcript() {
  const id = sessionUI((state) => state.currentSessionId);
  const directory = sessionUI((state) => state.currentSessionDirectory);
  const store = childStores.ensureChild(directory || rootDirectory, { bootstrap: false });
  const state = React.useSyncExternalStore(store.subscribe, store.getState);
  return <div>{(state.message[id || ''] ?? []).flatMap((message) => (state.part[message.id] ?? [])
    .filter((part): part is TextPart => part.type === 'text').map((part) => part.text)).join('')}</div>;
}
mock.module('@/components/views/ChatView', () => ({ ChatView: Transcript }));
mock.module('@/components/session/SessionSidebar', () => ({ SessionSidebar: empty }));
mock.module('@/components/session/SessionDialogs', () => ({ SessionDialogs: empty }));
mock.module('@/components/multirun/RunOverview', () => ({ RunOverview: empty }));
mock.module('@/lib/multirun/autoFusion', () => ({ RunAutoFusion: empty }));
mock.module('@/components/session/SessionSwitcherDropdown', () => ({ SessionSwitcherDropdown: empty }));
mock.module('@/components/mcp/McpDropdown', () => ({ McpDropdown: empty }));
mock.module('@/components/ui/ContextUsageDisplay', () => ({ ContextUsageDisplay: empty }));
mock.module('@/components/session/ArchiveAllDropdown', () => ({ ArchiveAllDropdown: empty }));
mock.module('@/components/session/SessionsTabTitle', () => ({ SessionsTabTitle: empty }));
mock.module('@/components/ui/ProviderLogo', () => ({ ProviderLogo: empty }));
mock.module('@/components/sections/usage/UsageProgressBar', () => ({ UsageProgressBar: empty }));
mock.module('@/components/ui/dropdown-menu', () => ({ DropdownMenu: empty, DropdownMenuContent: empty, DropdownMenuItem: empty, DropdownMenuLabel: empty, DropdownMenuSeparator: empty, DropdownMenuTrigger: empty }));

afterAll(async () => {
  activation.mockRestore();
  for (const spy of filesystemSpies) spy.mockRestore();
  setImperativeSessionMessageLoader(null);
  loader.dispose();
  childStores.disposeAll();
  await browser.happyDOM.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('a fresh editor selects the second Chat from the global index while the root directory store is empty', async () => {
  const { createRoot } = await import('react-dom/client');
  const { VSCodeLayout } = await import('./VSCodeLayout');
  const { I18nProvider } = await import('@/lib/i18n');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<I18nProvider><VSCodeLayout /></I18nProvider>));
    expect(sessionUI.getState()).toMatchObject({ currentSessionId: 'second', currentSessionDirectory: second.directory });
    expect(reads).toEqual([{ id: 'second', directory: second.directory }]);
    expect(host.textContent).toContain('second Chat transcript');
    expect(host.textContent).not.toContain('first Chat transcript');
  } finally {
    await act(async () => root.unmount());
  }
});
