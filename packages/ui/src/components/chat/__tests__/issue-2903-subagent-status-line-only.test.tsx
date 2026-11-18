/**
 * Regression coverage for https://github.com/openchamber/openchamber/issues/2903
 *
 * Busy side-panel subagent chats were rendering only the working-status row
 * ("…is running command") because message reads were gated off while session
 * status stayed busy — so the empty-state branch was skipped and the
 * transcript showed status only. Idle sessions hit the empty state instead
 * (#2892). The chat then ran in an iframe whose visibility handshake could be
 * lost; it now renders in the app, and these tests keep the read gate and the
 * empty/busy branches honest.
 */
import { describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message, Part } from '@/lib/opencode/model';

mock.module('sonner', () => ({
  toast: { dismiss: () => undefined, error: () => undefined, info: () => undefined, success: () => undefined },
}));
mock.module('@/components/ui', () => ({
  toast: { info: () => undefined, error: () => undefined, success: () => undefined },
}));
let mockIdCounter = 0;
mock.module('@/lib/opencode/client', () => ({
  isOpencodeNotFound: () => false,
  OpencodeApiError: Error,
  normalizeOpencodeError: (operation: string, error: unknown) => new Error(`${operation}: ${String(error)}`),
  ascendingId: (prefix: string) => `${prefix}_${(mockIdCounter += 1).toString(16).padStart(12, '0')}`,
  opencodeClient: {
    getDirectory: () => '/repo',
    setDirectory: () => undefined,
    getSdkClient: () => ({}),
    getScopedSdkClient: () => ({}),
  },
}));
mock.module('@/stores/permissionStore', () => ({
  usePermissionStore: { getState: () => ({ getSessionMode: () => 'ask', hydrate: async () => undefined }) },
}));
mock.module('@/stores/useConfigStore', () => ({
  markConfigCatalogStale: () => undefined,
  invalidateConfigCatalogsForReload: () => undefined,
  selectCatalogLoadedForDirectory: () => false,
  selectConfigAgentsForDirectory: () => [],
  invalidateConfigAgentsLoad: () => undefined,
  useConfigStore: {
    getState: () => ({ isConnected: true, hasEverConnected: true, settingsMessageStreamTransport: 'auto' }),
    setState: () => undefined,
  },
}));
mock.module('@/stores/useTodosPersistStore', () => ({
  useTodosPersistStore: { getState: () => ({ setSessionTodos: () => undefined }) },
}));

const { useSessionMessageRecords } = await import('@/sync/sync-context');
const { ChildStoreManager } = await import('@/sync/child-store');
const { getSessionMaterializationStatus } = await import('@/sync/materialization');
import type { State } from '@/sync/types';

const { resolveSessionPlaceholder } = await import('../column/sessionPlaceholder');

const SESSION_ID = 'ses_subagent_2903';
const DIRECTORY = '/repo';

const installMinimalDom = () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  class ElementStub {}
  const documentStub: Record<string, unknown> = {
    nodeType: 9,
    defaultView: globalThis,
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const container = {
    nodeType: 1,
    tagName: 'DIV',
    nodeName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: documentStub,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  documentStub.documentElement = container;
  documentStub.body = container;
  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  setGlobal('location', { search: '', protocol: 'http:', hostname: 'localhost' });
  setGlobal('Element', ElementStub);
  setGlobal('HTMLElement', ElementStub);
  setGlobal('HTMLIFrameElement', ElementStub);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
  setGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  return {
    container: container as unknown as Element,
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

const createMessage = (id: string, role: 'user' | 'assistant', created: number): Message => ({
  id,
  sessionID: SESSION_ID,
  role,
  ...(role === 'assistant' ? { parentID: `u_${created}` } : {}),
  time: { created },
} as Message);

const createPart = (id: string, messageID: string, text: string): Part => ({
  id,
  messageID,
  sessionID: SESSION_ID,
  type: 'text',
  text,
} as Part);

/** 14-message subagent transcript, matching the issue reproduction fixture. */
const buildMaterializedSubagentSession = () => {
  const messages: Message[] = [];
  const part: Record<string, Part[]> = {};
  for (let index = 0; index < 14; index += 1) {
    const created = index + 1;
    const role: 'user' | 'assistant' = created % 2 === 1 ? 'user' : 'assistant';
    const id = role === 'user' ? `u_${created}` : `a_${created}`;
    messages.push(createMessage(id, role, created));
    part[id] = [createPart(`prt_${id}`, id, role === 'user' ? `prompt ${created}` : `output ${created}`)];
  }
  return { messages, part };
};

// SAFETY: sync-context.tsx publishes exactly these two keys on globalThis
// (SYNC_CONTEXT_GLOBAL_KEY / SYNC_RUNTIME_CONTEXT_GLOBAL_KEY) so every module
// instance shares one context identity; the cast only adds those two optional
// keys to the global object type, and the guards below re-check presence.
const syncGlobals = globalThis as {
  __openchamber_sync_context__?: React.Context<unknown>;
  __openchamber_sync_runtime_context__?: React.Context<unknown>;
};

const syncContext = syncGlobals.__openchamber_sync_context__;

if (!syncContext) {
  throw new Error('sync context was not published on globalThis by @/sync/sync-context');
}

const syncRuntimeContext = syncGlobals.__openchamber_sync_runtime_context__;

if (!syncRuntimeContext) {
  throw new Error('sync runtime context was not published on globalThis by @/sync/sync-context');
}

describe('issue #2903 busy subagent status-line-only', () => {
  test('cold disabled reads hide a fully materialized 14-message subagent; enabled reads return all 14', async () => {
    const dom = installMinimalDom();
    const root: Root = createRoot(dom.container);
    const childStores = new ChildStoreManager();
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    const { messages, part } = buildMaterializedSubagentSession();
    store.setState({
      status: 'complete',
      session: [{
        id: SESSION_ID,
        projectID: 'project',
        title: 'Audit Searchbar implementation',
        time: { created: 1, updated: 1 },
        directory: DIRECTORY,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }],
      message: { [SESSION_ID]: messages },
      part,
    } as Partial<State>);

    expect(getSessionMaterializationStatus(store.getState(), SESSION_ID)).toEqual({
      hasMessages: true,
      renderable: true,
      missingPartMessageIDs: [],
    });

    const system = { childStores, messageLoader: {}, sdk: {}, runtimeKey: 'test', directory: DIRECTORY };
    // Mirrors SyncProvider's own nesting: system context outer, runtime inner.
    // Directory-scoped hooks read the runtime context, so the harness must
    // provide it with a currentDirectory source for the store lookups.
    const runtime = {
      childStores,
      messageLoader: {},
      sdk: {},
      runtimeKey: 'test',
      currentDirectory: { get: () => DIRECTORY, subscribe: () => () => undefined },
    };
    let inactiveCount = -1;
    let activeCount = -1;
    let enabled = false;

    const Harness = () => {
      const records = useSessionMessageRecords(SESSION_ID, DIRECTORY, { enabled });
      if (enabled) {
        activeCount = records.length;
      } else {
        inactiveCount = records.length;
      }
      return null;
    };

    const renderHarness = () =>
      React.createElement(
        syncContext.Provider,
        { value: system },
        React.createElement(syncRuntimeContext.Provider, { value: runtime }, React.createElement(Harness)),
      );

    try {
      await act(async () => {
        root.render(renderHarness());
      });
      expect(inactiveCount).toBe(0);

      enabled = true;
      await act(async () => {
        root.render(renderHarness());
      });
      expect(activeCount).toBe(14);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  test('sync gate still returns empty on cold disabled reads', async () => {
    const dom = installMinimalDom();
    const root = createRoot(dom.container);
    const childStores = new ChildStoreManager();
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    const { messages, part } = buildMaterializedSubagentSession();
    store.setState({ message: { [SESSION_ID]: messages }, part });
    const runtime = {
      childStores,
      currentDirectory: { get: () => DIRECTORY, subscribe: () => () => undefined },
    };
    let count = -1;
    let enabled = false;
    const Harness = () => {
      const records = useSessionMessageRecords(SESSION_ID, DIRECTORY, { enabled });
      count = records.length;
      return null;
    };
    try {
      await act(async () => root.render(
        <syncRuntimeContext.Provider value={runtime}><Harness /></syncRuntimeContext.Provider>,
      ));
      expect(count).toBe(0);
      enabled = true;
      await act(async () => root.render(
        <syncRuntimeContext.Provider value={runtime}><Harness /></syncRuntimeContext.Provider>,
      ));
      expect(count).toBe(14);
      enabled = false;
      await act(async () => root.render(
        <syncRuntimeContext.Provider value={runtime}><Harness /></syncRuntimeContext.Provider>,
      ));
      expect(count).toBe(14);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  test('the empty and idle branch leaves the status row to the busy path', () => {
    const options: Parameters<typeof resolveSessionPlaceholder>[0] = {
      t: (key) => key,
      draftOpen: false,
      draftPresentationExiting: false,
      useCompactDraftLayout: false,
      isDesktopExpandedInput: false,
      isSessionHydrating: false,
      messageCount: 0,
      sessionIsWorking: false,
      spaceStopped: false,
      effectiveSessionDirectory: DIRECTORY,
      loadStatus: 'complete',
      authSessionExpired: false,
      retrySessionLoad: () => undefined,
    };
    const idle = resolveSessionPlaceholder(options);
    expect(React.isValidElement(idle)).toBe(true);
    expect(renderToStaticMarkup(idle)).toBe('<div class="relative min-h-0 flex-1" aria-hidden="false"></div>');
    expect(resolveSessionPlaceholder({ ...options, sessionIsWorking: true })).toBeUndefined();
  });
});
