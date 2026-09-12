import React, { act } from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { create } from 'zustand';

/**
 * The mobile agent button scopes its agent to the session the column is
 * showing (see chatColumnSession.ts), matching the composer and the send path.
 * Reading the live store here made the chip disagree with the composer during
 * a deferred session switch.
 */

const LIVE_SESSION_ID = 'ses_live';
const COLUMN_SESSION_ID = 'ses_column';
const LIVE_DIRECTORY = '/scope/live';
const COLUMN_DIRECTORY = '/scope/column';

const composerAgentDirectoryCalls: Array<string | null> = [];

mock.module('@/hooks/useVisibleAgentsForDirectory', () => ({
  useComposerAgentDirectory: (sessionId: string | null) => {
    composerAgentDirectoryCalls.push(sessionId);
    return sessionId === COLUMN_SESSION_ID ? COLUMN_DIRECTORY : LIVE_DIRECTORY;
  },
  useVisibleAgentsForDirectory: (directory: string | null | undefined) => (
    directory === COLUMN_DIRECTORY
      ? [{ name: 'column-agent', mode: 'primary' }]
      : [{ name: 'live-agent', mode: 'primary' }]
  ),
}));

// The label is asserted as the raw resolved agent name; the display-name
// formatting is not what this suite pins.
mock.module('./mobileControlsUtils', () => ({
  getAgentDisplayName: (_agents: unknown[], agentName?: string) => agentName ?? 'none',
}));

mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: create(() => ({ currentAgentName: 'build' })),
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: <T,>(selector: (state: { currentSessionId: string }) => T): T =>
    selector({ currentSessionId: LIVE_SESSION_ID }),
}));

mock.module('@/sync/selection-store', () => ({
  useSelectionStore: create(() => ({
    getSessionAgentSelection: (sessionId: string | null) => (
      sessionId === COLUMN_SESSION_ID ? 'column-agent' : 'live-agent'
    ),
  })),
}));

const { MobileAgentButton } = await import('./MobileAgentButton');
const { ChatColumnSessionContext } = await import('./chatColumnSession');

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

const renderMobileAgentButton = async (columnSession: { sessionId: string | null; directory: string | null } | null = null) => {
  const dom = installDom();
  const root = createRoot(dom.container);
  const button = (
    <MobileAgentButton onCycleAgent={() => {}} onOpenAgentPanel={() => {}} />
  );
  await act(async () => root.render(
    columnSession
      ? <ChatColumnSessionContext.Provider value={columnSession}>{button}</ChatColumnSessionContext.Provider>
      : button,
  ));
  return {
    container: dom.container,
    cleanup: async () => {
      await act(async () => root.unmount());
      dom.restore();
    },
  };
};

describe('MobileAgentButton session scope', () => {
  beforeEach(() => {
    composerAgentDirectoryCalls.length = 0;
  });

  test('the column session drives the agent scope, not the live selection', async () => {
    const { container, cleanup } = await renderMobileAgentButton({ sessionId: COLUMN_SESSION_ID, directory: COLUMN_DIRECTORY });
    try {
      expect(composerAgentDirectoryCalls.at(-1)).toBe(COLUMN_SESSION_ID);
      expect(container.textContent).toContain('column-agent');
      expect(container.textContent).not.toContain('live-agent');
    } finally {
      await cleanup();
    }
  });

  test('without a column session the live selection still drives the agent scope', async () => {
    const { container, cleanup } = await renderMobileAgentButton();
    try {
      expect(composerAgentDirectoryCalls.at(-1)).toBe(LIVE_SESSION_ID);
      expect(container.textContent).toContain('live-agent');
      expect(container.textContent).not.toContain('column-agent');
    } finally {
      await cleanup();
    }
  });
});
