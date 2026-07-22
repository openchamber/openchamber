import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2';

const requests: Array<Record<string, unknown>> = [];
const sends: Array<Record<string, unknown>> = [];
let messages: Message[] = [];
let runtimeKey = 'runtime-a';
let responseStatus = 201;
let responseBody: Record<string, unknown> = {};
let existingSideSessionId: string | null = null;
const phases: string[] = [];

mock.module('@/lib/runtime-switch', () => ({ getRuntimeKey: () => runtimeKey }));
mock.module('@/lib/sideChats/runtimeOperation', () => ({
  captureSideChatRuntimeOperation: () => ({
    runtimeKey,
    isCurrent: () => runtimeKey === 'runtime-a',
    fetch: mock(async (_path: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body ?? '{}')));
      return new Response(JSON.stringify(responseBody), {
        status: responseStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
    client: {
      session: {
        promptAsync: mock(async (input: Record<string, unknown>) => { sends.push(input); return { data: true }; }),
      },
    },
  }),
}));
mock.module('@/sync/sync-refs', () => ({
  getSyncMessages: () => messages,
  registerSessionDirectory: () => {},
}));
mock.module('@/sync/session-actions', () => ({
  optimisticSend: mock(async (input: { send: (messageID: string) => Promise<void> }) => input.send('message-side')),
}));
mock.module('@/components/layout/disposableSideChatLifecycle', () => ({
  serializeDisposableSideChatSend: async (_identity: unknown, operation: () => Promise<unknown>) => operation(),
}));
mock.module('@/components/layout/contextPanelEmbeddedChat', () => ({ focusEmbeddedSessionChatComposer: () => true }));
mock.module('@/stores/useUIStore', () => ({
  useUIStore: { getState: () => ({ openContextPanelTab: () => {} }) },
}));
mock.module('@/stores/useGlobalSessionsStore', () => ({
  useGlobalSessionsStore: { getState: () => ({ upsertSession: () => {} }) },
}));
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: { getState: () => ({ setSessionDirectory: () => {} }) },
}));
mock.module('@/sync/selection-store', () => ({
  useSelectionStore: { getState: () => ({
    saveSessionModelSelection: () => {},
    saveSessionAgentSelection: () => {},
    saveAgentModelForSession: () => {},
    saveAgentModelVariantForSession: () => {},
  }) },
}));

const entries = new Map<string, never>();
mock.module('@/stores/useDisposableSideChatsStore', () => ({
  useDisposableSideChatsStore: { getState: () => ({
    entries,
    findByParent: () => existingSideSessionId ? {
      runtimeKey: 'runtime-a', directory: '/repo', parentSessionId: 'parent', sideSessionId: existingSideSessionId, phase: 'open',
    } : null,
    findBySide: () => ({ runtimeKey: 'runtime-a', directory: '/repo', parentSessionId: 'parent', sideSessionId: 'side' }),
    beginOpening: () => 'opening',
    cancelOpening: () => {},
    bindSideSession: (_key: string, sideSessionId: string) => { existingSideSessionId = sideSessionId; return 'bound'; },
    setPhase: (_identity: unknown, phase: string) => { phases.push(phase); },
  }) },
}));

import { openDisposableSideChat } from './controller';

describe('side chat controller', () => {
  beforeEach(() => {
    requests.length = 0;
    sends.length = 0;
    messages = [];
    runtimeKey = 'runtime-a';
    responseStatus = 201;
    responseBody = {
      id: 'side', title: 'Side', directory: '/repo', time: { created: 2 },
      metadata: { openchamber: { sideChat: { disposable: true, parentSessionID: 'parent' } } },
    };
    existingSideSessionId = null;
    phases.length = 0;
  });

  test('forks from the latest completed answer and sends trailing text', async () => {
    messages = [
      { id: 'completed', role: 'assistant', time: { created: 1, completed: 2 } } as Message,
      { id: 'streaming', role: 'assistant', time: { created: 3 } } as Message,
    ];

    await openDisposableSideChat({
      parentSessionId: 'parent', directory: '/repo', prompt: 'explain', providerID: 'provider', modelID: 'model',
    });

    expect(requests).toEqual([{ parentSessionID: 'parent', messageID: 'completed' }]);
    expect({
      id: sends[0]?.sessionID,
      directory: sends[0]?.directory,
      text: (sends[0]?.parts as Array<{ text?: string }> | undefined)?.[0]?.text,
      messageId: sends[0]?.messageID,
    }).toEqual({ id: 'side', directory: '/repo', text: 'explain', messageId: 'message-side' });
  });

  test('fails before creating when no completed answer exists', async () => {
    messages = [{ id: 'streaming', role: 'assistant', time: { created: 1 } } as Message];
    expect(openDisposableSideChat({
      parentSessionId: 'parent', directory: '/repo', prompt: '', providerID: 'provider', modelID: 'model',
    })).rejects.toThrow('No completed assistant response');
    expect(requests).toEqual([]);
  });

  test('sends a non-empty prompt to an existing side chat', async () => {
    existingSideSessionId = 'existing-side';
    await openDisposableSideChat({
      parentSessionId: 'parent', directory: '/repo', prompt: 'retry prompt', providerID: 'provider', modelID: 'model',
    });
    expect(requests).toEqual([]);
    expect(sends[0]?.sessionID).toBe('existing-side');
    expect((sends[0]?.parts as Array<{ text?: string }>)[0]?.text).toBe('retry prompt');
  });

  test('retains a surviving fork as cleanup-pending on typed failure', async () => {
    messages = [{ id: 'completed', role: 'assistant', time: { created: 1, completed: 2 } } as Message];
    responseStatus = 502;
    responseBody = { error: 'cleanup failed', cleanupRequired: true, forkSessionID: 'surviving-side' };
    await expect(openDisposableSideChat({
      parentSessionId: 'parent', directory: '/repo', prompt: '', providerID: 'provider', modelID: 'model',
    })).rejects.toThrow('cleanup failed');
    expect(existingSideSessionId).toBe('surviving-side');
    expect(phases).toContain('cleanup-pending');
  });

  test('keeps a successful side chat under the captured runtime without opening the new runtime UI', async () => {
    messages = [{ id: 'completed', role: 'assistant', time: { created: 1, completed: 2 } } as Message];
    responseBody = new Proxy(responseBody, {
      get(target, property) {
        if (property === 'id') runtimeKey = 'runtime-b';
        return Reflect.get(target, property);
      },
    });
    await expect(openDisposableSideChat({
      parentSessionId: 'parent', directory: '/repo', prompt: '', providerID: 'provider', modelID: 'model',
    })).rejects.toThrow('available for recovery');
    expect(existingSideSessionId).toBe('side');
  });
});
