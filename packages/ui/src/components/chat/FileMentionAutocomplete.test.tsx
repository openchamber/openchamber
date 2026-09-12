import React, { act } from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

/**
 * The mention picker's agent list must come from the directory scope its caller
 * hands in. A dialog passes `undefined` (ambient); the composer passes the
 * directory its send targets. Reading the live chat session here instead made
 * the picker disagree with the composer's column/btw scope.
 */

type DirectoryAgent = { name: string; description?: string; mode: string };

const SCOPE_DIRECTORY = '/scope/one';
const LIVE_SESSION_SCOPE = '/scope/live-session';

const directoryCalls: Array<string | null | undefined> = [];

const scopeAgents: DirectoryAgent[] = [
  { name: 'plan-scope', description: 'scope agent', mode: 'subagent' },
];
const liveSessionAgents: DirectoryAgent[] = [
  { name: 'plan-live', description: 'live session agent', mode: 'subagent' },
];
const ambientAgents: DirectoryAgent[] = [
  { name: 'plan-ambient', description: 'ambient agent', mode: 'subagent' },
];

const resolveAgents = (directory: string | null | undefined): DirectoryAgent[] => {
  if (directory === SCOPE_DIRECTORY) return scopeAgents;
  if (directory === LIVE_SESSION_SCOPE) return liveSessionAgents;
  return ambientAgents;
};

// Stable mock state: returning a fresh `searchFiles` function each render would
// make the component's search effect re-run forever.
type ProjectsState = { activeProjectId: string | null; projects: Array<{ id: string; path: string }> };
type FilesViewTabsState = { byRoot: Record<string, undefined> };
type FileSearchState = { searchFiles: () => Promise<never[]> };
type UIState = { isMobile: boolean };

const projectsState: ProjectsState = { activeProjectId: null, projects: [] };
const filesViewTabsState: FilesViewTabsState = { byRoot: {} };
const fileSearchState: FileSearchState = { searchFiles: async () => [] };
const uiState: UIState = { isMobile: false };

mock.module('@/hooks/useVisibleAgentsForDirectory', () => ({
  useVisibleAgentsForDirectory: (directory: string | null | undefined) => {
    directoryCalls.push(directory);
    return resolveAgents(directory);
  },
  // A regression that reintroduces the live-session read would resolve through
  // this scope instead of the prop, and the rendered list would say so.
  useComposerAgentDirectory: () => LIVE_SESSION_SCOPE,
}));
mock.module('@/hooks/useChatSearchDirectory', () => ({ useChatSearchDirectory: () => null }));
mock.module('@/hooks/useDebouncedValue', () => ({ useDebouncedValue: (value: string) => value }));
mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: <T,>(selector: (state: ProjectsState) => T): T => selector(projectsState),
}));
mock.module('@/stores/useFilesViewTabsStore', () => ({
  useFilesViewTabsStore: <T,>(selector: (state: FilesViewTabsState) => T): T => selector(filesViewTabsState),
}));
mock.module('@/stores/useFileSearchStore', () => ({
  useFileSearchStore: <T,>(selector: (state: FileSearchState) => T): T => selector(fileSearchState),
}));
mock.module('@/stores/useUIStore', () => ({
  useUIStore: <T,>(selector: (state: UIState) => T): T => selector(uiState),
}));
mock.module('@/lib/directoryShowHidden', () => ({ useDirectoryShowHidden: () => false }));
mock.module('@/lib/filesViewShowGitignored', () => ({ useFilesViewShowGitignored: () => false }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/ui/ScrollableOverlay', () => ({
  ScrollableOverlay: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));
mock.module('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  TooltipContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));
mock.module('./useMobileAutocompleteMaxHeight', () => ({ useMobileAutocompleteMaxHeight: () => undefined }));

const { FileMentionAutocomplete } = await import('./FileMentionAutocomplete');

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
  happyWindow.HTMLElement.prototype.scrollIntoView = () => {};
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

const renderAutocomplete = async (directory?: string | null) => {
  const dom = installDom();
  const root = createRoot(dom.container);
  await act(async () => root.render(
    <FileMentionAutocomplete
      searchQuery="plan"
      directory={directory}
      onFileSelect={() => {}}
      onAgentSelect={() => {}}
      onClose={() => {}}
    />,
  ));
  return {
    container: dom.container,
    cleanup: async () => {
      await act(async () => root.unmount());
      dom.restore();
    },
  };
};

describe('FileMentionAutocomplete agent scope', () => {
  beforeEach(() => {
    directoryCalls.length = 0;
  });

  test('the directory prop drives the subagent list, not the live session', async () => {
    const { container, cleanup } = await renderAutocomplete(SCOPE_DIRECTORY);
    try {
      expect(directoryCalls).toContain(SCOPE_DIRECTORY);
      expect(container.textContent).toContain('@plan-scope');
      expect(container.textContent).not.toContain('@plan-live');
      expect(container.textContent).not.toContain('@plan-ambient');
    } finally {
      await cleanup();
    }
  });

  test('an undefined directory keeps the ambient list for dialogs', async () => {
    const { container, cleanup } = await renderAutocomplete(undefined);
    try {
      expect(directoryCalls).toContain(undefined);
      expect(container.textContent).toContain('@plan-ambient');
      expect(container.textContent).not.toContain('@plan-scope');
    } finally {
      await cleanup();
    }
  });
});
