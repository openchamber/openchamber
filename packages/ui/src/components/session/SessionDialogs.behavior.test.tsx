import React, { act } from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Session } from '@opencode-ai/sdk/v2';
import type { WorktreeMetadata } from '@/types/worktree';

// React detects input-event support when its DOM renderer is first imported.
// Give that probe a document, then restore the caller's globals immediately.
const rendererWindow = new Window();
const rendererGlobals = ['window', 'document'] as const;
const previousRendererGlobals = rendererGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, 'window', { value: rendererWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: rendererWindow.document, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
for (const [name, descriptor] of previousRendererGlobals) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
rendererWindow.close();

// SAFETY: The dialog consumes only id/title from session records for this flow.
const sessionOne = { id: 'session-1', title: 'First session' } as Session;
// SAFETY: The dialog consumes only id/title from session records for this flow.
const sessionTwo = { id: 'session-2', title: 'Second session' } as Session;
// SAFETY: The dialog consumes path/branch/label plus optional status from this fixture.
const worktree = {
  path: '/repo/worktrees/feature',
  projectDirectory: '/repo',
  branch: 'feature',
  label: 'feature',
} as WorktreeMetadata;

type SessionCalls = {
  archive: string[][];
  delete: string[][];
  remove: string[];
  sequence: string[];
};

type DeleteSessionsResult = {
  deletedIds: string[];
  failedIds: string[];
};

type ArchiveSessionsResult = {
  archivedIds: string[];
  failedIds: string[];
};

const calls: SessionCalls = {
  archive: [],
  delete: [],
  remove: [],
  sequence: [],
};
let deleteResult: DeleteSessionsResult = { deletedIds: [], failedIds: [] };
let archiveResult: ArchiveSessionsResult = { archivedIds: [], failedIds: [] };

const getWorktreeMetadata = (sessionId: string): WorktreeMetadata | null =>
  sessionId === sessionOne.id || sessionId === sessionTwo.id ? worktree : null;

const sessionUIState = {
  getWorktreeMetadata,
  newSessionDraft: null,
  setNewSessionDraftTarget: () => undefined,
  setDraftBootstrapPendingDirectory: () => undefined,
  deleteSessions: async (ids: string[]) => {
    calls.delete.push(ids);
    calls.sequence.push('delete');
    return deleteResult;
  },
  archiveSessions: async (ids: string[]) => {
    calls.archive.push(ids);
    calls.sequence.push('archive');
    return archiveResult;
  },
};

const directoryState = {
  currentDirectory: '/repo/worktrees/feature',
  homeDirectory: '/home/user',
  isHomeReady: true,
  setDirectory: () => undefined,
};

const projectsState = {
  projects: [{ id: 'project-1', path: '/repo' }],
  activeProjectId: 'project-1',
};

const uiState = {
  showDeletionDialog: true,
  setShowDeletionDialog: () => undefined,
};

const passthrough = ({ children }: React.PropsWithChildren) => <div>{children}</div>;

mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));
mock.module('@/components/ui', () => ({
  toast: { loading: () => 'toast-id', success: () => undefined, error: () => undefined },
}));
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: React.PropsWithChildren<{ open: boolean }>) => (open ? <>{children}</> : null),
  DialogContent: passthrough,
  DialogHeader: passthrough,
  DialogTitle: passthrough,
  DialogDescription: passthrough,
  DialogFooter: passthrough,
}));
mock.module('@/components/ui/MobileOverlayPanel', () => ({
  MobileOverlayPanel: ({ children, open }: React.PropsWithChildren<{ open: boolean }>) => (open ? <div>{children}</div> : null),
}));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('./DirectoryExplorerDialog', () => ({ DirectoryExplorerDialog: () => null }));
const actualWorktreeStatus = await import('@/lib/worktrees/worktreeStatus');
mock.module('@/lib/worktrees/worktreeStatus', () => ({
  ...actualWorktreeStatus,
  getWorktreeStatus: async () => ({ isDirty: false, ahead: 0, behind: 0, upstream: null }),
}));
const actualWorktreeManager = await import('@/lib/worktrees/worktreeManager');
mock.module('@/lib/worktrees/worktreeManager', () => ({
  ...actualWorktreeManager,
  getWorktreeDisplayName: () => 'feature',
  removeProjectWorktree: async () => {
    calls.remove.push('remove');
    calls.sequence.push('remove');
  },
}));
const actualSessionActions = await import('@/sync/session-actions');
mock.module('@/sync/session-actions', () => ({
  ...actualSessionActions,
  deleteSession: async () => true,
}));
const actualSessionUIStore = await import('@/sync/session-ui-store');
mock.module('@/sync/session-ui-store', () => ({
  ...actualSessionUIStore,
  useSessionUIStore: <T,>(selector: (state: typeof sessionUIState) => T): T => selector(sessionUIState),
}));
const actualDirectoryStore = await import('@/stores/useDirectoryStore');
mock.module('@/stores/useDirectoryStore', () => ({
  ...actualDirectoryStore,
  useDirectoryStore: Object.assign(
    <T,>(selector: (state: typeof directoryState) => T): T => selector(directoryState),
    { getState: () => directoryState },
  ),
}));
const actualProjectsStore = await import('@/stores/useProjectsStore');
mock.module('@/stores/useProjectsStore', () => ({
  ...actualProjectsStore,
  useProjectsStore: <T,>(selector: (state: typeof projectsState) => T): T => selector(projectsState),
}));
const actualUIStore = await import('@/stores/useUIStore');
mock.module('@/stores/useUIStore', () => ({
  ...actualUIStore,
  useUIStore: <T,>(selector: (state: typeof uiState) => T): T => selector(uiState),
}));
const actualDevice = await import('@/lib/device');
mock.module('@/lib/device', () => ({
  ...actualDevice,
  useDeviceInfo: () => ({ isMobile: false, isTablet: false, hasTouchInput: false }),
}));

const { SessionDialogs } = await import('./SessionDialogs');
const { I18nProvider } = await import('@/lib/i18n');
const { sessionEvents } = await import('@/lib/sessionEvents');

const DOM_GLOBAL_NAMES = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLButtonElement',
  'KeyboardEvent',
  'Event',
  'localStorage',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

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
    HTMLButtonElement: happyWindow.HTMLButtonElement,
    KeyboardEvent: happyWindow.KeyboardEvent,
    Event: happyWindow.Event,
    localStorage: happyWindow.localStorage,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
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
      happyWindow.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

const flushAsyncWork = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const getRadio = (container: HTMLElement, label: string): HTMLButtonElement | null =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    .find((radio) => radio.getAttribute('aria-label') === label) ?? null;

const getConfirmButton = (container: HTMLElement): HTMLButtonElement | null =>
  [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent === 'Delete worktree') ?? null;

const withDialog = async (sessions: Session[], run: (dom: ReturnType<typeof installDom>) => Promise<void>) => {
  const dom = installDom();
  const root = createRoot(dom.container);
  try {
    await act(async () => root.render(<I18nProvider><SessionDialogs /></I18nProvider>));
    await act(async () => {
      sessionEvents.requestDelete({ sessions, mode: 'worktree', worktree });
    });
    await flushAsyncWork();
    await run(dom);
  } finally {
    await act(async () => root.unmount());
    dom.restore();
  }
};

describe('SessionDialogs worktree session disposition', () => {
  beforeEach(() => {
    calls.archive = [];
    calls.delete = [];
    calls.remove = [];
    calls.sequence = [];
    deleteResult = { deletedIds: [], failedIds: [] };
    archiveResult = { archivedIds: [], failedIds: [] };
  });

  test('defaults to archiving linked sessions and archives before removing the worktree', async () => {
    await withDialog([sessionOne, sessionTwo], async (dom) => {
      const archiveRadio = getRadio(dom.container, 'Archive linked sessions');
      const deleteRadio = getRadio(dom.container, 'Delete linked sessions permanently');
      expect(archiveRadio?.getAttribute('aria-checked')).toBe('true');
      expect(deleteRadio?.getAttribute('aria-checked')).toBe('false');
      expect(dom.container.textContent).toContain('This removes the selected worktree and archives 2 linked sessions.');

      const confirm = getConfirmButton(dom.container);
      expect(confirm).not.toBeNull();
      await act(async () => {
        confirm?.click();
      });
      await flushAsyncWork();

      expect(calls.sequence).toEqual(['archive', 'remove']);
      expect(calls.archive).toEqual([['session-1', 'session-2']]);
      expect(calls.delete).toEqual([]);
    });
  });

  test('deleting linked sessions is opt-in and runs before removing the worktree', async () => {
    await withDialog([sessionOne, sessionTwo], async (dom) => {
      const deleteRadio = getRadio(dom.container, 'Delete linked sessions permanently');
      expect(deleteRadio).not.toBeNull();
      await act(async () => {
        deleteRadio?.click();
      });
      expect(deleteRadio?.getAttribute('aria-checked')).toBe('true');
      expect(dom.container.textContent).toContain('This removes the selected worktree and permanently deletes 2 linked sessions.');

      const confirm = getConfirmButton(dom.container);
      await act(async () => {
        confirm?.click();
      });
      await flushAsyncWork();

      expect(calls.sequence).toEqual(['delete', 'remove']);
      expect(calls.delete).toEqual([['session-1', 'session-2']]);
      expect(calls.archive).toEqual([]);
    });
  });

  test('a failed permanent delete keeps the worktree', async () => {
    deleteResult = { deletedIds: [], failedIds: ['session-2'] };
    await withDialog([sessionOne, sessionTwo], async (dom) => {
      await act(async () => {
        getRadio(dom.container, 'Delete linked sessions permanently')?.click();
      });
      await act(async () => {
        getConfirmButton(dom.container)?.click();
      });
      await flushAsyncWork();

      expect(calls.sequence).toEqual(['delete']);
      expect(calls.remove).toEqual([]);
    });
  });

  test('a failed archive keeps the worktree', async () => {
    archiveResult = { archivedIds: [], failedIds: ['session-2'] };
    await withDialog([sessionOne, sessionTwo], async (dom) => {
      await act(async () => {
        getConfirmButton(dom.container)?.click();
      });
      await flushAsyncWork();

      expect(calls.sequence).toEqual(['archive']);
      expect(calls.remove).toEqual([]);
    });
  });

  test('worktrees without linked sessions keep the unchanged removal flow', async () => {
    await withDialog([], async (dom) => {
      expect(dom.container.querySelector('[role="radiogroup"]')).toBeNull();
      expect(dom.container.textContent).toContain('This removes the selected worktree.');

      await act(async () => {
        getConfirmButton(dom.container)?.click();
      });
      await flushAsyncWork();

      expect(calls.sequence).toEqual(['remove']);
      expect(calls.archive).toEqual([]);
      expect(calls.delete).toEqual([]);
    });
  });
});
