import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import { ensureChatsRootDirectory } from '@/lib/chatDirectories';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { buildSidebarSessionProjection } from '@/components/session/sidebar/list/sessionCollection';
import { useSessionUIStore } from './session-ui-store';

const originalWindow = globalThis.window;
const home = '/home/test';
const chatsRoot = `${home}/.config/openchamber/chats`;
const session = (id, directory) => ({
  id, directory, projectID: 'global', title: id, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
});
let runtime = 0;
let spies = [];
const workspace = (paths) => {
  globalThis.window.__VSCODE_CONFIG__ = {
    workspaceFolder: paths[0] ?? '',
    workspaceFolders: paths.map((path) => ({ name: path, path })),
  };
  useProjectsStore.getState().syncVSCodeWorkspaceFolders(globalThis.window.__VSCODE_CONFIG__.workspaceFolders);
};

beforeEach(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
    __VSCODE_CONFIG__: { workspaceFolder: '', workspaceFolders: [] },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  } });
  switchRuntimeEndpoint({ apiBaseUrl: 'https://vscode-chats.test', runtimeKey: `vscode-chats-${++runtime}` });
  spies = [
    spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home, chatsRoot }),
    spyOn(useConfigStore.getState(), 'activateDirectory').mockResolvedValue(undefined),
  ];
  await ensureChatsRootDirectory();
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  workspace([]);
  useDirectoryStore.setState({ currentDirectory: '/old/project', homeDirectory: home, isHomeReady: true });
});
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});
afterAll(() => {
  if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
  else globalThis.window = originalWindow;
});

describe('VS Code without a workspace', () => {
  test('opens a Chat despite the previous directory and prepares separate directories for separate drafts', async () => {
    const mkdir = spyOn(opencodeClient, 'createDirectory').mockResolvedValue({ success: true });
    spies.push(mkdir);
    useSessionUIStore.getState().openNewSessionDraft();
    expect(useSessionUIStore.getState().newSessionDraft).toMatchObject({ target: 'chat', selectedProjectId: null, directoryOverride: null });
    const first = await useSessionUIStore.getState().prepareChatDraftDirectory();
    expect(first.startsWith(`${chatsRoot}/`)).toBe(true);
    expect(await useSessionUIStore.getState().prepareChatDraftDirectory()).toBe(first);
    useSessionUIStore.getState().openNewSessionDraft();
    const second = await useSessionUIStore.getState().prepareChatDraftDirectory();
    expect(second).not.toBe(first);
    expect(mkdir.mock.calls.map(([path]) => path)).toEqual([first, second]);
  });

  test('keeps a failed directory preparation retryable', async () => {
    const mkdir = spyOn(opencodeClient, 'createDirectory').mockRejectedValueOnce(new Error('read-only')).mockResolvedValue({ success: true });
    spies.push(mkdir);
    useSessionUIStore.getState().openNewSessionDraft();
    await expect(useSessionUIStore.getState().prepareChatDraftDirectory()).rejects.toThrow('read-only');
    expect(useSessionUIStore.getState().newSessionDraft.preparedChatDirectory).toBeNull();
    expect(await useSessionUIStore.getState().prepareChatDraftDirectory()).toStartWith(`${chatsRoot}/`);
  });

  test('retains live Chats and reloads them into the sidebar without admitting unrelated projects', async () => {
    const chat = session('chat', `${chatsRoot}/day/session-a`);
    useGlobalSessionsStore.getState().upsertSession(chat);
    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([chat]);
    const list = spyOn(opencodeClient, 'listSessionsPage').mockResolvedValue({ sessions: [chat, session('other', '/other/project')], cursor: {} });
    spies.push(list);
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    await useGlobalSessionsStore.getState().loadSessions();
    const projection = buildSidebarSessionProjection({
      globalActiveSessions: useGlobalSessionsStore.getState().activeSessions,
      liveSessions: [], knownDirectories: new Set(), isVSCode: true,
      pinnedSessionIds: new Set(), sessionOrderRanks: new Map(),
    });
    expect(projection.chatSessions.map((entry) => entry.id)).toEqual(['chat']);
    expect(projection.projectSessions).toEqual([]);
  });

  test('workspace windows keep project drafts and exclude Chats', async () => {
    workspace(['/work/project']);
    useDirectoryStore.setState({ currentDirectory: '/work/project' });
    useSessionUIStore.getState().openNewSessionDraft();
    expect(useSessionUIStore.getState().newSessionDraft).toMatchObject({ target: 'project', directoryOverride: '/work/project' });
    const chat = session('chat', `${chatsRoot}/day/session-a`);
    useGlobalSessionsStore.getState().upsertSession(chat);
    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([]);
    const list = spyOn(opencodeClient, 'listSessionsPage').mockResolvedValue({ sessions: [chat], cursor: {} });
    spies.push(list);
    await useGlobalSessionsStore.getState().loadSessions();
    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([]);
  });
});
