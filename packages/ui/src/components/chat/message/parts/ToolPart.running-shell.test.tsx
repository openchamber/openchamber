import { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { ToolPart as ToolPartData } from '@/lib/opencode/model';
import type { SyncEvent } from '@/lib/opencode/events';
import { opencodeClient } from '@/lib/opencode/client';
import { SyncProvider } from '@/sync/sync-context';
import { applyBackgroundShellEvents, backgroundShellRevision, replaceDirectoryShells, resetBackgroundShells, useBackgroundShellsStore } from '@/sync/background-shells';
import { I18nProvider } from '@/lib/i18n';
import { toast } from '@/components/ui';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

// Bun does not implement Vite's worker asset-query imports.
plugin({
  name: 'tool-running-shell-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});

const { default: ToolPart } = await import('./ToolPart');

const unexpectedThemeChange = (): never => { throw new Error('Rendering must not change the theme'); };
const theme = getDefaultTheme(false);
const themeContext: ThemeContextValue = {
  currentTheme: theme,
  availableThemes: [theme],
  setTheme: unexpectedThemeChange,
  customThemesLoading: false,
  reloadCustomThemes: unexpectedThemeChange,
  importTheme: unexpectedThemeChange,
  deleteImportedTheme: unexpectedThemeChange,
  customThemeIds: [],
  isSystemPreference: false,
  setSystemPreference: unexpectedThemeChange,
  themeMode: 'light',
  setThemeMode: unexpectedThemeChange,
  lightThemeId: theme.metadata.id,
  darkThemeId: getDefaultTheme(true).metadata.id,
  setLightThemePreference: unexpectedThemeChange,
  setDarkThemePreference: unexpectedThemeChange,
};

type Render = (part: ToolPartData, isExpanded?: boolean) => Promise<void>;

const withHarness = async (run: (render: Render, container: HTMLElement) => Promise<void>) => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const globals = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    localStorage: happyWindow.localStorage,
    customElements: happyWindow.customElements,
    Node: happyWindow.Node,
    Text: happyWindow.Text,
    NodeList: happyWindow.NodeList,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    SVGElement: happyWindow.SVGElement,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
    ResizeObserver: happyWindow.ResizeObserver,
    MutationObserver: happyWindow.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const sdk = OpenCode.make({
    baseUrl: 'http://localhost',
    fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }),
  });

  const render: Render = async (part, isExpanded = true) => {
    await act(async () => {
      root.render(
        <SyncProvider sdk={sdk} directory="/workspace">
          <I18nProvider>
            <ThemeSystemContext.Provider value={themeContext}>
              <ToolPart part={part} isExpanded={isExpanded} isMobile={false} onToggle={() => {}} />
            </ThemeSystemContext.Provider>
          </I18nProvider>
        </SyncProvider>,
      );
    });
    // Let the read settle and the streaming throttle commit it.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
  };

  const previousDirectory = useDirectoryStore.getState().currentDirectory;
  try {
    useDirectoryStore.setState({ currentDirectory: '/workspace' });
    await run(render, container);
  } finally {
    useDirectoryStore.setState({ currentDirectory: previousDirectory });
    resetBackgroundShells();
    await act(async () => { root.unmount(); });
    await happyWindow.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

// OpenCode's only progress update for a running shell call carries the command's id.
const running: ToolPartData = {
  id: 'prt_ticks', sessionID: 'ses_ticks', messageID: 'msg_ticks',
  type: 'tool', tool: 'shell', callID: 'call_ticks',
  state: { status: 'running', input: { command: 'ticks' }, metadata: { shellID: 'sh_ticks' }, time: { start: 1 } },
};
const tracked = { id: 'sh_ticks', sessionID: 'ses_ticks', command: 'ticks', file: '/tmp/sh_ticks', startedAt: 1 };

test('an expanded shell call the turn waits for shows the command output while it runs', async () => {
  useBackgroundShellsStore.setState({ byId: new Map([['sh_ticks', { ...tracked, directory: '/repo', background: false }]]) });
  const read = spyOn(opencodeClient, 'readShellOutput').mockResolvedValue({ output: 'tick 1 / 15\ntick 2 / 15\n', cursor: 24, skipped: false });
  try {
    await withHarness(async (render, container) => {
      // A collapsed row shows no output, so it reads nothing.
      await render(running, false);
      expect(read.mock.calls).toHaveLength(0);

      await render(running);
      expect(read.mock.calls[0]).toEqual(['sh_ticks', '/repo', undefined]);
      expect(container.textContent).toContain('tick 2 / 15');

      await render({
        ...running,
        state: { status: 'completed', input: { command: 'ticks' }, output: 'tick 1 / 15\ntick 2 / 15\ntick 3 / 15', metadata: { exit: 0 }, time: { start: 1, end: 3 } },
      });
      expect(container.textContent).toContain('tick 3 / 15');
    });
  } finally {
    read.mockRestore();
  }
});

// One command per test: a stop that went through keeps its command marked.
const stoppable = (shellID: string) => {
  const call: ToolPartData = {
    ...running,
    state: { status: 'running', input: { command: 'ticks' }, metadata: { shellID }, time: { start: 1 } },
  };
  // What OpenCode sends when `session.background` moved the call: it settles
  // at once, still running, with the same command id.
  const settledInBackground: SyncEvent = {
    type: 'message.tool.transition',
    properties: {
      sessionID: 'ses_ticks', messageID: 'msg_ticks', partID: 'prt_ticks',
      transition: { kind: 'success', output: '', metadata: { status: 'running', shellID }, executed: true, end: 2 },
    },
  };
  const backgroundPart: ToolPartData = {
    ...running,
    state: {
      status: 'completed', input: { command: 'ticks' }, output: `Command moved to the background (shell ID: ${shellID}).`,
      metadata: { status: 'running', shellID }, time: { start: 1, end: 2 },
    },
  };
  // A command first seen in a list reads as background while its call still waits.
  replaceDirectoryShells('/repo', [{ ...tracked, id: shellID }], backgroundShellRevision());
  return { call, settledInBackground, backgroundPart };
};
const stopButton = (container: HTMLElement) => container.querySelector('button[aria-label="Stop command"]');

const clickStop = async (container: HTMLElement) => {
  const button = stopButton(container);
  if (!(button instanceof HTMLElement)) throw new Error('Stop action is missing');
  await act(async () => { button.click(); });
};

test('a shell call the turn waits for stops through the background, after a reload too', async () => {
  const { call, settledInBackground, backgroundPart } = stoppable('sh_stop');
  const background = spyOn(opencodeClient, 'backgroundSessionWork').mockResolvedValue(undefined);
  const stop = spyOn(opencodeClient, 'stopBackgroundShells').mockResolvedValue(undefined);
  const read = spyOn(opencodeClient, 'readShellOutput').mockResolvedValue({ output: '', cursor: 0, skipped: false });
  try {
    await withHarness(async (render, container) => {
      await render(call, false);
      await clickStop(container);
      expect(background.mock.calls).toEqual([['ses_ticks', '/workspace']]);
      expect(stopButton(container)).toBeNull();
      // Nothing is stopped before the call settled in the background.
      expect(stop).not.toHaveBeenCalled();

      // The call settles; the row becomes the background row.
      await act(async () => { applyBackgroundShellEvents('/repo', [settledInBackground]); });
      await render(backgroundPart, false);
      expect(stop.mock.calls).toEqual([[{
        sessionID: 'ses_ticks', sessionDirectory: '/workspace',
        shells: [{ shellID: 'sh_stop', shellDirectory: '/repo', command: 'ticks' }],
      }]]);
      expect(container.textContent).toContain('in background');
      expect(stopButton(container)).toBeNull();
    });
  } finally {
    background.mockRestore();
    stop.mockRestore();
    read.mockRestore();
  }
});

test('a failed stop says so and the background row offers its own Stop again', async () => {
  const { call, settledInBackground, backgroundPart } = stoppable('sh_stop_fails');
  const background = spyOn(opencodeClient, 'backgroundSessionWork').mockResolvedValue(undefined);
  const stop = spyOn(opencodeClient, 'stopBackgroundShells').mockRejectedValue(new Error('offline'));
  const read = spyOn(opencodeClient, 'readShellOutput').mockResolvedValue({ output: '', cursor: 0, skipped: false });
  const error = spyOn(toast, 'error');
  try {
    await withHarness(async (render, container) => {
      await render(call, false);
      await clickStop(container);
      await act(async () => { applyBackgroundShellEvents('/repo', [settledInBackground]); });
      await render(backgroundPart, false);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(error.mock.calls).toEqual([["Couldn't stop the command"]]);
      expect(stopButton(container)).not.toBeNull();
    });
  } finally {
    background.mockRestore();
    stop.mockRestore();
    read.mockRestore();
    error.mockRestore();
  }
});

test('a failed move to the background stops nothing and brings the Stop back', async () => {
  const { call } = stoppable('sh_move_fails');
  const background = spyOn(opencodeClient, 'backgroundSessionWork').mockRejectedValue(new Error('offline'));
  const stop = spyOn(opencodeClient, 'stopBackgroundShells').mockResolvedValue(undefined);
  const error = spyOn(toast, 'error');
  try {
    await withHarness(async (render, container) => {
      await render(call, false);
      await clickStop(container);
      expect(stop).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(1);
      expect(stopButton(container)).not.toBeNull();
    });
  } finally {
    background.mockRestore();
    stop.mockRestore();
    error.mockRestore();
  }
});

test('a shell call whose command the index does not know offers no Stop', async () => {
  await withHarness(async (render, container) => {
    await render(running, false);
    expect(stopButton(container)).toBeNull();
  });
});
