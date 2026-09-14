import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Message, Part, Session } from '@opencode-ai/sdk/v2';
import type { StartBtwInput } from './btw';

let forkSessionImpl: (sessionId: string, messageId?: string, directory?: string | null) => Promise<Session>;
let getSessionMessagesImpl: (id: string, limit?: number, directory?: string | null) => Promise<Array<{ info: Message; parts: Part[] }>>;
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
  opencodeClient: {
    forkSession: (sessionId: string, messageId?: string, directory?: string | null) =>
      forkSessionImpl(sessionId, messageId, directory),
    getSessionMessages: (id: string, limit?: number, directory?: string | null) => {
      sessionMessageReads.push(id);
      return getSessionMessagesImpl(id, limit, directory);
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
  getSyncChildStores: () => ({
    children: new Map([['/project', {
      getState: () => ({ session: childStoreSessions }),
      setState: (patch: { session: Session[] }) => { childStoreSessions.length = 0; childStoreSessions.push(...patch.session); },
    }]]),
    getChild: (directory: string) => directory === '/project' ? {
      getState: () => ({ session: childStoreSessions }),
      setState: (patch: { session: Session[] }) => { childStoreSessions.length = 0; childStoreSessions.push(...patch.session); },
    } : undefined,
  }),
}));

const { preparePendingBtwSend, btwSessionTitle, startBtwSession, destroyBtwSession, promoteBtwSession, filterBtwTailMessages, findLastCompletedAssistantMessageID, BTW_BOUNDARY_INSTRUCTION, BTW_PROMOTION_NOTICE, buildBtwSyntheticTexts } =
  await import('@/lib/btw');
const { useBtwStore } = await import('@/stores/useBtwStore');
const { useSelectionStore } = await import('@/sync/selection-store');

const makeSession = (id: string, directory?: string): Session => ({
  id,
  directory,
  title: 'btw: q',
  time: { created: Date.now(), updated: Date.now() },
  parentID: undefined,
  version: 1,
}) as unknown as Session;

const record = (id: string, created = 1): { info: Message; parts: Part[] } => ({
  info: { id, sessionID: 'fork-1', role: 'user', time: { created }, agent: 'plan', model: { providerID: 'provider', modelID: 'model' } },
  parts: [],
});

// SAFETY: `findLastCompletedAssistantMessageID` reads only `id`, `role` and
// `time`, which are the fields spelled out here.
const assistantMessage = (id: string, completed?: number) =>
  ({ id, sessionID: 'parent-1', role: 'assistant', time: { created: 1, completed } }) as Message;

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
  parentSyncMessages.length = 0;
  sessionMessageReads.length = 0;
  useBtwStore.setState({ byParent: {} });
  forkSessionImpl = () => Promise.reject(new Error('no forkSession stub'));
  getSessionMessagesImpl = () => Promise.resolve([record('msg-boundary')]);
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

  test('a session with no completed assistant turn has no fork point', () => {
    expect(findLastCompletedAssistantMessageID([userMessage('msg-1')])).toBe(null);
  });
});

describe('startBtwSession', () => {
  test('forks, marks the fork, links the parent, and routes the question to the fork', async () => {
    forkSessionImpl = (sessionId, messageId, directory) => {
      expect(sessionId).toBe('parent-1');
      expect(messageId).toBe(undefined);
      return Promise.resolve(makeSession('fork-1', directory ?? '/project'));
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
    expect(sentOptions).toEqual({ sessionId: 'fork-1', directory: '/project' });
    expect(metadataPatches).toEqual([
      { sessionId: 'fork-1', result: { openchamber: { kind: 'btw', originalSessionID: 'parent-1', btwBoundaryMessageID: 'msg-boundary' } } },
      { sessionId: 'parent-1', result: { openchamber: { btwSessionID: 'fork-1' } } },
    ]);
    // Transient creating flag is cleared once the flow settles.
    expect(useBtwStore.getState().byParent).toEqual({ 'parent-1': { creating: false } });
  });

  test('forks at the last completed assistant turn, not at the in-flight one', async () => {
    parentSyncMessages.push(assistantMessage('msg-1', 10), userMessage('msg-2'), assistantMessage('msg-3'));
    const forkPoints: Array<string | undefined> = [];
    forkSessionImpl = (_sessionId, messageId) => {
      forkPoints.push(messageId);
      return Promise.resolve(makeSession('fork-1', '/project'));
    };

    await startBtwSession(startInput);

    expect(forkPoints).toEqual(['msg-1']);
  });

  test('the boundary falls back to the fork point when the cloned tail reads empty', async () => {
    parentSyncMessages.push(assistantMessage('msg-1', 10));
    forkSessionImpl = () => Promise.resolve(makeSession('fork-1', '/project'));
    getSessionMessagesImpl = () => Promise.resolve([]);

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

  test('an empty parent produces a marker without a boundary', async () => {
    forkSessionImpl = () => Promise.resolve(makeSession('fork-1', '/project'));
    getSessionMessagesImpl = () => Promise.resolve([]);
    await startBtwSession(startInput);
    expect(metadataPatches[0]?.result).toEqual({ openchamber: { kind: 'btw', originalSessionID: 'parent-1' } });
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
