import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Message, Part, Session } from '@opencode-ai/sdk/v2';

let forkSessionImpl: (sessionId: string, messageId?: string, directory?: string | null) => Promise<Session>;
let sendMessageImpl: (...args: unknown[]) => Promise<unknown>;
let deleteSessionImpl: (sessionId: string) => Promise<boolean>;
let updateSessionTitleImpl: (sessionId: string, title: string) => Promise<void>;
const registeredDirectories: string[] = [];
const upsertedSessions: unknown[] = [];
const childStoreSessions: Session[] = [];

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    forkSession: (sessionId: string, messageId?: string, directory?: string | null) =>
      forkSessionImpl(sessionId, messageId, directory),
  },
}));
mock.module('@/sync/session-actions', () => ({
  waitForConnectionOrThrow: () => Promise.resolve(),
  deleteSession: (sessionId: string) => deleteSessionImpl(sessionId),
  updateSessionTitle: (sessionId: string, title: string) => updateSessionTitleImpl(sessionId, title),
}));
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: { getState: () => ({ sendMessage: (...args: unknown[]) => sendMessageImpl(...args) }) },
}));
mock.module('@/stores/useGlobalSessionsStore', () => ({
  useGlobalSessionsStore: { getState: () => ({ upsertSession: (session: unknown) => { upsertedSessions.push(session); } }) },
}));
mock.module('@/sync/sync-refs', () => ({
  registerSessionDirectory: (sessionId: string, directory: string) => { registeredDirectories.push(`${sessionId}:${directory}`); },
  getSyncChildStores: () => ({
    children: new Map([['/project', {
      getState: () => ({ session: childStoreSessions }),
      setState: (patch: { session: Session[] }) => { childStoreSessions.length = 0; childStoreSessions.push(...patch.session); },
    }]]),
  }),
}));

const { btwSessionTitle, startBtwSession, destroyBtwSession, closeBtwPanel, filterBtwTailMessages } =
  await import('@/lib/btw');
const { useBtwStore } = await import('@/stores/useBtwStore');

const makeSession = (id: string, directory?: string, created = Date.now()): Session => ({
  id,
  directory,
  title: `btw: q`,
  time: { created, updated: created },
  parentID: undefined,
  version: 1,
}) as unknown as Session;

const record = (id: string, created: number): { info: Message; parts: Part[] } => ({
  info: { id, role: 'user', time: { created, updated: created } } as unknown as Message,
  parts: [],
});

describe('btwSessionTitle', () => {
  test('prefixes the question', () => {
    expect(btwSessionTitle('wtf is kafka')).toBe('btw: wtf is kafka');
  });
});

describe('startBtwSession', () => {
  beforeEach(() => {
    registeredDirectories.length = 0;
    upsertedSessions.length = 0;
    childStoreSessions.length = 0;
    useBtwStore.getState().closeBtw();
    forkSessionImpl = () => Promise.reject(new Error('no forkSession stub'));
    sendMessageImpl = () => Promise.resolve();
    deleteSessionImpl = () => Promise.resolve(true);
    updateSessionTitleImpl = () => Promise.resolve();
  });

  test('forks the parent (full copy) and routes the question to the fork', async () => {
    let forkedParent: string | null = null;
    let forkedMessageId: string | undefined = 'sentinel';
    let forkedDirectory: string | null | undefined = null;
    const forkCreated = Date.now();
    forkSessionImpl = (sessionId, messageId, directory) => {
      forkedParent = sessionId;
      forkedMessageId = messageId;
      forkedDirectory = directory;
      return Promise.resolve(makeSession('fork-1', directory ?? '/project', forkCreated));
    };

    let sentOptions: unknown = null;
    let sentText: unknown = null;
    sendMessageImpl = (...args) => {
      sentText = args[0];
      sentOptions = args[9];
      return Promise.resolve();
    };

    const session = await startBtwSession({
      parentSessionId: 'parent-1',
      question: 'wtf is kafka',
      directory: '/project',
      providerID: 'provider',
      modelID: 'model',
      agent: 'build',
      variant: 'v',
    });

    expect(session?.id).toBe('fork-1');
    expect(forkedParent).toBe('parent-1');
    expect(forkedMessageId).toBe(undefined);
    expect(forkedDirectory).toBe('/project');
    expect(registeredDirectories).toEqual(['fork-1:/project']);
    expect(upsertedSessions).toHaveLength(1);
    expect(childStoreSessions.map((s) => s.id)).toEqual(['fork-1']);
    expect(sentText).toBe('wtf is kafka');
    expect(sentOptions).toEqual({ sessionId: 'fork-1', directory: '/project' });
    expect(useBtwStore.getState().panel).toEqual({
      sessionId: 'fork-1',
      directory: '/project',
      title: 'btw: wtf is kafka',
      forkedAtMs: forkCreated,
    });
  });

  test('renames the fork to the btw title (best-effort)', async () => {
    forkSessionImpl = () => Promise.resolve(makeSession('fork-1', '/project', 100));
    const renamed: Array<[string, string]> = [];
    updateSessionTitleImpl = (sessionId, title) => {
      renamed.push([sessionId, title]);
      return Promise.resolve();
    };
    await startBtwSession({
      parentSessionId: 'parent-1',
      question: 'q',
      directory: '/project',
      providerID: 'provider',
      modelID: 'model',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(renamed).toEqual([['fork-1', 'btw: q']]);
  });

  test('a failed rename does not fail the btw flow', async () => {
    forkSessionImpl = () => Promise.resolve(makeSession('fork-1', '/project', 100));
    updateSessionTitleImpl = () => Promise.reject(new Error('rename failed'));
    const session = await startBtwSession({
      parentSessionId: 'parent-1',
      question: 'q',
      directory: '/project',
      providerID: 'provider',
      modelID: 'model',
    });
    expect(session?.id).toBe('fork-1');
  });

  test('uses the server-canonicalized directory for routing and registration', async () => {
    forkSessionImpl = () => Promise.resolve(makeSession('fork-1', '/canonical/project', 100));

    let sentOptions: unknown = null;
    sendMessageImpl = (...args) => {
      sentOptions = args[9];
      return Promise.resolve();
    };

    await startBtwSession({
      parentSessionId: 'parent-1',
      question: 'q',
      directory: '/requested/project',
      providerID: 'provider',
      modelID: 'model',
    });

    expect(registeredDirectories).toEqual(['fork-1:/canonical/project']);
    expect(sentOptions).toEqual({ sessionId: 'fork-1', directory: '/canonical/project' });
  });

  test('propagates a failed send so the caller can surface it', async () => {
    forkSessionImpl = () => Promise.resolve(makeSession('fork-1', '/project', 100));
    sendMessageImpl = () => Promise.reject(new Error('send failed'));

    await expect(
      startBtwSession({
        parentSessionId: 'parent-1',
        question: 'q',
        directory: '/project',
        providerID: 'provider',
        modelID: 'model',
      }),
    ).rejects.toThrow('send failed');
  });
});

describe('filterBtwTailMessages', () => {
  const forkAt = 1000;

  test('keeps only messages created at or after the fork boundary', () => {
    const records = [
      record('inherited-1', 100),
      record('inherited-2', 500),
      record('question', 1010),
      record('answer', 1500),
    ];
    expect(filterBtwTailMessages(records, forkAt).map((r) => r.info.id)).toEqual(['question', 'answer']);
  });

  test('includes a message exactly at the boundary', () => {
    const records = [record('edge', forkAt), record('old', 999)];
    expect(filterBtwTailMessages(records, forkAt).map((r) => r.info.id)).toEqual(['edge']);
  });

  test('returns an empty tail when everything predates the fork', () => {
    const records = [record('old-1', 10), record('old-2', 900)];
    expect(filterBtwTailMessages(records, forkAt)).toEqual([]);
  });
});

describe('destroyBtwSession', () => {
  test('deletes the session and reports success', async () => {
    let deleted: string | null = null;
    deleteSessionImpl = (sessionId) => {
      deleted = sessionId;
      return Promise.resolve(true);
    };
    expect(await destroyBtwSession('fork-1')).toBe(true);
    expect(deleted).toBe('fork-1');
  });

  test('reports failure when the delete fails', async () => {
    deleteSessionImpl = () => Promise.resolve(false);
    expect(await destroyBtwSession('fork-1')).toBe(false);
  });
});

describe('closeBtwPanel', () => {
  test('closes the panel and destroys the open fork', async () => {
    useBtwStore.getState().openBtw('fork-1', '/project', 'btw: q', 100);
    let deleted: string | null = null;
    deleteSessionImpl = (sessionId) => {
      deleted = sessionId;
      return Promise.resolve(true);
    };
    closeBtwPanel();
    expect(useBtwStore.getState().panel.sessionId).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deleted).toBe('fork-1');
  });

  test('does nothing when no panel is open', async () => {
    let deleteCalled = false;
    deleteSessionImpl = () => {
      deleteCalled = true;
      return Promise.resolve(true);
    };
    closeBtwPanel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deleteCalled).toBe(false);
  });

  test('invokes onDestroyFailed when the delete fails', async () => {
    useBtwStore.getState().openBtw('fork-1', '/project', 'btw: q', 100);
    deleteSessionImpl = () => Promise.resolve(false);
    let notified = false;
    closeBtwPanel(() => { notified = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notified).toBe(true);
  });
});
