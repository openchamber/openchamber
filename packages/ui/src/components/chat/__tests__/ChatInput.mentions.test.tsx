import { afterAll, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import type { RuntimeAPIs } from '@/lib/api/types';
import type { Session } from '@/lib/opencode/model';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  ...Object.fromEntries(([
    'Window', 'Node', 'Text', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement',
    'HTMLFormElement', 'Range', 'Selection', 'DocumentFragment', 'Event', 'KeyboardEvent',
    'MouseEvent', 'FocusEvent', 'InputEvent', 'CustomEvent', 'MutationObserver',
    'ResizeObserver', 'IntersectionObserver', 'HTMLDivElement', 'HTMLSpanElement',
    'SVGElement', 'ShadowRoot', 'CSSStyleSheet', 'DOMParser',
  ] satisfies (keyof Window)[]).map((name) => [name, browser[name]])),
  matchMedia: browser.matchMedia.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  customElements: browser.customElements, IS_REACT_ACT_ENVIRONMENT: true,
});

const DIRECTORY = '/mention-fixture';
const skillRequests: string[] = [];
let liveSessions: Session[] = [];
const location = { directory: DIRECTORY, project: { id: 'project', directory: DIRECTORY, canonical: DIRECTORY } };
// External catalogs and backend data are isolated; composer/editor/picker modules are real.
const responseFor = (input: RequestInfo | URL) => {
  const path = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost/').pathname;
  if (path === '/api/config/settings') return Response.json({ projects: [{ id: 'project', path: DIRECTORY }] });
  if (path === '/api/config/skills') {
    const url = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost/');
    const directory = url.searchParams.get('directory') ?? '';
    skillRequests.push(directory);
    const name = directory === DIRECTORY ? 'root-skill' : 'folder-skill';
    return Response.json({ skills: [{ id: name, name, path: `${directory}/.opencode/skills/${name}/SKILL.md`, scope: 'project' }] });
  }
  if (path.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
  if (path.endsWith('/location')) return Response.json(location);
  if (path.endsWith('/session/active')) return Response.json({ data: {} });
  if (path === '/api/session') return Response.json({
    location,
    data: liveSessions.map((record) => ({ ...record, location: { directory: record.directory } })),
    cursor: {},
  });
  if (path === '/api/config') return Response.json([]);
  if (path === '/api/project') return Response.json([]);
  if (path.endsWith('/vcs')) return Response.json({ data: { branch: { current: 'main', default: 'main' } } });
  if (path.endsWith('/session-warming')) return Response.json({ revision: 0, enabled: false, minutes: 60, sessions: [] });
  return Response.json({ location, data: [] });
};
spyOn(globalThis, 'fetch').mockImplementation(async (input) => responseFor(input));

// Match the Vite-only import transforms in the sibling real-composer tests.
plugin({
  name: 'composer-mentions-vite-modules',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, () => ({ contents: 'export default "";', loader: 'js' }));
    build.onLoad({ filter: /useProviderLogo\.ts$/ }, ({ path }) => {
      const directory = resolve(dirname(path), '../assets/provider-logos');
      const logos = Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith('.svg')).map((name) => [
        `../assets/provider-logos/${name}`, pathToFileURL(resolve(directory, name)).href,
      ]));
      return { contents: readFileSync(path, 'utf8').replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`), loader: 'ts' };
    });
  },
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { EditorView } = await import('@codemirror/view');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { ChatInput } = await import('../ChatInput');
const { SyncProvider } = await import('@/sync/sync-context');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { useFileSearchStore } = await import('@/stores/useFileSearchStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { writeChatDraft } = await import('@/lib/chatDraftPersistence');
const { getRuntimeKey } = await import('@/lib/runtime-switch');
const { OpenCode } = await import('@opencode/client');
const { opencodeClient } = await import('@/lib/opencode/client');
const { useCommandsStore, invalidateCommandsLoadCache } = await import('@/stores/useCommandsStore');
const { useSkillsStore, invalidateSkillsLoadCache } = await import('@/stores/useSkillsStore');
const { ChatColumnSessionContext, ChatColumnActionsContext } = await import('../chatColumnSession');
const { getSyncChildStores } = await import('@/sync/sync-refs');
const { rememberEffort } = await import('@/lib/modelEfforts');
const { useUIStore } = await import('@/stores/useUIStore');
const { useMessageQueueStore, getMessageQueueKey } = await import('@/stores/messageQueueStore');
const attachmentInput = await import('@/sync/input-store');
const { setOptimisticRefs } = await import('@/sync/session-actions');

const sdk = OpenCode.make({ baseUrl: 'https://sync.test', fetch: async (request) => responseFor(request) });
// SAFETY: Same minimal offline runtime as sibling composer integration tests.
const runtimeAPIs = { runtime: { platform: 'web', isDesktop: false, isVSCode: false }, sourceControl: {} } as RuntimeAPIs;
const session = (id: string, title: string, archived = false): Session => ({
  id, title, directory: DIRECTORY, projectID: 'project', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 1, archived: archived ? 1 : undefined },
});
const review = session('ses_coder_review', 'coder review');
const overlap = session('ses_title_match', '清理zencoder/skills废弃文件夹', true);

const settle = async () => act(async () => {
  // The real picker debounces its external file search by 180ms and animates exit.
  await new Promise((resolve) => setTimeout(resolve, 260));
});

type Composer = {
  sessionId: string;
  container: HTMLDivElement;
  view: InstanceType<typeof EditorView>;
  type: (text: string) => Promise<void>;
  key: (key: string) => Promise<void>;
  rows: () => HTMLElement[];
  choose: (text: string) => Promise<void>;
};

let composerCount = 0;
const withComposer = async (run: (composer: Composer) => Promise<void>, options?: { startDirectory: string | null; pinned?: boolean; column?: boolean }) => {
  useProjectsStore.setState({ projects: [{ id: 'project', path: DIRECTORY }] });
  const sessionId = `ses_composer_${++composerCount}`;
  useDirectoryStore.setState({ currentDirectory: DIRECTORY });
  useSessionUIStore.setState({
    currentSessionId: options ? null : sessionId,
    currentSessionDirectory: DIRECTORY,
    newSessionDraft: {
      ...useSessionUIStore.getState().newSessionDraft,
      open: Boolean(options && !options.column), draftId: composerCount, target: 'project', parentID: null,
      selectedProjectId: null, directoryOverride: DIRECTORY, bootstrapPendingDirectory: null,
      worktreeStartDirectory: options ? { worktreeRoot: DIRECTORY, directory: options.startDirectory } : null,
    },
  });
  useConfigStore.setState({
    currentProviderId: 'provider', currentModelId: 'model', isConnected: true, hasEverConnected: true,
    agents: [{
      id: 'coder', name: 'coder', displayName: 'coder', mode: 'subagent', description: 'Synthetic coder',
      hidden: false, permissions: [], request: { settings: {}, headers: {}, body: {} },
    }],
  });
  useFileSearchStore.setState({ searchFiles: async () => [] });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <RuntimeAPIContext.Provider value={runtimeAPIs}><ThemeSystemProvider><I18nProvider>
        <SyncProvider sdk={sdk} directory={DIRECTORY}>
          <ChatColumnSessionContext.Provider value={options?.pinned || options?.column ? { sessionId, directory: DIRECTORY } : null}>
            <ChatColumnActionsContext.Provider value={{ pinned: Boolean(options?.pinned), openSession: () => {}, openTimelineDialog: () => {}, focusInput: () => {} }}>
              <ChatInput />
            </ChatColumnActionsContext.Provider>
          </ChatColumnSessionContext.Provider>
        </SyncProvider>
      </I18nProvider></ThemeSystemProvider></RuntimeAPIContext.Provider>,
    ));
    await settle();
    await act(async () => useGlobalSessionsStore.getState().applySnapshot([], [review, overlap]));
    const content = container.querySelector<HTMLElement>('.cm-content');
    const view = content && EditorView.findFromDOM(content);
    if (!view || !content) throw new Error('The real composer editor did not mount');
    const rows = () => Array.from(container.querySelectorAll<HTMLElement>('.cursor-pointer.typography-ui-label'));
    setOptimisticRefs(() => {}, () => {});
    await run({
      sessionId, container, view, rows,
      type: async (text) => {
        for (const character of text) {
          await act(async () => view.dispatch({
            changes: { from: view.state.selection.main.from, to: view.state.selection.main.to, insert: character },
            selection: { anchor: view.state.selection.main.from + character.length }, userEvent: 'input.type',
          }));
        }
        await settle();
      },
      key: async (key) => {
        await act(async () => content.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
        await settle();
      },
      choose: async (text) => {
        const row = rows().find((row) => row.textContent?.includes(text));
        if (!row) throw new Error(`Missing actual picker result: ${text}`);
        await act(async () => row.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await settle();
      },
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
};

afterAll(() => browser.close());

test('a picker choice during attachment preparation survives the composer send', async () => {
  const originalFetch = globalThis.fetch;
  const send = spyOn(opencodeClient, 'sendMessage').mockResolvedValue('msg');
  // FileReader is browser-owned; the mention read and composer submit stay real.
  const prepare = spyOn(attachmentInput, 'prepareLocalAttachments').mockImplementation(async (file) => [{
    id: 'shot', file, filename: file.name, mimeType: 'image/png', size: file.size,
    dataUrl: 'data:image/png;base64,c2hvdA==', source: 'local',
  }]);
  let release!: (response: Response) => void;
  let started!: () => void;
  const preparing = new Promise<void>((resolve) => { started = resolve; });
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('/api/fs/raw')) {
      started();
      return new Promise<Response>((resolve) => { release = resolve; });
    }
    return originalFetch(input, init);
  };
  try {
    await withComposer(async ({ container, type, choose }) => {
      useFileSearchStore.setState({ searchFiles: async () => [{ name: 'shot.png', path: `${DIRECTORY}/shot.png`, relativePath: 'shot.png' }] });
      await type('@shot');
      await choose('shot.png');
      await act(async () => {
        useConfigStore.setState({ currentVariant: 'low' });
        rememberEffort('provider', 'model', 'low');
      });
      await act(async () => {
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await preparing;
        rememberEffort('provider', 'model', 'high');
        release(new Response('image bytes'));
      });
      await settle();
      expect(send.mock.calls.length).toBe(1);
      expect(send.mock.calls[0]?.[0].model?.variant).toBe('low');
      expect(useUIStore.getState().lastUsedEfforts['provider/model']).toBe('high');
    });
  } finally {
    globalThis.fetch = originalFetch;
    prepare.mockRestore();
    send.mockRestore();
  }
});

test('the queued row Send preserves the newer remembered effort', async () => {
  const send = spyOn(opencodeClient, 'sendMessage').mockResolvedValue('msg');
  const queued = { id: 'queued-effort', content: 'queued low', text: 'queued low', createdAt: 1, sendConfig: { providerID: 'provider', modelID: 'model', variant: 'low' } };
  const take = spyOn(useMessageQueueStore.getState(), 'takeForSend').mockResolvedValue([queued]);
  try {
    await withComposer(async ({ sessionId, container }) => {
      await act(async () => {
        rememberEffort('provider', 'model', 'high');
        const key = getMessageQueueKey({ runtimeKey: getRuntimeKey(), directory: DIRECTORY, sessionId });
        useMessageQueueStore.setState({ queuedMessages: { [key]: [queued] } });
      });
      const group = container.querySelector('[role="group"][aria-label="Queued messages"]');
      const button = Array.from(group?.querySelectorAll('button') ?? []).find((button) => button.textContent?.trim() === 'send');
      expect(button).toBeDefined();
      await act(async () => button!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await settle();
      expect(take.mock.calls.length).toBe(1);
      expect(send.mock.calls.length).toBe(1);
      expect(send.mock.calls[0]?.[0].model?.variant).toBe('low');
      expect(useUIStore.getState().lastUsedEfforts['provider/model']).toBe('high');
    });
  } finally {
    useMessageQueueStore.setState({ queuedMessages: {} });
    take.mockRestore();
    send.mockRestore();
  }
});

test('hand-typed @coder review keeps the session selectable even after coder becomes a chip', async () => {
  await withComposer(async ({ container, view, type, rows, choose }) => {
    await type('@coder ');
    expect(container.querySelector('[title="@coder"]')).not.toBeNull();
    await type('review');
    expect(view.state.doc.toString()).toBe('@coder review');
    expect(rows().some((row) => row.textContent?.includes(review.title))).toBe(true);
    await choose(review.title);
    expect(view.state.doc.toString()).toBe(`openchamber://session/${review.id} `);
    expect(container.querySelector(`[title="${review.title}"]`)).not.toBeNull();
    expect(rows().length).toBe(0);
  });
});

test('Enter completes an agent query before the next frame and later s/k cannot reopen it', async () => {
  await withComposer(async ({ container, view, type, key, rows }) => {
    await type('@cod');
    await key('Enter');
    expect(view.state.doc.toString()).toBe('@coder ');
    expect(container.querySelector('[title="@coder"]')).not.toBeNull();
    expect(rows().length).toBe(0);
    await type('s');
    expect(rows().length).toBe(0);
    await type('k');
    expect(view.state.doc.toString()).toBe('@coder sk');
    expect(rows().length).toBe(0);
  });
});

test('click completion survives Escape and ordinary text while fresh @ and reference edits still search', async () => {
  await withComposer(async ({ view, type, key, rows, choose }) => {
    await type('@cod');
    await choose('@coder');
    await key('Escape');
    await type('s');
    expect(rows().length).toBe(0);
    await type('k');
    expect(rows().length).toBe(0);
    await type(' @cod');
    expect(rows().some((row) => row.textContent?.startsWith('@coder'))).toBe(true);
    // An intentional edit of the first reference asks for completion again.
    await act(async () => view.dispatch({
      changes: { from: 5, to: 6 }, selection: { anchor: 5 }, userEvent: 'delete.backward',
    }));
    await settle();
    expect(view.state.doc.toString()).toBe('@code sk @cod');
    expect(rows().some((row) => row.textContent?.startsWith('@coder'))).toBe(true);
  });
});

test('Tab keeps its existing selection behavior and completes that occurrence', async () => {
  await withComposer(async ({ view, type, key, rows }) => {
    await type('@cod');
    await key('Tab');
    expect(view.state.doc.toString()).toBe('@coder ');
    await type('sk');
    expect(view.state.doc.toString()).toBe('@coder sk');
    expect(rows().length).toBe(0);
  });
});

const fileScenario = async (relativePath: string, directory: boolean, selectWithEnter: boolean) => {
  await withComposer(async ({ container, view, type, key, rows, choose }) => {
    const name = relativePath.split('/').filter(Boolean).pop() ?? relativePath;
    useFileSearchStore.setState({ searchFiles: async (_directory, _query, _limit, options) => (
      (options?.type === 'directory') === directory
        ? [{ name, path: `${DIRECTORY}/${relativePath}`, relativePath }]
        : []
    ) });
    useGlobalSessionsStore.getState().applySnapshot([], [session('ses_file_overlap', `${relativePath} skills`)]);
    await type('@des');
    if (selectWithEnter) {
      const index = rows().findIndex((row) => row.textContent?.includes(name));
      expect(index >= 0).toBe(true);
      for (let i = 0; i < index; i++) await key('ArrowDown');
      await key('Enter');
    } else await choose(name);
    expect(view.state.doc.toString()).toBe(`@${relativePath} `);
    expect(container.querySelector(`[title="@${relativePath}"]`)).not.toBeNull();
    expect(rows().length).toBe(0);
    await type('sk');
    expect(view.state.doc.toString()).toBe(`@${relativePath} sk`);
    expect(container.querySelector(`[title="@${relativePath}"]`)).not.toBeNull();
    expect(rows().length).toBe(0);
  });
};

test('clicking a file completes its query without changing the reference', async () => {
  await fileScenario('design.ts', false, false);
});

test('Enter on a directory completes its query without changing the reference', async () => {
  await fileScenario('design/', true, true);
});

test('a selected path containing spaces stays one reference after continuing prose', async () => {
  await fileScenario('design notes/overview.md', false, false);
});

test('completion follows text inserted before it and is removed with the reference', async () => {
  await withComposer(async ({ view, type, key, rows }) => {
    await type('@cod');
    await key('Enter');
    await act(async () => view.dispatch({ selection: { anchor: 0 } }));
    await type('Please ');
    await act(async () => view.dispatch({ selection: { anchor: view.state.doc.length } }));
    await type('sk');
    expect(view.state.doc.toString()).toBe('Please @coder sk');
    expect(rows().length).toBe(0);
    await act(async () => view.dispatch({ selection: { anchor: 7, head: view.state.doc.length } }));
    await type('@coder review');
    expect(rows().some((row) => row.textContent?.includes(review.title))).toBe(true);
  });
});

test('switching same-text composer documents clears completion without auto-opening a restored draft', async () => {
  await withComposer(async ({ sessionId, view, type, key, rows }) => {
    await type('@cod');
    await key('Enter');
    writeChatDraft({ runtimeKey: getRuntimeKey(), directory: DIRECTORY, sessionId: `${sessionId}_other` }, '@coder ', []);
    await act(async () => useSessionUIStore.setState({ currentSessionId: `${sessionId}_other`, currentSessionDirectory: DIRECTORY }));
    await settle();
    expect(view.state.doc.toString()).toBe('@coder ');
    expect(rows().length).toBe(0);
    await act(async () => view.dispatch({ selection: { anchor: view.state.doc.length } }));
    await type('review');
    expect(rows().some((row) => row.textContent?.includes(review.title))).toBe(true);
    await act(async () => useSessionUIStore.setState({ currentSessionId: sessionId, currentSessionDirectory: DIRECTORY }));
    await settle();
    expect(view.state.doc.toString()).toBe('@coder ');
    expect(rows().length).toBe(0);
  });
});

test('a pending worktree draft does no discovery, then commands, skills and files use its start folder', async () => {
  const commands = spyOn(opencodeClient, 'listCommands').mockImplementation(async () => [{ name: 'folder-command', description: 'Fixture command' }]);
  invalidateCommandsLoadCache();
  invalidateSkillsLoadCache(DIRECTORY);
  invalidateSkillsLoadCache(`${DIRECTORY}/ai`);
  useCommandsStore.setState({ commandsByDirectory: {} });
  useSkillsStore.setState({ skills: [], skillsByDirectory: {} });
  skillRequests.length = 0;
  const searches: string[] = [];
  try {
    await withComposer(async ({ view, type, key, rows }) => {
      expect(useSessionUIStore.getState().currentSessionId).toBeNull();
      expect(useSessionUIStore.getState().newSessionDraft.worktreeStartDirectory).toEqual({ worktreeRoot: DIRECTORY, directory: null });
      useFileSearchStore.setState({ searchFiles: async (directory) => { searches.push(directory); return []; } });
      await type('/folder');
      expect(rows().some((row) => row.textContent?.includes('folder-command'))).toBe(false);
      await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } }));
      await type('$root');
      expect(rows().some((row) => row.textContent?.includes('root-skill'))).toBe(false);
      await key('Escape');
      await type(' @file');
      expect(searches).toEqual([]);
      expect(commands.mock.calls).toEqual([]);
      expect(skillRequests).toEqual([]);
      await key('Escape');
      await act(async () => {
        const draft = useSessionUIStore.getState().newSessionDraft;
        useSessionUIStore.getState().setDraftWorktreeStartDirectory(draft.draftId, DIRECTORY, `${DIRECTORY}/ai`);
      });
      await settle();
      expect(commands.mock.calls.map(([directory]) => directory)).toEqual([`${DIRECTORY}/ai`]);
      expect(skillRequests).toEqual([`${DIRECTORY}/ai`]);
      await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } }));
      await type('/folder');
      expect(rows().some((row) => row.textContent?.includes('folder-command'))).toBe(true);
      await key('Escape');
      await type(' @file');
      expect(searches.length).toBeGreaterThan(0);
      expect(new Set(searches)).toEqual(new Set([`${DIRECTORY}/ai`]));
      await key('Escape');
      await type(' $folder');
      expect(rows().some((row) => row.textContent?.includes('folder-skill'))).toBe(true);
      expect(rows().some((row) => row.textContent?.includes('root-skill'))).toBe(false);
    }, { startDirectory: null });
  } finally {
    commands.mockRestore();
  }
});

for (const pinned of [false, true]) {
  test(pinned ? 'a pinned composer ignores the neighboring pending draft' : 'a root fallback is used by composer discovery', async () => {
    const commands = spyOn(opencodeClient, 'listCommands').mockImplementation(async () => []);
    invalidateCommandsLoadCache();
    invalidateSkillsLoadCache(DIRECTORY);
    useCommandsStore.setState({ commandsByDirectory: {} });
    useSkillsStore.setState({ skills: [], skillsByDirectory: {} });
    skillRequests.length = 0;
    const searches: string[] = [];
    try {
      await withComposer(async ({ type, rows }) => {
        useFileSearchStore.setState({ searchFiles: async (directory) => { searches.push(directory); return []; } });
        expect(commands.mock.calls.map(([directory]) => directory)).toEqual(pinned ? [] : [DIRECTORY]);
        expect(skillRequests).toEqual(pinned ? [] : [DIRECTORY]);
        await type('@file');
        expect(searches.length).toBeGreaterThan(0);
        expect(new Set(searches)).toEqual(new Set([DIRECTORY]));
        await type(' $root');
        expect(rows().some((row) => row.textContent?.includes('root-skill'))).toBe(true);
      }, { startDirectory: pinned ? null : DIRECTORY, pinned });
    } finally {
      commands.mockRestore();
    }
  });
}

for (const pinned of [false, true]) {
  for (const otherStore of [false, true]) {
    test(`a ${pinned ? 'pinned' : 'main'} column follows a session arriving in ${otherStore ? 'another' : 'its hinted'} live store`, async () => {
      const send = spyOn(useSessionUIStore.getState(), 'sendMessage').mockResolvedValue(undefined);
      const commands = spyOn(opencodeClient, 'listCommands').mockResolvedValue([{ name: 'folder-command', description: 'Fixture command' }]);
      const folder = `${DIRECTORY}/ai`;
      invalidateCommandsLoadCache();
      invalidateSkillsLoadCache(folder);
      useCommandsStore.setState({ commandsByDirectory: {} });
      useSkillsStore.setState({ skills: [], skillsByDirectory: {} });
      try {
        await withComposer(async ({ sessionId, container, view, type, key, choose, rows }) => {
          const searches: string[] = [];
          useFileSearchStore.setState({ searchFiles: async (directory) => { searches.push(directory); return []; } });
          await act(async () => {
            useSessionUIStore.setState({ worktreeMetadata: new Map([[sessionId, { path: DIRECTORY, projectDirectory: DIRECTORY, branch: 'test', label: 'test' }]]) });
          });
          await settle();
          await act(async () => {
            liveSessions = [{ ...session(sessionId, 'Folder session'), directory: folder }];
            const child = getSyncChildStores().ensureChild(otherStore ? folder : DIRECTORY, { bootstrap: false });
            child.setState({ session: liveSessions, sessionTotal: 1 });
          });
          await type('/folder');
          expect(rows().some((row) => row.textContent?.includes('folder-command'))).toBe(true);
          expect(commands.mock.calls.map(([directory]) => directory)).toEqual([folder]);
          await key('Escape');
          await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } }));
          await type('@file');
          expect(searches.length).toBeGreaterThan(0);
          expect(new Set(searches)).toEqual(new Set([folder]));
          await key('Escape');
          await type(' $folder');
          await choose('folder-skill');
          expect(container.querySelector('[title="$folder-skill"]')).not.toBeNull();
          await key('Enter');
          expect(send.mock.calls.length).toBe(1);
          expect(send.mock.calls[0]?.[9]?.skills?.names).toEqual(['folder-skill']);
        }, { startDirectory: null, pinned, column: true });
      } finally {
        liveSessions = [];
        send.mockRestore();
        commands.mockRestore();
      }
    });
  }
}

test('opening an existing composer leaves command and skill discovery lazy', async () => {
  const commands = spyOn(opencodeClient, 'listCommands').mockResolvedValue([]);
  invalidateCommandsLoadCache();
  invalidateSkillsLoadCache(DIRECTORY);
  useCommandsStore.setState({ commandsByDirectory: {} });
  useSkillsStore.setState({ skills: [], skillsByDirectory: {} });
  skillRequests.length = 0;
  try {
    await withComposer(async ({ type }) => {
      expect(commands.mock.calls).toEqual([]);
      expect(skillRequests).toEqual([]);
      await type('/fixture');
      expect(commands.mock.calls.map(([directory]) => directory)).toEqual([DIRECTORY]);
      expect(skillRequests).toEqual([]);
    });
  } finally {
    commands.mockRestore();
  }
});
