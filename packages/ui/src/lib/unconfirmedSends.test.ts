import { beforeEach, describe, expect, test } from 'bun:test';

import type { ChatDraftIdentity } from './chatDraftPersistence';
import type { UnconfirmedSend, UnconfirmedSendServer } from './unconfirmedSends';
import { getSafeSessionStorage, getSafeStorage, listStorageKeys } from '@/stores/utils/safeStorage';

const heldLocks = new Set<string>();
const fakeLocks = {
  request: <T>(name: string, callback: () => T | Promise<T>): Promise<T> => {
    heldLocks.add(name);
    return Promise.resolve(callback()).finally(() => heldLocks.delete(name));
  },
  query: async () => ({ held: [...heldLocks].map((name) => ({ name })) }),
};
const withoutLocks: typeof import('./unconfirmedSends') = await import(`./unconfirmedSends?without-web-locks=${Date.now()}`);
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { ...globalThis.navigator, locks: fakeLocks } });
const {
  PREPARED_CHAT_FOLDER_KEY_PREFIX,
  UNCONFIRMED_SEND_KEY_PREFIX,
  draftRestoreTarget,
  recoverUnconfirmedSends,
  trackPreparedChatFolder,
  trackUnconfirmedSend,
} = await import('./unconfirmedSends');

const storage = getSafeStorage();
let runtimeCounter = 0;

const nextRuntime = () => `runtime-${runtimeCounter += 1}`;

const record = (runtimeKey: string, change: Partial<UnconfirmedSend> = {}): UnconfirmedSend => {
  const id = `dead-page-${runtimeCounter}-${Math.random()}`;
  return {
    id,
    pageId: 'dead-page',
    identity: { runtimeKey, directory: '/repo', sessionId: 'ses_existing' },
    text: 'the prompt',
    confirmedMentions: ['src/a.ts'],
    attachmentNames: [],
    sessionId: 'ses_existing',
    messageId: null,
    left: false,
    chatDirectory: null,
    textReturned: false,
    orphanSeen: false,
    ...change,
  };
};

const folderKeys = () => listStorageKeys(storage).filter((key) => key.startsWith(PREPARED_CHAT_FOLDER_KEY_PREFIX));
const folders = () => folderKeys().map((key) => JSON.parse(storage.getItem(key) ?? 'null'));
const keys = () => listStorageKeys(storage).filter((key) => key.startsWith(UNCONFIRMED_SEND_KEY_PREFIX));
const store = (...records: UnconfirmedSend[]) => {
  for (const entry of records) storage.setItem(`${UNCONFIRMED_SEND_KEY_PREFIX}${entry.id}`, JSON.stringify(entry));
};
const stored = (): UnconfirmedSend[] => keys().map((key) => JSON.parse(storage.getItem(key) ?? 'null'));

const fakeServer = (state: { sessions?: Record<string, string>; messages?: string[]; failing?: boolean; current?: () => boolean; usedDirectories?: string[]; usageUnknown?: boolean } = {}) => {
  const calls: string[] = [];
  const deleted: string[] = [];
  const server: UnconfirmedSendServer = {
    isCurrent: state.current ?? (() => true),
    ready: async () => { calls.push('ready'); },
    sessionDirectory: async (sessionId) => {
      calls.push(`session ${sessionId}`);
      if (state.failing) throw new Error('offline');
      return state.sessions?.[sessionId] ?? null;
    },
    hasMessage: async (sessionId, messageId) => {
      calls.push(`message ${sessionId} ${messageId}`);
      if (state.failing) throw new Error('offline');
      return state.messages?.includes(messageId) ?? false;
    },
    hasSessionsIn: async (directory) => {
      if (state.usageUnknown) throw new Error('offline');
      return state.usedDirectories?.includes(directory) ?? false;
    },
    deleteChatDirectory: async (directory) => { deleted.push(directory); },
  };
  return { server, calls, deleted };
};

const recoverInto = async (runtimeKey: string, server: UnconfirmedSendServer, shown: ChatDraftIdentity | null = null) => {
  const restored: Array<{ target: ChatDraftIdentity; text: string; mentions: string[] }> = [];
  const discarded: string[] = [];
  await recoverUnconfirmedSends(runtimeKey, {
    shown: () => shown,
    restore: (target, text, mentions) => restored.push({ target, text, mentions: [...mentions] }),
    discardDraft: (workDraftId) => discarded.push(workDraftId),
  }, server);
  return Object.assign(restored, { discarded });
};

describe('unconfirmedSends', () => {
  beforeEach(() => {
    for (const key of keys()) storage.removeItem(key);
    for (const key of folderKeys()) storage.removeItem(key);
  });

  test('a send whose request never left comes back to its session without asking the server', async () => {
    const runtime = nextRuntime();
    store(record(runtime));
    const { server, calls } = fakeServer();

    const restored = await recoverInto(runtime, server);

    expect([...restored]).toEqual([{ target: { runtimeKey: runtime, directory: '/repo', sessionId: 'ses_existing' }, text: 'the prompt', mentions: ['src/a.ts'] }]);
    expect(calls).toEqual([]);
  });

  test('a send the server has is dropped, so it cannot go out twice', async () => {
    const runtime = nextRuntime();
    store(record(runtime, { left: true, messageId: 'msg_1' }));
    const { server } = fakeServer({ messages: ['msg_1'] });

    expect([...await recoverInto(runtime, server)]).toEqual([]);
  });

  test('a request that left and never arrived comes back', async () => {
    const runtime = nextRuntime();
    store(record(runtime, { left: true, messageId: 'msg_1' }));
    const { server } = fakeServer({ messages: [] });

    expect((await recoverInto(runtime, server)).map((entry) => entry.text)).toEqual(['the prompt']);
  });

  test('a server that cannot answer keeps the record for the next start', async () => {
    const runtime = nextRuntime();
    const pending = record(runtime, { left: true, messageId: 'msg_1' });
    store(pending);
    const { server } = fakeServer({ failing: true });

    expect([...await recoverInto(runtime, server)]).toEqual([]);
    expect(stored()).toEqual([pending]);
  });

  test('an answer that arrives after a runtime switch restores and removes nothing', async () => {
    const runtime = nextRuntime();
    const pending = record(runtime, { left: true, messageId: 'msg_1' });
    store(pending);
    const { server } = fakeServer({ messages: [], current: () => false });

    expect([...await recoverInto(runtime, server)]).toEqual([]);
    expect(stored()).toEqual([pending]);
  });

  test('a command that left has no id to confirm and is dropped', async () => {
    const runtime = nextRuntime();
    store(record(runtime, { left: true, text: '/review' }));
    const { server } = fakeServer();

    expect([...await recoverInto(runtime, server)]).toEqual([]);
  });

  test('a first send whose session was never created goes back to the draft', async () => {
    const runtime = nextRuntime();
    const draft = { runtimeKey: runtime, directory: '__chat__', sessionId: null };
    store(record(runtime, { identity: draft, sessionId: 'ses_minted' }));
    const { server } = fakeServer();

    expect((await recoverInto(runtime, server)).map((entry) => entry.target)).toEqual([draft]);
  });

  test('a project draft that was never created comes back in the draft now open in its folder', async () => {
    const runtime = nextRuntime();
    store(record(runtime, { identity: { runtimeKey: runtime, directory: '/repo', sessionId: 'draft:old' }, sessionId: null }));
    const shown = { runtimeKey: runtime, directory: '/repo', sessionId: 'draft:new' };

    const restored = await recoverInto(runtime, fakeServer().server, shown);

    expect(restored.map((entry) => entry.target)).toEqual([shown]);
    expect(restored.discarded).toEqual(['old']);
  });

  test('a first send whose session exists goes to that session', async () => {
    const runtime = nextRuntime();
    store(record(runtime, { identity: { runtimeKey: runtime, directory: '/repo', sessionId: 'draft:7' }, sessionId: 'ses_minted', left: true, messageId: 'msg_1' }));
    const { server, calls } = fakeServer({ sessions: { ses_minted: '/repo/sub' } });

    expect((await recoverInto(runtime, server)).map((entry) => entry.target)).toEqual([{ runtimeKey: runtime, directory: '/repo/sub', sessionId: 'ses_minted' }]);
    expect(calls).toEqual(['ready', 'session ses_minted', 'message ses_minted msg_1']);
  });

  test('another runtime and this page\'s own sends are left alone', async () => {
    const runtime = nextRuntime();
    const foreign = record('runtime-other');
    store(foreign);
    const own = trackUnconfirmedSend({
      identity: { runtimeKey: runtime, directory: '/repo', sessionId: 'ses_existing' },
      text: 'in flight here',
      confirmedMentions: [],
      attachmentNames: [],
    });

    expect([...await recoverInto(runtime, fakeServer().server)]).toEqual([]);
    expect(stored().map((entry) => entry.text).sort()).toEqual(['in flight here', 'the prompt']);

    own.progress.messageMinted('msg_9');
    own.progress.requestLeaving();
    expect(stored().find((entry) => entry.text === 'in flight here')).toMatchObject({ messageId: 'msg_9', left: true });
    own.settle();
    expect(stored()).toEqual([foreign]);
  });

  test('a share link\'s key is never stored', () => {
    const own = trackUnconfirmedSend({
      identity: { runtimeKey: nextRuntime(), directory: '/repo', sessionId: 'ses_existing' },
      text: 'see https://evil.test/p/AbCdEfGhIjKlMnOpQrStUv#Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmE now',
      confirmedMentions: [],
      attachmentNames: [],
    });
    expect(stored()[0]?.text).toBe('see https://evil.test/p/AbCdEfGhIjKlMnOpQrStUv now');
    own.settle();
  });

  test('a project draft target falls back to its folder when the open composer is elsewhere', () => {
    const target = { runtimeKey: 'r', directory: '/repo', sessionId: 'draft:old' };
    expect(draftRestoreTarget(target, { runtimeKey: 'r', directory: '/other', sessionId: 'draft:new' })).toEqual({ ...target, sessionId: null });
    expect(draftRestoreTarget({ ...target, sessionId: 'ses_1' }, null)).toEqual({ ...target, sessionId: 'ses_1' });
  });
  describe('the chat folder a first send left behind', () => {
    const chatDraft = (runtime: string) => ({ runtimeKey: runtime, directory: '__chat__', sessionId: null });
    const folder = '/chats/2026-11-16/session-a';
    const orphan = (runtime: string) => record(runtime, { identity: chatDraft(runtime), sessionId: 'ses_minted', chatDirectory: folder });
    const nextStart = async (server: UnconfirmedSendServer) => {
      const runtime = nextRuntime();
      for (const entry of stored()) store({ ...entry, pageId: 'dead-page', identity: { ...entry.identity, runtimeKey: runtime } });
      return recoverInto(runtime, server);
    };

    test('is removed on the start after the one that found its session missing', async () => {
      const runtime = nextRuntime();
      store(orphan(runtime));
      const { server, deleted } = fakeServer();

      expect((await recoverInto(runtime, server)).map((entry) => entry.target)).toEqual([chatDraft(runtime)]);
      expect(deleted).toEqual([]);
      expect(stored()).toMatchObject([{ textReturned: true, orphanSeen: true }]);

      expect([...await nextStart(server)]).toEqual([]);
      expect(deleted).toEqual([folder]);
      expect(stored()).toEqual([]);
    });

    test('belongs to the page that found it, so another client starting meanwhile leaves it', async () => {
      const runtime = nextRuntime();
      store(orphan(runtime));
      await recoverInto(runtime, fakeServer().server);
      const [marked] = stored();
      expect(marked?.pageId).not.toBe('dead-page');
      const other = nextRuntime();
      store({ ...marked!, identity: { ...marked!.identity, runtimeKey: other } });
      const { server, deleted } = fakeServer();

      expect([...await recoverInto(other, server)]).toEqual([]);
      expect(deleted).toEqual([]);
    });

    test('stays when its session was created after the first look', async () => {
      const runtime = nextRuntime();
      store(orphan(runtime));
      await recoverInto(runtime, fakeServer().server);
      const { server, deleted } = fakeServer({ sessions: { ses_minted: folder } });

      expect([...await nextStart(server)]).toEqual([]);
      expect(deleted).toEqual([]);
      expect(stored()).toEqual([]);
    });

    test('stays when the session was created', async () => {
      const runtime = nextRuntime();
      store(orphan(runtime));
      const { server, deleted } = fakeServer({ sessions: { ses_minted: folder } });

      await recoverInto(runtime, server);
      await nextStart(server);
      expect(deleted).toEqual([]);
    });

    test('stays when another client has a session in it', async () => {
      const runtime = nextRuntime();
      store(orphan(runtime));
      const { server, deleted } = fakeServer({ usedDirectories: [folder] });

      await recoverInto(runtime, server);
      await nextStart(server);
      expect(deleted).toEqual([]);
      expect(stored()).toEqual([]);
    });

    test('stays, and is tried again, when the sessions it may hold cannot be read', async () => {
      const runtime = nextRuntime();
      store(orphan(runtime));
      const { server, deleted } = fakeServer({ usageUnknown: true });

      expect((await recoverInto(runtime, server)).map((entry) => entry.text)).toEqual(['the prompt']);
      expect([...await nextStart(server)]).toEqual([]);
      expect(deleted).toEqual([]);
      expect(stored()).toMatchObject([{ orphanSeen: true }]);
    });

    test('stays while the page that is sending it is alive', async () => {
      const runtime = nextRuntime();
      const own = trackUnconfirmedSend({ identity: chatDraft(runtime), text: 'sending now', confirmedMentions: [], attachmentNames: [] });
      own.progress.sessionMinted('ses_minted', folder);
      const { server, deleted } = fakeServer();

      expect([...await recoverInto(runtime, server)]).toEqual([]);
      expect(deleted).toEqual([]);
      own.settle();
    });

    test('stays after a runtime switch', async () => {
      const runtime = nextRuntime();
      store({ ...orphan(runtime), orphanSeen: true, textReturned: true });
      const { server, deleted } = fakeServer({ current: () => false });

      await recoverInto(runtime, server);
      expect(deleted).toEqual([]);
      expect(stored()).toHaveLength(1);
    });

    test('a send that failed live before its session existed keeps only the folder to remove', async () => {
      const runtime = nextRuntime();
      const own = trackUnconfirmedSend({ identity: chatDraft(runtime), text: 'failed live', confirmedMentions: [], attachmentNames: [] });
      own.progress.sessionMinted('ses_minted', folder);
      own.settle();
      const kept = stored();
      expect(kept).toMatchObject([{ textReturned: true, chatDirectory: folder }]);
      store({ ...kept[0]!, pageId: 'dead-page' });
      const { server, deleted } = fakeServer();

      expect([...await recoverInto(runtime, server)]).toEqual([]);
      expect([...await nextStart(server)]).toEqual([]);
      expect(deleted).toEqual([folder]);
      expect(stored()).toEqual([]);
    });

    test('a send whose request left settles without a trace', () => {
      const own = trackUnconfirmedSend({ identity: chatDraft(nextRuntime()), text: 'sent', confirmedMentions: [], attachmentNames: [] });
      own.progress.sessionMinted('ses_minted', folder);
      own.progress.requestLeaving();
      own.settle();
      expect(stored()).toEqual([]);
    });

    test('a failed send whose session turned out to exist keeps its folder', async () => {
      const runtime = nextRuntime();
      store({ ...orphan(runtime), textReturned: true });
      const { server, deleted } = fakeServer({ sessions: { ses_minted: folder } });

      expect([...await recoverInto(runtime, server)]).toEqual([]);
      expect(deleted).toEqual([]);
      expect(stored()).toEqual([]);
    });

    test('a record written before the folder was tracked still comes back', async () => {
      const runtime = nextRuntime();
      const { chatDirectory: _omitted, textReturned: _alsoOmitted, orphanSeen: _neither, ...older } = record(runtime);
      storage.setItem(`${UNCONFIRMED_SEND_KEY_PREFIX}older`, JSON.stringify(older));

      expect((await recoverInto(runtime, fakeServer().server)).map((entry) => entry.text)).toEqual(['the prompt']);
    });
  });
  describe('the folder an unsent Chat draft prepared', () => {
    const folder = '/chats/2026-11-16/session-draft';
    const deadFolder = (runtime: string, seen = false) => storage.setItem(
      `${PREPARED_CHAT_FOLDER_KEY_PREFIX}dead-${runtime}`,
      JSON.stringify({ id: `dead-${runtime}`, pageId: 'dead-page', runtimeKey: runtime, directory: folder, seen }),
    );

    test('of a dead page is marked on the first start and removed on the next one', async () => {
      const runtime = nextRuntime();
      deadFolder(runtime);
      const { server, deleted } = fakeServer();

      await recoverInto(runtime, server);
      expect(deleted).toEqual([]);
      expect(folders()).toMatchObject([{ seen: true, directory: folder }]);
      expect(folders()[0].pageId).not.toBe('dead-page');

      const next = nextRuntime();
      for (const entry of folders()) storage.setItem(`${PREPARED_CHAT_FOLDER_KEY_PREFIX}${entry.id}`, JSON.stringify({ ...entry, pageId: 'dead-page', runtimeKey: next }));
      await recoverInto(next, server);
      expect(deleted).toEqual([folder]);
      expect(folders()).toEqual([]);
    });

    test('of the live draft on this page is never touched', async () => {
      const runtime = nextRuntime();
      trackPreparedChatFolder(runtime, folder);
      const { server, deleted } = fakeServer();

      await recoverInto(runtime, server);
      expect(deleted).toEqual([]);
      expect(folders()).toMatchObject([{ seen: false, directory: folder }]);
    });

    test('of another open window is never touched', async () => {
      const runtime = nextRuntime();
      heldLocks.add('openchamber.page.other-window');
      storage.setItem(`${PREPARED_CHAT_FOLDER_KEY_PREFIX}other`, JSON.stringify({ id: 'other', pageId: 'other-window', runtimeKey: runtime, directory: folder, seen: true }));
      const { server, deleted } = fakeServer();

      await recoverInto(runtime, server);
      heldLocks.delete('openchamber.page.other-window');
      expect(deleted).toEqual([]);
      expect(folders()).toMatchObject([{ pageId: 'other-window', seen: true }]);
    });

    test('that a session now lives in stays and its record goes', async () => {
      const runtime = nextRuntime();
      deadFolder(runtime, true);
      const { server, deleted } = fakeServer({ usedDirectories: [folder] });

      await recoverInto(runtime, server);
      expect(deleted).toEqual([]);
      expect(folders()).toEqual([]);
    });

    test('stays, with its record, when the sessions cannot be read or the runtime changed', async () => {
      const runtime = nextRuntime();
      deadFolder(runtime, true);
      await recoverInto(runtime, fakeServer({ usageUnknown: true }).server);
      const other = nextRuntime();
      deadFolder(other, true);
      const { server, deleted } = fakeServer({ current: () => false });
      await recoverInto(other, server);

      expect(deleted).toEqual([]);
      expect(folders()).toHaveLength(2);
    });

    test('of another runtime is left alone', async () => {
      const runtime = nextRuntime();
      deadFolder('runtime-other', true);
      const { server, deleted } = fakeServer();

      await recoverInto(runtime, server);
      expect(deleted).toEqual([]);
      expect(folders()).toHaveLength(1);
    });
  });
  test('a folder a send record still holds waits for that record', async () => {
    const runtime = nextRuntime();
    const directory = '/chats/2026-11-16/session-shared';
    store(record(runtime, { identity: { runtimeKey: runtime, directory: '__chat__', sessionId: null }, sessionId: 'ses_minted', chatDirectory: directory, orphanSeen: false }));
    storage.setItem(`${PREPARED_CHAT_FOLDER_KEY_PREFIX}shared`, JSON.stringify({ id: 'shared', pageId: 'dead-page', runtimeKey: runtime, directory, seen: true }));
    const { server, deleted } = fakeServer();

    await recoverInto(runtime, server);
    expect(deleted).toEqual([]);
    expect(folders()).toMatchObject([{ seen: true, pageId: 'dead-page' }]);
  });

  describe('without Web Locks', () => {
    const tabStorage = getSafeSessionStorage();
    const tabKeys = () => listStorageKeys(tabStorage).filter((key) => key.startsWith(UNCONFIRMED_SEND_KEY_PREFIX) || key.startsWith(PREPARED_CHAT_FOLDER_KEY_PREFIX));

    test('no prepared folder is recorded and no folder is ever deleted', async () => {
      const runtime = nextRuntime();
      withoutLocks.trackPreparedChatFolder(runtime, '/chats/2026-11-16/session-tab');
      expect(tabKeys()).toEqual([]);
      const directory = '/chats/2026-11-16/session-copied';
      tabStorage.setItem(`${UNCONFIRMED_SEND_KEY_PREFIX}copied`, JSON.stringify(record(runtime, { id: 'copied', identity: { runtimeKey: runtime, directory: '__chat__', sessionId: null }, sessionId: 'ses_minted', chatDirectory: directory, textReturned: true, orphanSeen: true })));
      const { server, deleted } = fakeServer();

      await withoutLocks.recoverUnconfirmedSends(runtime, { shown: () => null, restore: () => undefined, discardDraft: () => undefined }, server);
      expect(deleted).toEqual([]);
      expect(tabKeys()).toEqual([]);
    });
  });
});
