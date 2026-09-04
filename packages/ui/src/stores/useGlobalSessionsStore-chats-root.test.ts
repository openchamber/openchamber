import { describe, expect, mock, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

const relocatedRoot = '/srv/openchamber-chats';
const serverChatsRoot: string | null = relocatedRoot;

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getFilesystemChatsRoot: mock(async () => serverChatsRoot),
    getFilesystemHome: mock(async () => '/home/user'),
    setDirectory: mock(() => {}),
  },
}));

class TestStorage implements Storage {
  readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new TestStorage() });

const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
switchRuntimeEndpoint({ apiBaseUrl: 'https://chats-root.test', runtimeKey: 'runtime-chats-root' });

const relocatedChat: Session = {
  id: 'ses_relocated',
  projectID: 'openchamber:chats',
  directory: `${relocatedRoot}/2026-08-21/session-a`,
  title: 'Relocated chat',
  version: '1',
  time: { created: 1, updated: 2 },
} as Session;

// persistSessions writes the managed-chats scope without the chat-path
// filter, modeling a snapshot written by a previous warm session.
const { persistSessions, readManagedChatSessions } = await import('@/sync/persist-cache');
persistSessions('openchamber:managed-chats', [relocatedChat]);
await new Promise((resolve) => setTimeout(resolve, 70));

const { warmChatsRootDirectory } = await import('@/lib/chatDirectories');
type GlobalSessionsStoreModule = typeof import('./useGlobalSessionsStore');
const storeModule: GlobalSessionsStoreModule = await import(`./useGlobalSessionsStore?chats-root-test=${Date.now()}`);
const { useGlobalSessionsStore } = storeModule;

describe('useGlobalSessionsStore chats-root rehydrate', () => {
  test('cold seed drops relocated chats; rehydrate recovers them once the root is warm', async () => {
    expect(readManagedChatSessions()).toEqual([]);
    expect(useGlobalSessionsStore.getState().activeSessions.map((session) => session.id)).toEqual([]);

    await warmChatsRootDirectory();
    useGlobalSessionsStore.getState().rehydrateManagedChatSessions();

    const state = useGlobalSessionsStore.getState();
    expect(state.activeSessions.map((session) => session.id)).toEqual([relocatedChat.id]);
    expect(state.sessionsByDirectory.get(relocatedChat.directory)?.[0]?.id).toBe(relocatedChat.id);
    expect(state.status).toBe('idle');
    expect(state.hasLoaded).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(readManagedChatSessions().map((session) => session.id)).toEqual([relocatedChat.id]);
  });

  test('rehydrate does not replace state after a load has landed', async () => {
    useGlobalSessionsStore.setState({ status: 'ready', hasLoaded: true });
    useGlobalSessionsStore.getState().rehydrateManagedChatSessions();

    expect(useGlobalSessionsStore.getState().activeSessions.map((session) => session.id)).toEqual([relocatedChat.id]);
    expect(useGlobalSessionsStore.getState().status).toBe('ready');
  });
});
