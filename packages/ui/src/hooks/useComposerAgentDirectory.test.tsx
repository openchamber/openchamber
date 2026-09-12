import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

/**
 * `useComposerAgentDirectory` is mocked in every component test, so this suite
 * renders the real hook. A chat draft scopes to the generated scratch
 * directory the send targets; an unprepared draft has no scope yet and fails
 * open (`undefined`), never falling back to the ambient `null` list.
 */
mock.module('@/lib/runtime-fetch', () => ({
  // `loadAgents` tags each agent through its config route; this suite only
  // needs the directory list request.
  runtimeFetch: async () => new Response(JSON.stringify({}), {
    headers: { 'Content-Type': 'application/json' },
  }),
}));

import { opencodeClient } from '@/lib/opencode/client';
import { useAgentsStore } from '@/stores/useAgentsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import {
  useComposerAgentDirectory,
  useVisibleAgentsForDirectory,
} from './useVisibleAgentsForDirectory';

const PREPARED_CHAT_DIRECTORY = '/home/tester/.openchamber/chats/draft-hook';
const originalListAgents = opencodeClient.listAgents;

const DOM_GLOBAL_NAMES = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLIFrameElement',
  'localStorage',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

const frameTimers = new Map<number, ReturnType<Window['setTimeout']>>();
let nextFrameHandle = 1;

const installDom = () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const values = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    Node: happyWindow.Node,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    HTMLIFrameElement: happyWindow.HTMLIFrameElement,
    localStorage: happyWindow.localStorage,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const handle = nextFrameHandle++;
      frameTimers.set(handle, happyWindow.setTimeout(() => {
        frameTimers.delete(handle);
        callback(0);
      }, 0));
      return handle;
    },
    cancelAnimationFrame: (handle: number) => {
      const timer = frameTimers.get(handle);
      if (timer === undefined) return;
      frameTimers.delete(handle);
      happyWindow.clearTimeout(timer);
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of DOM_GLOBAL_NAMES) {
    Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container,
    restore: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

const ComposerScopeProbe = ({
  sessionId,
  onDirectory,
}: {
  sessionId: string | null;
  onDirectory: (directory: string | null | undefined) => void;
}) => {
  const directory = useComposerAgentDirectory(sessionId);
  onDirectory(directory);
  // The composer wiring under test: the picker reads the resolved scope, which
  // is what loads the directory's list.
  useVisibleAgentsForDirectory(directory);
  return null;
};

const renderProbe = async (sessionId: string | null, onDirectory: (directory: string | null | undefined) => void) => {
  const dom = installDom();
  const root = createRoot(dom.container);
  await act(async () => {
    root.render(<ComposerScopeProbe sessionId={sessionId} onDirectory={onDirectory} />);
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await act(async () => { await Promise.resolve(); });
  }
  return {
    cleanup: async () => {
      await act(async () => root.unmount());
      dom.restore();
    },
  };
};

describe('useComposerAgentDirectory', () => {
  let listAgentsCalls: Array<string | null | undefined>;
  let resolvedDirectories: Array<string | null | undefined>;

  beforeEach(() => {
    listAgentsCalls = [];
    resolvedDirectories = [];
    useAgentsStore.setState({ agentsByDirectory: {}, agents: [], isLoading: false });
    useSessionUIStore.setState({
      newSessionDraft: { draftId: 0, open: false, directoryOverride: null, parentID: null, target: 'chat' },
    });
    opencodeClient.listAgents = async (directory) => {
      listAgentsCalls.push(directory);
      return [];
    };
  });

  afterEach(() => {
    opencodeClient.listAgents = originalListAgents;
  });

  test('an open chat draft resolves and loads the prepared scratch directory the send targets', async () => {
    useSessionUIStore.setState({
      newSessionDraft: {
        draftId: 1,
        open: true,
        directoryOverride: null,
        parentID: null,
        target: 'chat',
        preparedChatDirectory: PREPARED_CHAT_DIRECTORY,
      },
    });

    const view = await renderProbe(null, (directory) => resolvedDirectories.push(directory));
    try {
      expect(resolvedDirectories.at(-1)).toBe(PREPARED_CHAT_DIRECTORY);
      expect(listAgentsCalls).toContain(PREPARED_CHAT_DIRECTORY);
      expect(listAgentsCalls).not.toContain(null);
    } finally {
      await view.cleanup();
    }
  });

  test('an unprepared chat draft fails open to undefined, never the ambient null scope', async () => {
    useSessionUIStore.setState({
      newSessionDraft: {
        draftId: 2,
        open: true,
        directoryOverride: null,
        bootstrapPendingDirectory: null,
        parentID: null,
        target: 'chat',
        preparedChatDirectory: null,
      },
    });

    const view = await renderProbe(null, (directory) => resolvedDirectories.push(directory));
    try {
      expect(resolvedDirectories.at(-1)).toBeUndefined();
      expect(listAgentsCalls).toEqual([]);
    } finally {
      await view.cleanup();
    }
  });
});
