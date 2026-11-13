import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import { ensureChatsRootDirectory } from '@/lib/chatDirectories';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { buildSidebarSessionProjection } from '@/components/session/sidebar/list/sessionCollection';
import { useSessionUIStore } from './session-ui-store';
import * as runtimeTransport from '@/lib/runtime-fetch';
import { ChildStoreManager } from './child-store';
import { SessionMessageLoader, setImperativeSessionMessageLoader } from './session-message-loader';
import { setSyncRefs } from './sync-refs';

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

  test('reloads archived Chats and restores the root together with its subagent', async () => {
    const root = session('chat-root', `${chatsRoot}/day/session-a`);
    const child = { ...session('chat-child', root.directory), parentID: root.id };
    const records = new Map([[root.id, root], [child.id, child]]);
    const transcripts = new Map([root, child].map((entry) => [entry.id, {
      items: [{
        info: { id: `msg_${entry.id}`, sessionID: entry.id, role: 'user', time: { created: 1 } },
        parts: [{ id: `part_${entry.id}`, messageID: `msg_${entry.id}`, sessionID: entry.id, type: 'text', text: `Saved text for ${entry.id}` }],
      }], cursor: {},
    }]));
    const messages = spyOn(opencodeClient, 'getSessionMessages').mockImplementation(async (id, _options, directory) => {
      expect(directory).toBe(root.directory);
      expect(records.get(id)?.time.archived).toBeUndefined();
      return transcripts.get(id);
    });
    let children;
    let loader;
    const reloadTranscriptState = () => {
      loader?.dispose();
      children?.disposeAll();
      children = new ChildStoreManager();
      loader = new SessionMessageLoader(children, { sdk: opencodeClient, runtimeKey: getRuntimeKey() });
      setSyncRefs(null, children, chatsRoot);
      setImperativeSessionMessageLoader(loader);
    };
    const openTranscript = async (entry) => {
      useSessionUIStore.getState().setCurrentSession(entry.id, entry.directory);
      await loader.ensure({ sessionID: entry.id, directory: entry.directory });
      expect(useSessionUIStore.getState().currentSessionId).toBe(entry.id);
      const state = children.getState(entry.directory);
      return state.message[entry.id].flatMap((message) => state.part[message.id]).map((part) => part.text);
    };
    const transport = spyOn(runtimeTransport, 'runtimeFetch').mockImplementation(async (route, options) => {
      const body = JSON.parse(options.body);
      const archived = route.endsWith('/archive');
      for (const id of body.ids) {
        const record = records.get(id);
        records.set(id, { ...record, time: { ...record.time, archived: archived ? body.archivedAt : undefined } });
      }
      return Response.json({
        [archived ? 'archived' : 'restored']: body.ids.map((id) => ({ id, archivedAt: archived ? body.archivedAt : null })),
        failedIds: [],
      });
    });
    const list = spyOn(opencodeClient, 'listSessionsPage').mockImplementation(async () => ({ sessions: [...records.values()], cursor: {} }));
    spies.push(transport, list, messages);
    reloadTranscriptState();
    try {
      useGlobalSessionsStore.getState().upsertSessions([root, child]);
      expect(await openTranscript(root)).toEqual(['Saved text for chat-root']);
      expect(await openTranscript(child)).toEqual(['Saved text for chat-child']);
      expect(await useSessionUIStore.getState().archiveSessions([root.id, child.id])).toEqual({ archivedIds: [root.id, child.id], failedIds: [] });
      useSessionUIStore.getState().setCurrentSession(null);
      reloadTranscriptState();
      useGlobalSessionsStore.getState().resetForRuntimeSwitch();
      await useGlobalSessionsStore.getState().loadSessions();
      expect(useGlobalSessionsStore.getState().activeSessions).toEqual([]);
      expect(useGlobalSessionsStore.getState().archivedSessions.map((entry) => entry.id).sort()).toEqual([child.id, root.id]);
      expect(await useSessionUIStore.getState().unarchiveSession(root.id)).toBe(true);
      expect(useGlobalSessionsStore.getState().archivedSessions).toEqual([]);
      expect(useGlobalSessionsStore.getState().activeSessions.map((entry) => entry.id).sort()).toEqual([child.id, root.id]);
      expect(useGlobalSessionsStore.getState().entityById.get(root.id)?.directory).toBe(root.directory);
      expect(await openTranscript(root)).toEqual(['Saved text for chat-root']);
      expect(await openTranscript(child)).toEqual(['Saved text for chat-child']);
      expect(messages).toHaveBeenCalledTimes(4);
    } finally {
      setImperativeSessionMessageLoader(null);
      loader.dispose();
      children.disposeAll();
    }
  });
});
