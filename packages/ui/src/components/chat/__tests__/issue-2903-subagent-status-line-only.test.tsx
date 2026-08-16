/**
 * Regression coverage for https://github.com/openchamber/openchamber/issues/2903
 *
 * Busy embedded session-chat panels were rendering only the working-status row
 * ("…is running command") because ChatContainer gated message reads on the
 * same visibility flag used to keep the composer from stealing focus. When the
 * iframe booted inactive (or a visibility postMessage was lost),
 * useSessionMessageRecords returned [] while session status stayed busy — so
 * the empty-state branch was skipped and the transcript showed status only.
 *
 * Idle sessions hit the empty state instead (#2892). Same root cause.
 *
 * Fix: embedded session-chat keeps `messagesEnabled={true}` so history stays
 * subscribed while `active={embeddedBackgroundWorkEnabled}` still gates
 * composer focus and background work.
 */
import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';

mock.module('sonner', () => ({
  toast: { dismiss: () => undefined, error: () => undefined, info: () => undefined, success: () => undefined },
}));
mock.module('@/components/ui', () => ({
  toast: { info: () => undefined, error: () => undefined, success: () => undefined },
}));
mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: () => '/repo',
    setDirectory: () => undefined,
    getSdkClient: () => ({}),
    getScopedSdkClient: () => ({}),
  },
}));
mock.module('@/stores/permissionStore', () => ({
  usePermissionStore: { getState: () => ({ isSessionAutoAccepting: () => false, hydrate: async () => undefined }) },
}));
mock.module('@/stores/useConfigStore', () => ({
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(__dirname, '..', '..', '..', 'App.tsx'), 'utf-8');
const chatContainerSource = readFileSync(join(__dirname, '..', 'ChatContainer.tsx'), 'utf-8');
const chatViewSource = readFileSync(join(__dirname, '..', '..', 'views', 'ChatView.tsx'), 'utf-8');
const syncContextSource = readFileSync(join(__dirname, '..', '..', '..', 'sync', 'sync-context.tsx'), 'utf-8');

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

const syncContext = (globalThis as unknown as {
  __openchamber_sync_context__?: React.Context<unknown>;
}).__openchamber_sync_context__;

if (!syncContext) {
  throw new Error('sync context was not published on globalThis by @/sync/sync-context');
}

describe('issue #2903 busy embedded subagent status-line-only', () => {
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
        title: 'Audit Searchbar implementation',
        time: { created: 1, updated: 1 },
        version: '1',
        directory: DIRECTORY,
      } as State['session'][number]],
      message: { [SESSION_ID]: messages },
      part,
    } as Partial<State>);

    expect(getSessionMaterializationStatus(store.getState(), SESSION_ID)).toEqual({
      hasMessages: true,
      renderable: true,
      missingPartMessageIDs: [],
    });

    const system = { childStores, messageLoader: {}, sdk: {}, runtimeKey: 'test', directory: DIRECTORY };
    const Provider = syncContext.Provider as React.Provider<unknown>;
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

    try {
      await act(async () => {
        root.render(React.createElement(Provider, { value: system }, React.createElement(Harness)));
      });
      expect(inactiveCount).toBe(0);

      enabled = true;
      await act(async () => {
        root.render(React.createElement(Provider, { value: system }, React.createElement(Harness)));
      });
      expect(activeCount).toBe(14);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  test('sync gate still returns empty on cold disabled reads', () => {
    const hookStart = syncContextSource.indexOf('export function useSessionMessageRecords(');
    const hookBody = syncContextSource.slice(hookStart, hookStart + 1800);
    expect(hookBody).toContain('if (options?.enabled === false)');
    expect(hookBody).toContain('EMPTY_SESSION_MESSAGE_RECORDS');
    expect(hookBody).toContain('snapshotRef.current.sessionID === sessionID ? snapshotRef.current.list');
  });

  test('embedded session-chat keeps message history enabled while visibility gates active', () => {
    expect(appSource).toContain('messagesEnabled={true}');
    expect(appSource).toContain('active={embeddedBackgroundWorkEnabled}');
    expect(appSource).toContain('const [isEmbeddedVisible, setIsEmbeddedVisible] = React.useState(false);');
    expect(chatViewSource).toContain('messagesEnabled?: boolean');
    expect(chatContainerSource).toContain('messagesEnabled: messagesEnabledProp');
    expect(chatContainerSource).toContain('const messagesEnabled = messagesEnabledProp ?? active;');
    expect(chatContainerSource).toContain('enabled: messagesEnabled');
    expect(chatContainerSource.includes('enabled: active')).toBe(false);
    expect(chatContainerSource).toContain('if (!messagesEnabled || !currentSessionId) return;');
    expect(chatContainerSource).toContain('void ensureSessionRenderable(currentSessionId);');
  });

  test('empty+busy branch skips empty state so StatusRowContainer can stand alone', () => {
    expect(chatContainerSource).toContain('if (sessionMessages.length === 0 && !sessionIsWorking)');
    expect(chatContainerSource).toContain('<ChatEmptyState');
    expect(chatContainerSource).toContain('<StatusRowContainer />');

    const emptyBusyGuard = 'if (sessionMessages.length === 0 && !sessionIsWorking)';
    const emptyStateReturn = chatContainerSource.indexOf(emptyBusyGuard);
    expect(emptyStateReturn).toBeGreaterThan(-1);
    const emptyStateBlock = chatContainerSource.slice(
      emptyStateReturn,
      emptyStateReturn + 1600,
    );
    expect(emptyStateBlock).toContain('<ChatEmptyState');
    expect(emptyStateBlock).not.toContain('<StatusRowContainer />');
  });

  test('visibility handshake remains as defense-in-depth for background work', () => {
    expect(appSource).toContain('requestEmbeddedSessionVisibility();');
    expect(appSource).toContain('EMBEDDED_VISIBILITY_UPDATE');
  });
});
