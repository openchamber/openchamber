import { expect, spyOn, test } from 'bun:test';
import { OpenCode } from '@opencode/client';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { opencodeClient } from '@/lib/opencode/client';
import { useComposerSelection } from '@/components/chat/composer/input/useComposerSelection';
import { selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { whenModelPickWritten } from '@/sync/model-gesture';
import { getSyncSessionDirectory } from '@/sync/sync-refs';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { SyncProvider } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { useSettingsKeyboardShortcuts } from './useSettingsKeyboardShortcuts';

const directory = '/workspace/shortcut-test';

test('web terminal zoom handles configured shortcuts only while focused', async () => {
  const previousOverrides = useUIStore.getState().shortcutOverrides;
  try {
    useUIStore.setState({ shortcutOverrides: {} });
    await withShortcutsMounted(async () => {
      const terminal = document.createElement('div');
      terminal.dataset.terminalOwner = 'main';
      const input = document.createElement('textarea');
      terminal.append(input);
      document.body.append(terminal);
      const actions: string[] = [];
      window.addEventListener('openchamber:zoom', (event) => {
        if (event instanceof CustomEvent) actions.push(event.detail);
      });
      const press = (target: HTMLElement, key: string, code: string) => {
        const event = new KeyboardEvent('keydown', { key, code, ctrlKey: true, bubbles: true, cancelable: true });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      };
      // The terminal surface encodes keyups it receives as Kitty release
      // events, so a consumed zoom press must not leak its release there.
      const releases: string[] = [];
      input.addEventListener('keyup', (event) => releases.push(event.code));
      const release = (code: string) => input.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
      input.focus();
      expect(press(input, '=', 'Equal')).toBe(true);
      release('Equal');
      expect(press(input, '-', 'Minus')).toBe(true);
      release('Minus');
      expect(press(input, '0', 'Digit0')).toBe(true);
      release('Digit0');
      expect(actions).toEqual(['zoom-in', 'zoom-out', 'zoom-reset']);
      expect(releases).toEqual([]);
      release('KeyA');
      expect(releases).toEqual(['KeyA']);
      useUIStore.setState({ shortcutOverrides: { zoom_in: 'mod+shift+y' } });
      expect(press(input, '=', 'Equal')).toBe(false);
      release('Equal');
      expect(releases).toEqual(['KeyA', 'Equal']);
      const rebound = new KeyboardEvent('keydown', { key: 'Y', code: 'KeyY', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
      input.dispatchEvent(rebound);
      expect(rebound.defaultPrevented).toBe(true);
      release('KeyY');
      expect(releases).toEqual(['KeyA', 'Equal']);
      expect(actions.at(-1)).toBe('zoom-in');
      useUIStore.setState({ shortcutOverrides: { toggle_terminal: 'mod+minus' } });
      expect(press(input, '-', 'Minus')).toBe(true);
      expect(actions).toHaveLength(4);
      useUIStore.setState({ shortcutOverrides: {} });
      const other = document.createElement('input');
      document.body.append(other);
      other.focus();
      expect(press(other, '-', 'Minus')).toBe(false);
      terminal.dataset.terminalOwner = 'surface:guest';
      input.focus();
      expect(press(input, '-', 'Minus')).toBe(false);
      terminal.dataset.terminalOwner = 'main';
      window.__OPENCHAMBER_SURFACE__ = 'mobile';
      input.focus();
      expect(press(input, '=', 'Equal')).toBe(false);
      expect(press(input, '-', 'Minus')).toBe(false);
      expect(press(input, '0', 'Digit0')).toBe(false);
      window.__OPENCHAMBER_SURFACE__ = undefined;
      Object.defineProperty(window, '__OPENCHAMBER_ELECTRON__', { configurable: true, value: { runtime: 'electron' } });
      input.focus();
      expect(press(input, '-', 'Minus')).toBe(false);
      expect(actions).toHaveLength(4);
    });
  } finally {
    useUIStore.setState({ shortcutOverrides: previousOverrides });
  }
});

async function withShortcutsMounted(
  run: (requests: string[], waitForRequest: (pathFragment: string) => Promise<void>) => Promise<void>,
  settingsOnly = false,
  alongside: React.ReactNode = null,
  onPrompt?: (sessionId: string) => void,
  onModel?: (sessionId: string, model: unknown, directory: string | null) => boolean,
) {
  const dom = new Window({ url: 'http://shortcut.test' });
  const requests: string[] = [];
  const requestListeners = new Map<string, () => void>();
  const waitForRequest = (pathFragment: string) => new Promise<void>((resolve) => {
    requestListeners.set(pathFragment, resolve);
  });
  const fetchResponse = async (request: Request | URL | string, init?: RequestInit) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    requests.push(path);
    for (const [fragment, resolve] of requestListeners) {
      if (path.includes(fragment)) {
        requestListeners.delete(fragment);
        resolve();
      }
    }
    if (path.endsWith('/event')) {
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (path.endsWith('/prompt')) {
      const id = path.split('/').at(-2)!;
      onPrompt?.(id);
      return Response.json({ data: { id: 'msg_test', sessionID: id, time: { created: 1 }, type: 'user', payload: { text: 'Next' }, delivery: 'queue' } });
    }
    if (path.endsWith('/model') && onModel) {
      const headers = new Headers(init?.headers ?? (request instanceof Request ? request.headers : undefined));
      const rawDir = headers.get('x-opencode-directory');
      const body = String(init?.body ?? (request instanceof Request ? await request.clone().text() : '{}'));
      const ok = onModel(path.split('/').at(-2)!, JSON.parse(body).model, rawDir ? decodeURIComponent(rawDir) : null);
      return ok ? new Response(null, { status: 204 }) : Response.json({ _tag: 'NotFoundError', message: 'no session in this directory' }, { status: 404 });
    }
    const data = path.endsWith('/location')
      ? { directory, project: { id: 'project', directory, canonical: directory } }
      : path.endsWith('/vcs') ? { data: { branch: { current: 'main', default: 'main' } } }
      : path.endsWith('/session/active') ? { data: {} }
      : path.endsWith('/config') || path.endsWith('/project') ? [] : { data: [] };
    return Response.json(data);
  };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement,
    HTMLTextAreaElement: dom.HTMLTextAreaElement, Node: dom.Node, Event: dom.Event,
    KeyboardEvent: dom.KeyboardEvent, CustomEvent: dom.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: fetchResponse,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  opencodeClient.reconnectToRuntimeBaseUrl();
  const sdk = OpenCode.make({
    baseUrl: 'https://shortcut.test',
    fetch: fetchResponse,
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);

  function ShortcutOwner() {
    useKeyboardShortcuts();
    return null;
  }

  function SettingsShortcutOwner() {
    useSettingsKeyboardShortcuts();
    return null;
  }

  try {
    await act(async () => root.render(
      <ThemeSystemProvider>
        {settingsOnly ? <SettingsShortcutOwner /> : (
          <SyncProvider sdk={sdk} directory={directory}><ShortcutOwner />{alongside}</SyncProvider>
        )}
      </ThemeSystemProvider>,
    ));
    await run(requests, waitForRequest);
  } finally {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    opencodeClient.reconnectToRuntimeBaseUrl();
    await dom.happyDOM.close();
  }
}

test('Settings shortcuts work without a chat sync owner or session requests', async () => {
  const previousUI = useUIStore.getState();
  try {
    useUIStore.setState({ isSettingsDialogOpen: true, shortcutOverrides: { open_settings: 'mod+k s' } });
    await withShortcutsMounted(async (requests) => {
      const input = document.createElement('input');
      document.body.append(input);
      input.focus();
      const press = async (key: string, code: string, ctrlKey = false) => {
        const event = new KeyboardEvent('keydown', { key, code, ctrlKey, bubbles: true, cancelable: true });
        await act(async () => { input.dispatchEvent(event); });
        return event;
      };
      expect((await press('n', 'KeyN', true)).defaultPrevented).toBe(false);
      expect((await press('k', 'KeyK', true)).defaultPrevented).toBe(true);
      expect((await press('s', 'KeyS')).defaultPrevented).toBe(true);
      expect(useUIStore.getState().isSettingsDialogOpen).toBe(false);
      expect(requests).toEqual([]);
    }, true);
  } finally {
    useUIStore.setState(previousUI, true);
  }
});

test('Settings yields its default VS Code key and lets inputs and menus use Escape first', async () => {
  const previousUI = useUIStore.getState();
  try {
    useUIStore.setState({ isSettingsDialogOpen: true, shortcutOverrides: {} });
    await withShortcutsMounted(async () => {
      Object.assign(window, { __VSCODE_CONFIG__: { panelType: 'settings' } });
      const input = document.createElement('input');
      document.body.append(input);
      const press = async (key: string, options: KeyboardEventInit = {}) => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
        await act(async () => { input.dispatchEvent(event); });
        return event;
      };
      expect((await press(',', { code: 'Comma', ctrlKey: true })).defaultPrevented).toBe(false);
      expect(useUIStore.getState().isSettingsDialogOpen).toBe(true);
      await press('Escape', { isComposing: true });
      expect(useUIStore.getState().isSettingsDialogOpen).toBe(true);

      const menu = document.createElement('div');
      menu.dataset.slot = 'select-content';
      menu.dataset.open = '';
      document.body.append(menu);
      await press('Escape');
      expect(useUIStore.getState().isSettingsDialogOpen).toBe(true);
      menu.remove();

      const consume = (event: KeyboardEvent) => event.preventDefault();
      input.addEventListener('keydown', consume);
      await press('Escape');
      expect(useUIStore.getState().isSettingsDialogOpen).toBe(true);
      input.removeEventListener('keydown', consume);
      expect((await press('Escape')).defaultPrevented).toBe(true);
      expect(useUIStore.getState().isSettingsDialogOpen).toBe(false);
    }, true);
  } finally {
    useUIStore.setState(previousUI, true);
  }
});

function createComposer(parent: HTMLElement) {
  const chatInput = document.createElement('div');
  chatInput.dataset.chatInput = 'true';
  const composer = document.createElement('div');
  composer.className = 'cm-content';
  composer.tabIndex = 0;
  chatInput.append(composer);
  parent.append(chatInput);
  return composer;
}

test('Ctrl+L adds a selection outside chat and yields to a sequence without one', async () => {
  const previousOverrides = useUIStore.getState().shortcutOverrides;
  await withShortcutsMounted(async () => {
    const textarea = document.createElement('textarea');
    textarea.value = 'alpha beta gamma';
    document.body.append(textarea);
    const composer = createComposer(document.body);

    try {
      textarea.focus();
      textarea.setSelectionRange(6, 10);
      const selectedKey = new KeyboardEvent('keydown', {
        key: 'l', code: 'KeyL', ctrlKey: true, bubbles: true, cancelable: true,
      });
      await act(async () => { textarea.dispatchEvent(selectedKey); await Promise.resolve(); });

      expect(selectedKey.defaultPrevented).toBe(true);
      expect(useInputStore.getState()).toMatchObject({
        pendingInputText: '```md\nbeta\n```', pendingInputMode: 'append',
      });
      expect(document.activeElement).toBe(composer);
      expect(textarea.selectionStart).toBe(textarea.selectionEnd);

      useInputStore.getState().setPendingInputText(null);
      useUIStore.setState({ shortcutOverrides: { ...previousOverrides, focus_input: 'mod+l i' } });
      textarea.focus();
      const leader = new KeyboardEvent('keydown', {
        key: 'l', code: 'KeyL', ctrlKey: true, bubbles: true, cancelable: true,
      });
      await act(async () => { textarea.dispatchEvent(leader); await Promise.resolve(); });

      expect(leader.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(textarea);
      expect(useInputStore.getState().pendingInputText).toBeNull();

      const completion = new KeyboardEvent('keydown', { key: 'i', code: 'KeyI', bubbles: true, cancelable: true });
      await act(async () => { textarea.dispatchEvent(completion); });
      expect(completion.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(composer);
    } finally {
      useUIStore.setState({ shortcutOverrides: previousOverrides });
      useInputStore.getState().setPendingInputText(null);
    }
  });
});

// The composer of a pinned column, as ChatInput mounts it for that column's session.
function PinnedComposerKeys({ formRef }: { formRef: React.RefObject<HTMLFormElement | null> }) {
  useComposerSelection({
    column: { columnPinned: true },
    editorState: { composerFormRef: formRef },
    sessionScope: {
      currentSessionId: 'ses_pinned', currentDirectory: directory, isBtwActive: false, btwComposerSessionId: null,
      sessionAgentPick: null, btwAgentSelection: null, btwModelSelection: null,
    },
  });
  return null;
}

test('the favorite-model and effort keys change the session of the composer they were pressed in, a pinned column included', async () => {
  const oldConfig = useConfigStore.getState();
  const oldUI = useUIStore.getState();
  const oldSession = useSessionUIStore.getState();
  const selections = useSelectionStore.getState();
  const written: Array<{ id: string; model: unknown }> = [];
  const switchModel = spyOn(opencodeClient, 'switchSessionModel').mockImplementation(async (id, model) => { written.push({ id, model }); });
  const model = (id: string) => ({ id, providerID: 'provider', modelID: id, name: id, enabled: true, status: 'active' as const,
    capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [{ id: 'low', settings: {} }, { id: 'high', settings: {} }], time: { released: 0 }, cost: [], limit: { context: 1, output: 1 } });
  const formRef = React.createRef<HTMLFormElement>();
  try {
    await withShortcutsMounted(async () => {
      await act(async () => {
        useConfigStore.setState({
          providers: [{ id: 'provider', name: 'provider', activation: 'enabled', package: 'provider', models: [model('a'), model('b'), model('c')] }],
          activeDirectoryKey: directory,
          currentProviderId: 'provider', currentModelId: 'a', currentAgentName: 'build', currentVariant: 'low', currentVariantSelection: { override: 'low', inherited: 'low' },
        });
        useSessionUIStore.setState({ currentSessionId: 'ses_main', currentSessionDirectory: null });
        useUIStore.setState({
          favoriteModels: [{ providerID: 'provider', modelID: 'a' }, { providerID: 'provider', modelID: 'b' }, { providerID: 'provider', modelID: 'c' }],
          hiddenModels: [], shortcutOverrides: {}, isSettingsDialogOpen: false, isCommandPaletteOpen: false, isHelpDialogOpen: false, isSessionSwitcherOpen: false, isAboutDialogOpen: false,
        });
        // The pinned column's session runs on b at low effort (and remembers low on c); the main chat on a.
        selections.saveSessionAgentSelection('ses_pinned', 'build');
        selections.saveSessionModelSelection('ses_pinned', 'provider', 'b');
        selections.saveAgentModelVariantForSession('ses_pinned', 'build', 'provider', 'b', 'low');
        selections.saveAgentModelVariantForSession('ses_pinned', 'build', 'provider', 'c', 'low');
      });
      const column = document.createElement('form');
      column.dataset.chatColumn = 'pinned';
      column.dataset.chatSessionId = 'ses_pinned';
      document.body.append(column);
      const pinnedComposer = createComposer(column);
      formRef.current = column;
      const mainComposer = createComposer(document.body);
      const press = async (target: HTMLElement, init: KeyboardEventInit) => {
        const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
        await act(async () => { target.dispatchEvent(event); });
        await whenModelPickWritten('ses_pinned');
        await whenModelPickWritten('ses_main');
        return event;
      };
      const favorite = { key: ']', code: 'BracketRight', ctrlKey: true, altKey: true };
      const effort = { key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true };

      expect((await press(pinnedComposer, favorite)).defaultPrevented).toBe(true);
      expect(written).toEqual([{ id: 'ses_pinned', model: { providerID: 'provider', id: 'c', variant: 'low' } }]);
      written.length = 0;

      expect((await press(pinnedComposer, effort)).defaultPrevented).toBe(true);
      expect(written).toEqual([{ id: 'ses_pinned', model: { providerID: 'provider', id: 'c', variant: 'high' } }]);
      written.length = 0;

      // The same keys in the main chat's composer still change the main session, and only it.
      expect((await press(mainComposer, favorite)).defaultPrevented).toBe(true);
      expect((await press(mainComposer, effort)).defaultPrevented).toBe(true);
      expect(written.map((entry) => entry.id)).toEqual(['ses_main', 'ses_main']);
      expect(written[0]?.model).toMatchObject({ providerID: 'provider', id: 'b' });
    }, false, <PinnedComposerKeys formRef={formRef} />);
  } finally {
    switchModel.mockRestore();
    selections.clearSessionSelections('ses_pinned');
    useConfigStore.setState(oldConfig, true);
    useUIStore.setState(oldUI, true);
    useSessionUIStore.setState(oldSession, true);
  }
});

test('a pinned column shortcut passes its known directory even before the session is in sync', async () => {
  const oldConfig = useConfigStore.getState();
  const oldUI = useUIStore.getState();
  const oldSession = useSessionUIStore.getState();
  const selections = useSelectionStore.getState();
  const written: Array<{ id: string; model: unknown }> = [];
  const models = new Map<string, unknown>([
    ['ses_main', { providerID: 'provider', id: 'a', variant: 'low' }],
    ['ses_pinned', { providerID: 'provider', id: 'b', variant: 'low' }],
  ]);
  const accepted: Array<{ id: string; model: unknown }> = [];
  const seenDirectories: Array<string | null> = [];
  const oldDirectory = opencodeClient.getDirectory();
  const switchReal = opencodeClient.switchSessionModel.bind(opencodeClient);
  const switchModel = spyOn(opencodeClient, 'switchSessionModel').mockImplementation(async (id, model, dir) => { written.push({ id, model }); await switchReal(id, model, dir); });
  const model = (id: string) => ({ id, providerID: 'provider', modelID: id, name: id, enabled: true, status: 'active' as const,
    capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [{ id: 'low', settings: {} }, { id: 'high', settings: {} }], time: { released: 0 }, cost: [], limit: { context: 1, output: 1 } });
  const formRef = React.createRef<HTMLFormElement>();
  try {
    await withShortcutsMounted(async () => {
      await act(async () => {
        useConfigStore.setState({
          providers: [{ id: 'provider', name: 'provider', activation: 'enabled', package: 'provider', models: [model('a'), model('b'), model('c')] }],
          activeDirectoryKey: directory,
          currentProviderId: 'provider', currentModelId: 'a', currentAgentName: 'build', currentVariant: 'low', currentVariantSelection: { override: 'low', inherited: 'low' },
        });
        useSessionUIStore.setState({ currentSessionId: 'ses_main', currentSessionDirectory: null });
        useUIStore.setState({
          favoriteModels: [{ providerID: 'provider', modelID: 'a' }, { providerID: 'provider', modelID: 'b' }, { providerID: 'provider', modelID: 'c' }],
          hiddenModels: [], shortcutOverrides: {}, isSettingsDialogOpen: false, isCommandPaletteOpen: false, isHelpDialogOpen: false, isSessionSwitcherOpen: false, isAboutDialogOpen: false,
        });
        // The pinned column's session runs on b at low effort (and remembers low on c); the main chat on a.
        selections.saveSessionAgentSelection('ses_pinned', 'build');
        selections.saveSessionModelSelection('ses_pinned', 'provider', 'b');
        selections.saveAgentModelVariantForSession('ses_pinned', 'build', 'provider', 'b', 'low');
        selections.saveAgentModelVariantForSession('ses_pinned', 'build', 'provider', 'c', 'low');
      });
      const column = document.createElement('form');
      column.dataset.chatColumn = 'pinned';
      column.dataset.chatSessionId = 'ses_pinned';
      document.body.append(column);
      const pinnedComposer = createComposer(column);
      formRef.current = column;
      const mainComposer = createComposer(document.body);
      const press = async (target: HTMLElement, init: KeyboardEventInit) => {
        const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
        await act(async () => { target.dispatchEvent(event); });
        await whenModelPickWritten('ses_pinned');
        await whenModelPickWritten('ses_main');
        return event;
      };
      const favorite = { key: ']', code: 'BracketRight', ctrlKey: true, altKey: true };
      const effort = { key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true };

      opencodeClient.setDirectory('/workspace/other-project');
      expect(getSyncSessionDirectory('ses_pinned')).toBeNull();
      expect((await press(pinnedComposer, favorite)).defaultPrevented).toBe(true);
      expect(written).toEqual([{ id: 'ses_pinned', model: { providerID: 'provider', id: 'c', variant: 'low' } }]);
      await opencodeClient.sendMessage({ id: 'ses_pinned', text: 'Next', directory });
      expect(accepted.at(-1)).toEqual({ id: 'ses_pinned', model: { providerID: 'provider', id: 'c', variant: 'low' } });
      expect(models.get('ses_pinned')).toEqual({ providerID: 'provider', id: 'c', variant: 'low' });
      expect(models.get('ses_main')).toEqual({ providerID: 'provider', id: 'a', variant: 'low' });
      written.length = 0;

      expect((await press(pinnedComposer, effort)).defaultPrevented).toBe(true);
      expect(written).toEqual([{ id: 'ses_pinned', model: { providerID: 'provider', id: 'c', variant: 'high' } }]);
      await opencodeClient.sendMessage({ id: 'ses_pinned', text: 'Next', directory });
      expect(accepted.at(-1)).toEqual({ id: 'ses_pinned', model: { providerID: 'provider', id: 'c', variant: 'high' } });
      expect(models.get('ses_pinned')).toEqual({ providerID: 'provider', id: 'c', variant: 'high' });
      expect(models.get('ses_main')).toEqual({ providerID: 'provider', id: 'a', variant: 'low' });
      written.length = 0;

      // The same keys in the main chat's composer still change the main session, and only it.
      expect((await press(mainComposer, favorite)).defaultPrevented).toBe(true);
      expect((await press(mainComposer, effort)).defaultPrevented).toBe(true);
      expect(written.map((entry) => entry.id)).toEqual(['ses_main', 'ses_main']);
      expect(written[0]?.model).toMatchObject({ providerID: 'provider', id: 'b' });
    }, false, <PinnedComposerKeys formRef={formRef} />, (id) => { accepted.push({ id, model: models.get(id) }); }, (id, model, dir) => {
      seenDirectories.push(dir);
      if (dir !== directory) return false;
      models.set(id, model);
      return true;
    });
  } finally {
    switchModel.mockRestore();
    opencodeClient.setDirectory(oldDirectory);
    selections.clearSessionSelections('ses_pinned');
    useConfigStore.setState(oldConfig, true);
    useUIStore.setState(oldUI, true);
    useSessionUIStore.setState(oldSession, true);
  }
});

test('a pinned column shortcut uses the pinned directory model catalog', async () => {
  const oldConfig = useConfigStore.getState();
  const oldUI = useUIStore.getState();
  const oldSession = useSessionUIStore.getState();
  const selections = useSelectionStore.getState();
  const written: Array<{ id: string; model: unknown }> = [];
  const models = new Map<string, unknown>([
    ['ses_main', { providerID: 'provider', id: 'a', variant: 'low' }],
    ['ses_pinned', { providerID: 'provider', id: 'b', variant: 'low' }],
  ]);
  const accepted: Array<{ id: string; model: unknown }> = [];
  const switchModel = spyOn(opencodeClient, 'switchSessionModel').mockImplementation(async (id, model) => { written.push({ id, model }); models.set(id, model); });
  const model = (id: string) => ({ id, providerID: 'provider', modelID: id, name: id, enabled: true, status: 'active' as const,
    capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [{ id: 'low', settings: {} }, { id: 'high', settings: {} }], time: { released: 0 }, cost: [], limit: { context: 1, output: 1 } });
  const formRef = React.createRef<HTMLFormElement>();
  try {
    await withShortcutsMounted(async () => {
      await act(async () => {
        const activeProvider = { id: 'provider', name: 'provider', activation: 'enabled' as const, package: 'provider', models: [model('a'), model('b')] };
        const pinnedProvider = { ...activeProvider, models: [model('a'), model('b'), model('c')] };
        useConfigStore.setState({
          providers: [activeProvider], activeDirectoryKey: '/workspace/main',
          directoryScoped: { ...useConfigStore.getState().directoryScoped, [directory]: { ...useConfigStore.getState().directoryScoped[directory], providers: [pinnedProvider] } },
          currentProviderId: 'provider', currentModelId: 'a', currentAgentName: 'build', currentVariant: 'low', currentVariantSelection: { override: 'low', inherited: 'low' },
        });
        useSessionUIStore.setState({ currentSessionId: 'ses_main', currentSessionDirectory: null });
        useUIStore.setState({
          favoriteModels: [{ providerID: 'provider', modelID: 'a' }, { providerID: 'provider', modelID: 'b' }, { providerID: 'provider', modelID: 'c' }],
          hiddenModels: [], shortcutOverrides: {}, isSettingsDialogOpen: false, isCommandPaletteOpen: false, isHelpDialogOpen: false, isSessionSwitcherOpen: false, isAboutDialogOpen: false,
        });
        // The pinned column's session runs on b at low effort (and remembers low on c); the main chat on a.
        selections.saveSessionAgentSelection('ses_pinned', 'build');
        selections.saveSessionModelSelection('ses_pinned', 'provider', 'b');
        selections.saveAgentModelVariantForSession('ses_pinned', 'build', 'provider', 'b', 'low');
        selections.saveAgentModelVariantForSession('ses_pinned', 'build', 'provider', 'c', 'low');
      });
      const column = document.createElement('form');
      column.dataset.chatColumn = 'pinned';
      column.dataset.chatSessionId = 'ses_pinned';
      document.body.append(column);
      const pinnedComposer = createComposer(column);
      formRef.current = column;
      const mainComposer = createComposer(document.body);
      const press = async (target: HTMLElement, init: KeyboardEventInit) => {
        const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
        await act(async () => { target.dispatchEvent(event); });
        await whenModelPickWritten('ses_pinned');
        await whenModelPickWritten('ses_main');
        return event;
      };
      const favorite = { key: ']', code: 'BracketRight', ctrlKey: true, altKey: true };
      const effort = { key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true };

      expect(selectProvidersForDirectory(useConfigStore.getState(), directory)[0]?.models.map((m) => m.id)).toEqual(['a', 'b', 'c']);
      expect((await press(pinnedComposer, favorite)).defaultPrevented).toBe(true);
      await opencodeClient.sendMessage({ id: 'ses_pinned', text: 'Next', directory });
      expect(accepted.at(-1)).toEqual({ id: 'ses_pinned', model: { providerID: 'provider', id: 'c', variant: 'low' } });
      expect(models.get('ses_pinned')).toEqual({ providerID: 'provider', id: 'c', variant: 'low' });
      expect(models.get('ses_main')).toEqual({ providerID: 'provider', id: 'a', variant: 'low' });
      written.length = 0;

      expect((await press(pinnedComposer, effort)).defaultPrevented).toBe(true);
      expect(written).toEqual([{ id: 'ses_pinned', model: { providerID: 'provider', id: 'c', variant: 'high' } }]);
      await opencodeClient.sendMessage({ id: 'ses_pinned', text: 'Next', directory });
      expect(accepted.at(-1)).toEqual({ id: 'ses_pinned', model: { providerID: 'provider', id: 'c', variant: 'high' } });
      expect(models.get('ses_pinned')).toEqual({ providerID: 'provider', id: 'c', variant: 'high' });
      expect(models.get('ses_main')).toEqual({ providerID: 'provider', id: 'a', variant: 'low' });
      written.length = 0;

      // The same keys in the main chat's composer still change the main session, and only it.
      expect((await press(mainComposer, favorite)).defaultPrevented).toBe(true);
      expect((await press(mainComposer, effort)).defaultPrevented).toBe(true);
      expect(written.map((entry) => entry.id)).toEqual(['ses_main', 'ses_main']);
      expect(written[0]?.model).toMatchObject({ providerID: 'provider', id: 'b' });
    }, false, <PinnedComposerKeys formRef={formRef} />, (id) => { accepted.push({ id, model: models.get(id) }); });
  } finally {
    switchModel.mockRestore();
    selections.clearSessionSelections('ses_pinned');
    useConfigStore.setState(oldConfig, true);
    useUIStore.setState(oldUI, true);
    useSessionUIStore.setState(oldSession, true);
  }
});

test('double Escape stops a running chat only from its composer', async () => {
  await withShortcutsMounted(async (requests, waitForRequest) => {
    const column = document.createElement('div');
    column.dataset.chatColumn = 'pinned';
    column.dataset.chatSessionId = 'ses_pinned';
    column.dataset.chatWorking = 'true';
    document.body.append(column);
    const composer = createComposer(column);
    // A button in the same chat, standing in for a panel or toolbar control.
    const panelButton = document.createElement('button');
    column.append(panelButton);
    // An Escape the composer spends on itself, such as closing a picker.
    let composerConsumesEscape = false;
    composer.addEventListener('keydown', (event) => {
      if (composerConsumesEscape) event.preventDefault();
    });

    const pressEscape = async (target: HTMLElement) => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      await act(async () => { target.dispatchEvent(event); await Promise.resolve(); });
      return event;
    };
    const aborts = () => requests.filter((path) => path.includes('ses_pinned')).length;

    await pressEscape(panelButton);
    await pressEscape(panelButton);
    expect(aborts()).toBe(0);

    await pressEscape(composer);
    await pressEscape(panelButton);
    await pressEscape(composer);
    expect(aborts()).toBe(0);

    composerConsumesEscape = true;
    await pressEscape(composer);
    composerConsumesEscape = false;
    expect((await pressEscape(composer)).defaultPrevented).toBe(true);
    expect(aborts()).toBe(0);

    const interrupted = waitForRequest('ses_pinned');
    expect((await pressEscape(composer)).defaultPrevented).toBe(true);
    await act(async () => { await interrupted; });
    expect(aborts()).toBe(1);
  });
});

test('a chord started in a field that is gone completes unless another field is pressed', async () => {
  const previous = useUIStore.getState().shortcutOverrides;
  try {
    useUIStore.setState({ shortcutOverrides: {}, isHelpDialogOpen: false });
    await withShortcutsMounted(async () => {
      const composer = document.createElement('textarea');
      document.body.append(composer);
      const startInPalette = () => {
        const palette = document.createElement('input');
        document.body.append(palette);
        palette.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true }));
        palette.remove();
      };
      const typeH = async () => {
        await act(async () => {
          composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', code: 'KeyH', bubbles: true, cancelable: true }));
        });
        return useUIStore.getState().isHelpDialogOpen;
      };
      startInPalette();
      composer.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      expect(await typeH()).toBe(false);
      startInPalette();
      expect(await typeH()).toBe(true);
    });
  } finally {
    useUIStore.setState({ shortcutOverrides: previous, isHelpDialogOpen: false });
  }
});
