import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Message, Part, Session } from '@/lib/opencode/model';
import type { MessagePage } from '@/lib/opencode/client';
import type { StartBtwInput } from './btw';
import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeKey } from '@/lib/runtime-switch';

type ForkOptions = { before?: string; directory?: string | null };
// Stands in for the 404 OpenCode answers when a fork's `before` names a record it does not hold.
const forkBeforeNotFound = new Error('session.fork failed (404): message not found');
let forkSessionImpl: (sessionId: string, options?: ForkOptions) => Promise<Session>;
let getSessionMessagesImpl: (id: string, options?: { limit?: number }, directory?: string | null) => Promise<MessagePage>;
let sendMessageImpl: (...args: unknown[]) => Promise<unknown>;
let deleteSessionImpl: (sessionId: string) => Promise<boolean>;
let updateSessionTitleImpl: (sessionId: string, title: string) => Promise<void>;
let patchSessionMetadataImpl: (
  sessionId: string,
  directory: string | null | undefined,
  updater: (metadata: Record<string, unknown>) => Record<string, unknown>,
) => Promise<Session>;
const registeredDirectories: string[] = [];
const upsertedSessions: unknown[] = [];
const childStoreSessions: Session[] = [];
const currentSessionSwitches: string[] = [];
const metadataPatches: Array<{ sessionId: string; result: Record<string, unknown> }> = [];
const parentSyncMessages: Message[] = [];
const sessionMessageReads: string[] = [];

mock.module('@/lib/opencode/client', () => ({
  isOpencodeNotFound: (error: Error) => error === forkBeforeNotFound,
  opencodeClient: {
    forkSession: (sessionId: string, options?: ForkOptions) => forkSessionImpl(sessionId, options),
    getSessionMessages: (id: string, options?: { limit?: number }, directory?: string | null) => {
      sessionMessageReads.push(id);
      return getSessionMessagesImpl(id, options, directory);
    },
  },
}));
mock.module('@/sync/session-actions', () => ({
  waitForConnectionOrThrow: () => Promise.resolve(),
  deleteSession: (sessionId: string) => deleteSessionImpl(sessionId),
  updateSessionTitle: (sessionId: string, title: string) => updateSessionTitleImpl(sessionId, title),
  patchSessionMetadata: (
    sessionId: string,
    directory: string | null | undefined,
    updater: (metadata: Record<string, unknown>) => Record<string, unknown>,
  ) => patchSessionMetadataImpl(sessionId, directory, updater),
}));
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({
      sendMessage: (...args: unknown[]) => sendMessageImpl(...args),
      setCurrentSession: (sessionId: string) => { currentSessionSwitches.push(sessionId); },
    }),
  },
}));
mock.module('@/stores/useGlobalSessionsStore', () => ({
  useGlobalSessionsStore: { getState: () => ({ upsertSession: (session: unknown) => { upsertedSessions.push(session); } }) },
}));
mock.module('@/sync/sync-refs', () => ({
  registerSessionDirectory: (sessionId: string, directory: string) => { registeredDirectories.push(`${sessionId}:${directory}`); },
  getSyncMessages: () => parentSyncMessages,
  getAllSyncSessionMap: () => new Map(),
  getSyncChildStores: () => ({
    // Mirrors ChildStoreManager.getChild: keys are normalized paths.
    getChild: (directory: string) => (normalizePath(directory) === '/project' || normalizePath(directory) === 'C:/project' ? {
      getState: () => ({ session: childStoreSessions }),
      setState: (patch: { session: Session[] }) => { childStoreSessions.length = 0; childStoreSessions.push(...patch.session); },
    } : undefined),
  }),
}));

const { preparePendingBtwSend, btwSessionTitle, startBtwSession, destroyBtwSession, promoteBtwSession, filterBtwTailMessages, findLastCompletedAssistantMessageID, BTW_BOUNDARY_INSTRUCTION, BTW_PROMOTION_NOTICE, buildBtwSyntheticTexts } =
  await import('@/lib/btw');
const { useBtwStore } = await import('@/stores/useBtwStore');
const { useSelectionStore } = await import('@/sync/selection-store');
const { useUIStore } = await import('@/stores/useUIStore');
const { usePermissionStore } = await import('@/stores/permissionStore');
const writtenModes: Array<[string, string]> = [];

const makeSession = (id: string, directory?: string): Session => ({
  id,
  directory,
  title: 'btw: q',
  time: { created: Date.now(), updated: Date.now() },
  parentID: undefined,
  version: 1,
}) as unknown as Session;

const page = (items: Array<{ info: Message; parts: Part[] }>): MessagePage => ({ items, cursor: {} });

const record = (id: string, created = 1): { info: Message; parts: Part[] } => ({
  info: { id, sessionID: 'fork-1', role: 'user', time: { created } },
  parts: [],
});

// SAFETY: `findLastCompletedAssistantMessageID` reads only `id`, `role`,
// `time` and `finish`, which are the fields spelled out here.
const assistantMessage = (id: string, completed?: number, finish: string | undefined = completed === undefined ? undefined : 'stop') =>
  ({ id, sessionID: 'parent-1', role: 'assistant', time: { created: 1, completed }, finish }) as Message;

// SAFETY: same narrow read as `assistantMessage`.
const userMessage = (id: string) =>
  ({ id, sessionID: 'parent-1', role: 'user', time: { created: 1 } }) as Message;

const startInput = {
  parentSessionId: 'parent-1',
  question: 'wtf is kafka',
  directory: '/project',
  providerID: 'provider',
  modelID: 'model',
  agent: 'build',
  variant: 'v',
};

beforeEach(() => {
  registeredDirectories.length = 0;
  upsertedSessions.length = 0;
  childStoreSessions.length = 0;
  currentSessionSwitches.length = 0;
  metadataPatches.length = 0;
  parentSyncMessages.splice(0, parentSyncMessages.length, assistantMessage('msg-finished', 10), userMessage('msg-pending'));
  sessionMessageReads.length = 0;
  writtenModes.length = 0;
  useUIStore.setState({ permissionDefaultMode: 'auto' });
  usePermissionStore.setState({ setSessionMode: async (sessionId, mode) => { writtenModes.push([sessionId, mode]); } });
  useBtwStore.setState({ byParent: {} });
  forkSessionImpl = () => Promise.reject(new Error('no forkSession stub'));
  getSessionMessagesImpl = () => Promise.resolve(page([record('msg-boundary')]));
  sendMessageImpl = () => Promise.resolve();
  deleteSessionImpl = () => Promise.resolve(true);
  updateSessionTitleImpl = () => Promise.resolve();
  patchSessionMetadataImpl = (sessionId, _directory, updater) => {
    const result = updater({});
    metadataPatches.push({ sessionId, result });
    return Promise.resolve(makeSession(sessionId));
  };
});

describe('btwSessionTitle', () => {
  test('prefixes the question', () => {
    expect(btwSessionTitle('wtf is kafka')).toBe('btw: wtf is kafka');
  });
});

describe('filterBtwTailMessages', () => {
  test('keeps a newer user message whose ID sorts before the inherited boundary', () => {
    const records = [record('msg_f001', 1), record('msg_0001', 2), record('msg_f002', 3)];
    expect(filterBtwTailMessages(records, 'msg_f001').map((entry) => entry.info.id))
      .toEqual(['msg_0001', 'msg_f002']);
  });

  test('keeps a loaded tail when its inherited boundary is outside the retained page', () => {
    const records = [record('msg_0001', 2), record('msg_f002', 3)];
    expect(filterBtwTailMessages(records, 'msg_f001')).toEqual(records);
  });

  test('keeps only messages after the boundary id', () => {
    const records = [record('msg-1'), record('msg-2'), record('msg-3')];
    expect(filterBtwTailMessages(records, 'msg-2').map((r) => r.info.id)).toEqual(['msg-3']);
  });

  test('a null boundary keeps everything (fork of an empty parent)', () => {
    const records = [record('msg-1'), record('msg-2')];
    expect(filterBtwTailMessages(records, null)).toBe(records);
  });
});

describe('findLastCompletedAssistantMessageID', () => {
  test('skips an assistant turn that is still streaming', () => {
    const messages = [assistantMessage('msg-1', 10), userMessage('msg-2'), assistantMessage('msg-3')];
    expect(findLastCompletedAssistantMessageID(messages)).toBe('msg-1');
  });

  test('skips a completed step that ended in a tool call mid-turn', () => {
    const messages = [assistantMessage('msg-1', 10), userMessage('msg-2'), assistantMessage('msg-3', 20, 'tool-calls')];
    expect(findLastCompletedAssistantMessageID(messages)).toBe('msg-1');
  });

  test('a session with no completed assistant turn has no fork point', () => {
    expect(findLastCompletedAssistantMessageID([userMessage('msg-1')])).toBe(null);
  });
});

describe('startBtwSession', () => {
  test('forks, marks the fork, links the parent, and routes the question to the fork', async () => {
    forkSessionImpl = (sessionId, options) => {
      expect(sessionId).toBe('parent-1');
      expect(options?.before).toBe('msg-pending');
      return Promise.resolve(makeSession('fork-1', options?.directory ?? '/project'));
    };
    let sentText: unknown = null;
    let sentOptions: unknown = null;
    sendMessageImpl = (...args) => {
        sentText = args[0];
        sentOptions = args[9];
        expect(args[7]).toBe(undefined);
        return Promise.resolve();
    };

    const session = await startBtwSession({ ...startInput, variant: null });

    expect(session.id).toBe('fork-1');
    expect(useSelectionStore.getState().getAgentModelVariantForSession('fork-1', 'build', 'provider', 'model')).toBeNull();
    expect(registeredDirectories).toEqual(['fork-1:/project']);
    expect(childStoreSessions.map((s) => s.id)).toEqual(['fork-1']);
    expect(sentText).toBe('wtf is kafka');
    expect(sentOptions).toMatchObject({
      sessionId: 'fork-1',
      directory: '/project',
      target: { runtimeKey: getRuntimeKey(), sessionId: 'fork-1', directory: '/project' },
    });
    expect(metadataPatches).toEqual([
      { sessionId: 'fork-1', result: { openchamber: { kind: 'btw', originalSessionID: 'parent-1', btwBoundaryMessageID: 'msg-boundary' } } },
      { sessionId: 'parent-1', result: { openchamber: { btwSessionID: 'fork-1' } } },
    ]);
    // Transient creating flag is cleared once the flow settles.
    expect(useBtwStore.getState().byParent).toEqual({ 'parent-1': { creating: false } });
  });

  test('a fork in a space starts in the Settings default, which no server writes for it', async () => {
    forkSessionImpl = (_sessionId, options) => Promise.resolve(makeSession('fork-1', options?.directory ?? undefined));

    await startBtwSession({ ...startInput, directory: '/spaces/0123456789ab/project' });

    expect(writtenModes).toEqual([['fork-1', 'auto']]);
  });

  test('a failed write of the default keeps the fork, a failed write of a choice ends it', async () => {
    forkSessionImpl = (_sessionId, options) => Promise.resolve(makeSession('fork-1', options?.directory ?? undefined));
    usePermissionStore.setState({ setSessionMode: () => Promise.reject(new Error('write failed')) });
    const deleted: string[] = [];
    deleteSessionImpl = (sessionId) => { deleted.push(sessionId); return Promise.resolve(true); };

    const session = await startBtwSession({ ...startInput, directory: '/spaces/0123456789ab/project' });
    expect(session.id).toBe('fork-1');
    expect(deleted).toEqual([]);

    let failed = false;
    await startBtwSession({ ...startInput, parentSessionId: 'parent-2', directory: '/spaces/0123456789ab/project', permissionMode: 'auto' })
      .catch(() => { failed = true; });
    expect(failed).toBe(true);
    expect(deleted).toEqual(['fork-1']);
  });

  test('a fork on the host leaves the default to the server; a choice is written anywhere', async () => {
    forkSessionImpl = (_sessionId, options) => Promise.resolve(makeSession('fork-1', options?.directory ?? undefined));

    await startBtwSession(startInput);
    expect(writtenModes).toEqual([]);

    await startBtwSession({ ...startInput, parentSessionId: 'parent-2', permissionMode: 'ask' });
    expect(writtenModes).toEqual([['fork-1', 'ask']]);
  });

  test('inserts a fork returned with a native Windows path into the normalized directory store', async () => {
    forkSessionImpl = () => Promise.resolve(makeSession('fork-1', 'C:\\project'));

    await startBtwSession({ ...startInput, directory: 'C:/project' });

    expect(childStoreSessions.map((s) => s.id)).toEqual(['fork-1']);
  });

  test('rejects an unbounded fork when the server has a prompt missing from the idle local history, then allows retry', async () => {
    parentSyncMessages.splice(0, parentSyncMessages.length, userMessage('msg-1'), assistantMessage('msg-2', 10));
    const serverMessages = [...parentSyncMessages, userMessage('msg-3'), assistantMessage('msg-4')];
    const boundaries: Array<string | undefined> = [];
    let inherited: Message[] = [];
    forkSessionImpl = (_sessionId, options) => {
      boundaries.push(options?.before);
      const cut = serverMessages.findIndex((message) => message.id === options?.before);
      inherited = cut < 0 ? serverMessages : serverMessages.slice(0, cut);
      return Promise.resolve(makeSession('fork-1', '/project'));
    };

    await expect(startBtwSession(startInput)).rejects.toThrow('No safe transcript boundary to fork from');
    expect(boundaries).toEqual([]);
    expect(inherited).toEqual([]);
    expect(metadataPatches).toEqual([]);
    expect(useBtwStore.getState().byParent['parent-1']?.creating).toBe(false);

    parentSyncMessages.push(serverMessages[2], serverMessages[3]);
    await startBtwSession(startInput);

    expect(boundaries).toEqual(['msg-3']);
    expect(inherited.map((message) => message.id)).toEqual(['msg-1', 'msg-2']);
  });

  test('does not copy an unfinished first turn', async () => {
    parentSyncMessages.splice(0, parentSyncMessages.length, userMessage('msg-1'), assistantMessage('msg-2'));
    let attempts = 0;
    forkSessionImpl = () => {
      attempts += 1;
      return Promise.resolve(makeSession('fork-1', '/project'));
    };
    await expect(startBtwSession(startInput)).rejects.toThrow('No completed turn to fork from');
    expect(attempts).toBe(0);
    expect(useBtwStore.getState().byParent['parent-1']?.creating).toBe(false);
  });

  test('keeps the last finished answer and cuts before the running prompt and its context', async () => {
    const carrier: Message = { id: 'msg-2', sessionID: 'parent-1', role: 'synthetic', time: { created: 1 }, text: 'quoted selection' };
    parentSyncMessages.splice(0, parentSyncMessages.length, assistantMessage('msg-1', 10), carrier, userMessage('msg-3'), assistantMessage('msg-4'));
    const boundaries: Array<string | undefined> = [];
    forkSessionImpl = (_sessionId, options) => {
      boundaries.push(options?.before);
      return Promise.resolve(makeSession('fork-1', '/project'));
    };

    await startBtwSession(startInput);

    expect(boundaries).toEqual(['msg-2']);
  });

  test('cuts before a background command result that woke the parent again', async () => {
    const completion: Message = {
      id: 'msg-2',
      sessionID: 'parent-1',
      role: 'synthetic',
      time: { created: 1 },
      text: '<shell>\ndone\n</shell>',
      metadata: { source: 'shell', shellID: 'shell-1', state: 'completed' },
    };
    parentSyncMessages.splice(0, parentSyncMessages.length, assistantMessage('msg-1', 10), completion, assistantMessage('msg-3', 20, 'tool-calls'), assistantMessage('msg-4'));
    const boundaries: Array<string | undefined> = [];
    forkSessionImpl = (_sessionId, options) => {
      boundaries.push(options?.before);
      return Promise.resolve(makeSession('fork-1', '/project'));
    };

    await startBtwSession(startInput);

    expect(boundaries).toEqual(['msg-2']);
  });

  test('keeps the cut when a new turn reaches the server between attempts', async () => {
    parentSyncMessages.splice(0, parentSyncMessages.length, assistantMessage('msg-1', 10), userMessage('msg-2'));
    const boundaries: Array<string | undefined> = [];
    const serverMessages = [assistantMessage('msg-1', 10)];
    let inherited: Message[] = [];
    forkSessionImpl = (_sessionId, options) => {
      boundaries.push(options?.before);
      if (boundaries.length === 1) {
        serverMessages.push(userMessage('msg-2'), assistantMessage('msg-3'));
        return Promise.reject(forkBeforeNotFound);
      }
      const cut = serverMessages.findIndex((message) => message.id === options?.before);
      inherited = cut < 0 ? serverMessages : serverMessages.slice(0, cut);
      return Promise.resolve(makeSession('fork-1', '/project'));
    };

    expect((await startBtwSession(startInput)).id).toBe('fork-1');
    expect(boundaries).toEqual(['msg-2', 'msg-2']);
    expect(inherited.map((message) => message.id)).toEqual(['msg-1']);
  });

  test('a persistent 404 leaves the panel retryable without creating a fork', async () => {
    parentSyncMessages.splice(0, parentSyncMessages.length, assistantMessage('msg-1', 10), userMessage('msg-2'));
    const boundaries: Array<string | undefined> = [];
    forkSessionImpl = (_sessionId, options) => {
      boundaries.push(options?.before);
      return Promise.reject(forkBeforeNotFound);
    };

    await expect(startBtwSession(startInput)).rejects.toThrow('message not found');
    expect(boundaries).toEqual(['msg-2', 'msg-2']);
    expect(metadataPatches).toEqual([]);
    expect(childStoreSessions).toEqual([]);
    expect(useBtwStore.getState().byParent['parent-1']?.creating).toBe(false);
  });

  test('does not retry transport failures', async () => {
    parentSyncMessages.splice(0, parentSyncMessages.length, assistantMessage('msg-1', 10), userMessage('msg-2'));
    let attempts = 0;
    forkSessionImpl = () => {
      attempts += 1;
      return Promise.reject(new Error('transport failure'));
    };
    await expect(startBtwSession(startInput)).rejects.toThrow('transport failure');
    expect(attempts).toBe(1);
  });

  test('the boundary falls back to the fork point when the cloned tail reads empty', async () => {
    parentSyncMessages.splice(0, parentSyncMessages.length, assistantMessage('msg-1', 10), userMessage('msg-2'));
    forkSessionImpl = () => Promise.resolve(makeSession('fork-1', '/project'));
    getSessionMessagesImpl = () => Promise.resolve(page([]));

    await startBtwSession(startInput);

    // Not `null`: a null boundary would show the whole inherited transcript.
    expect(metadataPatches[0]?.result).toEqual({
      openchamber: { kind: 'btw', originalSessionID: 'parent-1', btwBoundaryMessageID: 'msg-1' },
    });
  });

  test('the first question carries the boundary instruction as a synthetic part', async () => {
    forkSessionImpl = () => Promise.resolve(makeSession('fork-1', '/project'));
    const sentParts: unknown[] = [];
    sendMessageImpl = (...args) => {
      sentParts.push(args[6]);
      return Promise.resolve();
    };

    await startBtwSession(startInput);

    expect(sentParts).toEqual([[{ text: BTW_BOUNDARY_INSTRUCTION, synthetic: true }]]);
  });

  test('the first question keeps inline comment context', async () => {
    forkSessionImpl = () => Promise.resolve(makeSession('fork-1', '/project'));
    const commentPart: NonNullable<StartBtwInput['additionalParts']>[number] = {
      text: 'Comment on `src/auth.ts` lines 4-4:\n```ts\nauth();\n```\n\ncheck this',
      synthetic: true,
      metadata: {
        openchamberContext: {
          kind: 'code-comment',
          source: 'file',
          fileLabel: 'src/auth.ts',
          startLine: 4,
          endLine: 4,
          language: 'ts',
          code: 'auth();',
          text: 'check this',
        },
      },
    };
    let sentParts: unknown;
    sendMessageImpl = (...args) => {
      sentParts = args[6];
      return Promise.resolve();
    };

    await startBtwSession({ ...startInput, additionalParts: [commentPart] });

    expect(sentParts).toEqual([
      { text: BTW_BOUNDARY_INSTRUCTION, synthetic: true },
      commentPart,
    ]);
  });

  test('an empty local history cannot authorize copying an unknown server transcript', async () => {
    parentSyncMessages.length = 0;
    let attempts = 0;
    forkSessionImpl = () => {
      attempts += 1;
      return Promise.resolve(makeSession('fork-1', '/project'));
    };
    await expect(startBtwSession(startInput)).rejects.toThrow('No completed turn to fork from');
    expect(attempts).toBe(0);
    expect(metadataPatches).toEqual([]);
    expect(useBtwStore.getState().byParent['parent-1']?.creating).toBe(false);
  });

  test('a failed first send unlinks the parent and deletes the fork', async () => {
    forkSessionImpl = () => Promise.resolve(makeSession('fork-1', '/project'));
    sendMessageImpl = () => Promise.reject(new Error('send failed'));
    const deleted: string[] = [];
    deleteSessionImpl = (sessionId) => { deleted.push(sessionId); return Promise.resolve(true); };

    await expect(startBtwSession(startInput)).rejects.toThrow('send failed');

    expect(deleted).toEqual(['fork-1']);
    // marker, link, then unlink rollback
    expect(metadataPatches.map((p) => p.sessionId)).toEqual(['fork-1', 'parent-1', 'parent-1']);
    expect(metadataPatches[2]?.result).toEqual({});
    expect(useBtwStore.getState().byParent).toEqual({ 'parent-1': { creating: false } });
  });

  test('a failed boundary fetch deletes the fork', async () => {
    forkSessionImpl = () => Promise.resolve(makeSession('fork-1', '/project'));
    getSessionMessagesImpl = () => Promise.reject(new Error('messages failed'));
    const deleted: string[] = [];
    deleteSessionImpl = (sessionId) => { deleted.push(sessionId); return Promise.resolve(true); };

    await expect(startBtwSession(startInput)).rejects.toThrow('messages failed');
    expect(deleted).toEqual(['fork-1']);
    expect(metadataPatches).toEqual([]);
  });

  test('rejects a second creation for the same parent before it forks', async () => {
    let releaseFork: ((session: Session) => void) | undefined;
    const forkStarted = new Promise<void>((resolve) => {
      forkSessionImpl = () => {
        resolve();
        return new Promise((release) => { releaseFork = release; });
      };
    });

    const first = startBtwSession(startInput);
    await forkStarted;
    await expect(startBtwSession(startInput)).rejects.toThrow('btw session creation already in progress');
    releaseFork?.(makeSession('fork-1', '/project'));
    await first;
  });
});

describe('destroyBtwSession', () => {
  const ref = { parentSessionId: 'parent-1', btwSessionId: 'fork-1', directory: '/project' };

  test('unlinks the parent and deletes the fork', async () => {
    const deleted: string[] = [];
    deleteSessionImpl = (sessionId) => { deleted.push(sessionId); return Promise.resolve(true); };
    expect(await destroyBtwSession(ref)).toBe(true);
    expect(metadataPatches).toEqual([{ sessionId: 'parent-1', result: {} }]);
    expect(deleted).toEqual(['fork-1']);
    expect(useBtwStore.getState().byParent).toEqual({});
  });

  test('reports an unconfirmed delete and still cleans UI state', async () => {
    deleteSessionImpl = () => Promise.resolve(false);
    expect(await destroyBtwSession(ref)).toBe(false);
    expect(useBtwStore.getState().byParent).toEqual({});
  });

  test('a failed unlink still attempts the delete', async () => {
    patchSessionMetadataImpl = () => Promise.reject(new Error('patch failed'));
    const deleted: string[] = [];
    deleteSessionImpl = (sessionId) => { deleted.push(sessionId); return Promise.resolve(true); };
    expect(await destroyBtwSession(ref)).toBe(true);
    expect(deleted).toEqual(['fork-1']);
  });
});

describe('promoteBtwSession', () => {
  const ref = { parentSessionId: 'parent-1', btwSessionId: 'fork-1', directory: '/project' };

  test('unlinks the parent, strips the marker, and navigates to the fork without generating a title', async () => {
    const renamedTitles: string[] = [];
    updateSessionTitleImpl = (_sessionId, title) => {
      renamedTitles.push(title);
      return Promise.resolve();
    };
    patchSessionMetadataImpl = (sessionId, _directory, updater) => {
      const base = sessionId === 'fork-1'
        ? { openchamber: { kind: 'btw', originalSessionID: 'parent-1', btwBoundaryMessageID: 'msg-1' } }
        : { openchamber: { btwSessionID: 'fork-1' } };
      const result = updater(base);
      metadataPatches.push({ sessionId, result });
      return Promise.resolve(makeSession(sessionId));
    };

    await promoteBtwSession(ref);

    expect(metadataPatches).toEqual([
      // The fork stops being a btw session but stays marked as promoted: its
      // transcript still carries the boundary instructions.
      { sessionId: 'fork-1', result: { openchamber: { btwPromoted: true } } },
      { sessionId: 'parent-1', result: {} },
    ]);
    expect(currentSessionSwitches).toEqual(['fork-1']);
    expect(sessionMessageReads).toEqual([]);
    expect(renamedTitles).toEqual([]);
  });

  test('a failed unlink aborts the promote without navigating', async () => {
    const originalMetadata = { openchamber: { kind: 'btw', originalSessionID: 'parent-1', btwBoundaryMessageID: 'msg-1' } };
    patchSessionMetadataImpl = (sessionId, _directory, updater) => {
      if (sessionId === 'parent-1') return Promise.reject(new Error('unlink failed'));
      const result = updater(originalMetadata);
      metadataPatches.push({ sessionId, result });
      return Promise.resolve(makeSession(sessionId));
    };

    await expect(promoteBtwSession(ref)).rejects.toThrow('unlink failed');
    expect(currentSessionSwitches).toEqual([]);
    expect(metadataPatches).toEqual([
      { sessionId: 'fork-1', result: { openchamber: { btwPromoted: true } } },
      { sessionId: 'fork-1', result: originalMetadata },
    ]);
  });

  test('a failed marker removal preserves the parent link', async () => {
    patchSessionMetadataImpl = (sessionId) => {
      if (sessionId === 'fork-1') return Promise.reject(new Error('marker failed'));
      throw new Error('the parent must remain linked');
    };

    await expect(promoteBtwSession(ref)).rejects.toThrow('marker failed');
    expect(currentSessionSwitches).toEqual([]);
  });

});

describe('buildBtwSyntheticTexts', () => {
  test('a send routed to an active fork carries only the boundary instruction', () => {
    // Regression: a promoted parent that opens a new btw fork used to send the
    // promotion notice into the fork alongside the boundary instruction, telling
    // the fork both that btw constraints apply and that they no longer apply.
    expect(buildBtwSyntheticTexts({ isBtwActive: true, isPromotedBtwSession: true }))
      .toEqual([BTW_BOUNDARY_INSTRUCTION]);
    expect(buildBtwSyntheticTexts({ isBtwActive: true, isPromotedBtwSession: false }))
      .toEqual([BTW_BOUNDARY_INSTRUCTION]);
  });

  test('a promoted session with no active fork carries the promotion notice', () => {
    expect(buildBtwSyntheticTexts({ isBtwActive: false, isPromotedBtwSession: true }))
      .toEqual([BTW_PROMOTION_NOTICE]);
  });

  test('an ordinary session carries neither', () => {
    expect(buildBtwSyntheticTexts({ isBtwActive: false, isPromotedBtwSession: false })).toEqual([]);
  });
});


describe('pending BTW preparation', () => {
  test('cancelling and reopening during snippet expansion cannot revive the old send', async () => {
    const { getRuntimeKey } = await import('@/lib/runtime-switch');
    const panels = useBtwStore.getState();
    panels.setPanelState('parent-1', { pending: true });
    let finish = () => {};
    const expansion = new Promise<void>((resolve) => { finish = resolve; });
    const preparing = preparePendingBtwSend('parent-1', getRuntimeKey(), () => expansion);
    panels.clearPanelState('parent-1');
    panels.setPanelState('parent-1', { pending: true });
    finish();
    expect(await preparing).toBeNull();
    expect(useBtwStore.getState().byParent['parent-1']).toEqual({ pending: true });
  });

  test('preparation belongs to its parent and rejects duplicate sends', async () => {
    const { getRuntimeKey } = await import('@/lib/runtime-switch');
    const panels = useBtwStore.getState();
    panels.setPanelState('parent-1', { pending: true });
    panels.setPanelState('parent-2', { pending: true });
    let finish = () => {};
    const expansion = new Promise<void>((resolve) => { finish = resolve; });
    const preparing = preparePendingBtwSend('parent-1', getRuntimeKey(), () => expansion);
    expect(await preparePendingBtwSend('parent-1', getRuntimeKey(), async () => {})).toBeNull();
    panels.clearPanelState('parent-2');
    finish();
    expect(await preparing).toBe(useBtwStore.getState().byParent['parent-1']?.pendingSend);
  });

  test('a stale composer cannot fork on the newly selected runtime', async () => {
    await expect(startBtwSession({ ...startInput, expectedRuntimeKey: 'obsolete-runtime' }))
      .rejects.toThrow('runtime changed');
    expect(useBtwStore.getState().byParent).toEqual({});
    expect(registeredDirectories).toEqual([]);
  });
});


test('switching runtime during snippet expansion invalidates preparation', async () => {
  const { getRuntimeKey, initializeRuntimeEndpoint } = await import('@/lib/runtime-switch');
  const panels = useBtwStore.getState();
  panels.setPanelState('parent-1', { pending: true });
  let finish = () => {};
  const expansion = new Promise<void>((resolve) => { finish = resolve; });
  const preparing = preparePendingBtwSend('parent-1', getRuntimeKey(), () => expansion);
  initializeRuntimeEndpoint({ apiBaseUrl: 'https://btw-test.invalid', runtimeKey: 'changed-during-preparation' });
  finish();
  expect(await preparing).toBeNull();
  expect(useBtwStore.getState().byParent).toEqual({});
});
