import { z } from 'zod';
import { flushDeferredStorage, getSafeSessionStorage, getSafeStorage } from '@/stores/utils/safeStorage';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { resolveEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { getMiniChatRuntimeArgs, invokeDesktop, isElectronShell } from '@/lib/desktop';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { afterDelay } from '@/lib/timing/afterDelay';
import { generateUuid } from '@/lib/uuid';
import { buildContextWindowUrl, isContextWindow, isContextWindowUrl, isWindowId } from './role';
import { carryShownSurfaces, closeEveryZone, explicitPanelWindowPlacement, latestPanelOwner, panelWindowPlacement, withPanelEntry, withoutPanelEntry } from './layoutState';
import { withoutForeignComparisons } from '@/stores/ui/contextPanelState';
import type { UIStore } from '@/stores/ui/types';
import { readContextWindowRecord, writeContextWindowRecord } from './storage';
import { setContextActionForwarder, type RoutedContextAction } from './routing';
import { contextWindowMessageSchema, openContextWindowChannel, type ContextWindowFollowState, type ContextWindowMessage } from './protocol';
import { useContextWindowStore } from './store';

const WINDOW_ID_KEY = 'openchamber.window-id';
const DETACHED_KEY = 'openchamber.context-window.detached';
const PANEL_REPLY_MS = 8000;
const PANEL_START_MS = 45_000;
const PANEL_CLOSED_CHECK_MS = 300;
const WEB_WINDOW_FEATURES = 'popup=yes,width=1280,height=860';

const QUIET_ACTIONS = new Set<RoutedContextAction>([
  'openAgentBrowserTab',
  'setContextPanelTabTargetPath',
  'moveContextFilePaths',
  'closeContextPanelTab',
  'closeContextFile',
  'closeContextPanelTabs',
  'closeContextPanel',
  'closeContextZone',
  'setPendingDiffFile',
  'setPendingTurnDiffFile',
  'setPendingFileNavigation',
  'setPendingFileFocusPath',
]);

const quietOptionsSchema = z.object({ reveal: z.literal(false) });

const closedEventSchema = z.object({ detail: z.object({ ownerId: z.string() }) });

const restoreOwnersSchema = z.array(z.string()).catch([]);

type Owner = {
  id: string;
  instance: string;
  channel: BroadcastChannel;
  panel: Window | null;
  ready: boolean;
  queued: ContextWindowMessage[];
  lastFollow: string;
  cancelWait: (() => void) | null;
  returnRequested: boolean;
};

let owner: Owner | null = null;
let restoreRequest: Promise<string[]> | null = null;

const readWindowId = (): string => {
  const storage = getSafeSessionStorage();
  const stored = storage.getItem(WINDOW_ID_KEY);
  if (isWindowId(stored)) return stored;
  const id = generateUuid();
  storage.setItem(WINDOW_ID_KEY, id);
  return id;
};

const setDetached = (detached: boolean): void => {
  const storage = getSafeSessionStorage();
  if (detached) storage.setItem(DETACHED_KEY, '1');
  else storage.removeItem(DETACHED_KEY);
  useContextWindowStore.setState({ detached });
};

const post = (message: ContextWindowMessage): boolean => {
  if (!owner) return false;
  try {
    owner.channel.postMessage(message);
    return true;
  } catch (error) {
    console.warn('[context-window] could not reach the panel window', error);
    return false;
  }
};

const postWhenReady = (message: ContextWindowMessage): boolean => {
  if (!owner) return false;
  if (owner.ready) return post(message);
  owner.queued.push(message);
  return true;
};

const readFollowState = (): ContextWindowFollowState => {
  const session = useSessionUIStore.getState();
  const draft = session.newSessionDraft;
  return {
    effectiveDirectory: resolveEffectiveDirectory() ?? null,
    directory: useDirectoryStore.getState().currentDirectory || null,
    sessionId: session.currentSessionId,
    sessionDirectory: session.currentSessionDirectory,
    draft: draft.open
      ? {
          draftId: draft.draftId,
          open: true,
          target: draft.target,
          selectedProjectId: draft.selectedProjectId ?? null,
          directoryOverride: draft.directoryOverride,
          bootstrapPendingDirectory: draft.bootstrapPendingDirectory ?? null,
          preparedChatDirectory: draft.preparedChatDirectory ?? null,
          parentID: draft.parentID,
        }
      : null,
    composerAddress: useInputStore.getState().composerAddress,
  };
};

const sendFollowState = (force = false): void => {
  if (!owner?.ready || !useContextWindowStore.getState().detached) return;
  const state = readFollowState();
  const serialized = JSON.stringify(state);
  if (!force && serialized === owner.lastFollow) return;
  if (post({ kind: 'follow', ownerId: owner.id, state })) owner.lastFollow = serialized;
};

const revealPanelWindow = (): void => {
  if (!owner || !isElectronShell()) return;
  void invokeDesktop('desktop_reveal_context_window', { ownerId: owner.id }).catch(() => {});
};

const isQuietCall = (action: RoutedContextAction, args: readonly unknown[]): boolean => (
  QUIET_ACTIONS.has(action)
  || ((action === 'openContextPanelTab' || action === 'openContextBrowser') && quietOptionsSchema.safeParse(args[2]).success)
);

const forward = (action: RoutedContextAction, args: readonly unknown[]): boolean => {
  if (!owner || !useContextWindowStore.getState().detached) return false;
  if (!postWhenReady({ kind: 'action', ownerId: owner.id, action, args: [...args] })) return false;
  if (!isQuietCall(action, args)) revealPanelWindow();
  return true;
};

const stopWaiting = (): void => {
  owner?.cancelWait?.();
  if (owner) owner.cancelWait = null;
};

const waitForPanel = (ms: number): void => {
  if (!owner) return;
  stopWaiting();
  owner.cancelWait = afterDelay(ms, () => returnContextPanel());
};

const panelReady = (): void => {
  if (!owner) return;
  stopWaiting();
  owner.ready = true;
  if (owner.returnRequested) {
    requestReturn(owner);
    return;
  }
  sendFollowState(true);
  const queued = owner.queued.splice(0);
  for (const message of queued) post(message);
};

const openPanelWindow = async (id: string): Promise<'opened' | 'blocked' | 'failed'> => {
  if (isElectronShell()) {
    try {
      await invokeDesktop('desktop_open_context_window', { ownerId: id, ...getMiniChatRuntimeArgs() });
      return 'opened';
    } catch (error) {
      console.warn('[context-window] could not open the panel window', error);
      return 'failed';
    }
  }
  const panel = window.open(buildContextWindowUrl(window.location.href, id), `openchamber-context-${id}`, WEB_WINDOW_FEATURES);
  if (!panel) return 'blocked';
  if (owner) owner.panel = panel;
  return 'opened';
};

export const detachContextPanel = async (options: { restoreFrom?: ReadonlySet<string> } = {}): Promise<'opened' | 'blocked' | 'failed' | 'unavailable'> => {
  if (!owner) return 'unavailable';
  if (useContextWindowStore.getState().detached) {
    revealPanelWindow();
    return 'opened';
  }
  const storage = getSafeStorage();
  const ui = useUIStore.getState();
  const record = readContextWindowRecord(storage);
  const restoredOwner = options.restoreFrom ? latestPanelOwner(record, options.restoreFrom) : null;
  const restored = restoredOwner ? record.panels[restoredOwner] : undefined;
  const placement = restored?.placement ?? explicitPanelWindowPlacement(panelWindowPlacement(record.placement), record.placement);
  const byDirectory = restored
    ? withoutForeignComparisons(restored.byDirectory)
    : carryShownSurfaces(ui.contextPanelByDirectory, ui.contextSurfaceZones, panelWindowPlacement(record.placement));
  const base = restoredOwner ? withoutPanelEntry(record, restoredOwner) : record;
  writeContextWindowRecord(storage, withPanelEntry(base, owner.id, { byDirectory, placement, touchedAt: Date.now() }));
  flushDeferredStorage();

  owner.ready = false;
  const result = await openPanelWindow(owner.id);
  if (result !== 'opened') return result;
  useUIStore.setState({ contextPanelByDirectory: closeEveryZone(useUIStore.getState().contextPanelByDirectory) });
  setDetached(true);
  owner.lastFollow = '';
  waitForPanel(PANEL_START_MS);
  return 'opened';
};

const readHref = (target: Window): string | null => {
  try {
    return target.location.href;
  } catch {
    return null;
  }
};

const findWebPanelWindow = (current: Owner): Window | null => {
  if (current.panel && !current.panel.closed) return current.panel;
  const found = window.open('', `openchamber-context-${current.id}`);
  if (!found) return null;
  const href = readHref(found);
  if (href === 'about:blank') found.close();
  if (!href || !isContextWindowUrl(href, current.id, window.location.origin)) return null;
  current.panel = found;
  return found;
};

export const showContextPanelWindow = (): void => {
  if (!owner || !useContextWindowStore.getState().detached) return;
  if (isElectronShell()) {
    void invokeDesktop('desktop_open_context_window', { ownerId: owner.id, ...getMiniChatRuntimeArgs() }).catch(() => {});
    return;
  }
  const panel = findWebPanelWindow(owner);
  if (panel) panel.focus();
  else returnContextPanel();
};

function returnAndClose(): void {
  if (!owner) return;
  const id = owner.id;
  returnContextPanel();
  post({ kind: 'close', ownerId: id });
}

function requestReturn(current: Owner): void {
  current.returnRequested = true;
  if (!current.ready || !post({ kind: 'return', ownerId: current.id })) {
    returnAndClose();
    return;
  }
  stopWaiting();
  current.cancelWait = afterDelay(PANEL_REPLY_MS, returnAndClose);
}

export const bringContextPanelBack = (): void => {
  if (owner && useContextWindowStore.getState().detached) requestReturn(owner);
};

const runQueuedHere = (queued: readonly ContextWindowMessage[]): void => {
  for (const message of queued) {
    if (message.kind !== 'action') continue;
    // SAFETY: queued by `forward` from a call to this same action, with its own arguments.
    const run = useUIStore.getState()[message.action] as (...values: readonly unknown[]) => void;
    run(...message.args);
  }
};

const returnContextPanel = (): void => {
  if (!owner || !useContextWindowStore.getState().detached) return;
  stopWaiting();
  owner.returnRequested = false;
  setDetached(false);
  if (owner.panel && !owner.panel.closed) owner.panel.close();
  owner.panel = null;
  owner.ready = false;
  const queued = owner.queued.splice(0);
  const storage = getSafeStorage();
  const record = readContextWindowRecord(storage);
  const entry = record.panels[owner.id];
  writeContextWindowRecord(storage, withoutPanelEntry(record, owner.id));
  if (entry) {
    useUIStore.setState({
      contextPanelByDirectory: carryShownSurfaces(entry.byDirectory, panelWindowPlacement(entry.placement), useUIStore.getState().contextSurfaceZones),
    });
  }
  runQueuedHere(queued);
};

const attachForPanel = async (message: Extract<ContextWindowMessage, { kind: 'attach' }>): Promise<void> => {
  const file = message.file instanceof File ? message.file : new File([message.file], message.name, { type: message.file.type });
  let landed: Extract<ContextWindowMessage, { kind: 'attached' }> = { kind: 'attached', ownerId: message.ownerId, requestId: message.requestId, files: null };
  try {
    await useInputStore.getState().addAttachedFile(file, message.target, (files) => {
      landed = { ...landed, files: [...files] };
    }, message.options);
  } catch {
    landed = { ...landed, files: null };
  }
  if (!post(landed)) post({ ...landed, files: null });
};

const onPanelGone = (current: Owner): void => {
  current.ready = false;
  waitForPanel(PANEL_REPLY_MS);
  afterDelay(PANEL_CLOSED_CHECK_MS, () => {
    if (current.panel?.closed) returnContextPanel();
  });
};

const onMessage = (event: MessageEvent): void => {
  const parsed = contextWindowMessageSchema.safeParse(event.data);
  if (!owner || !parsed.success || parsed.data.ownerId !== owner.id) return;
  const message = parsed.data;
  const detached = useContextWindowStore.getState().detached;
  switch (message.kind) {
    case 'panel-hello':
      if (detached) panelReady();
      else post({ kind: 'close', ownerId: owner.id });
      return;
    case 'panel-returned':
      returnContextPanel();
      return;
    case 'panel-gone':
      if (detached) onPanelGone(owner);
      return;
    case 'owner-hello':
      if (message.instance !== owner.instance) post({ kind: 'owner-taken', ownerId: owner.id, instance: message.instance });
      return;
    case 'owner-taken':
      if (message.instance !== owner.instance) return;
      owner.id = generateUuid();
      getSafeSessionStorage().setItem(WINDOW_ID_KEY, owner.id);
      stopWaiting();
      setDetached(false);
      return;
    case 'attach':
      if (detached) void attachForPanel(message);
      return;
    case 'prefs': {
      if (!detached) return;
      // SAFETY: the panel window's ui-store storage sends fields it persisted from the same UIStore shape (storage.ts).
      useUIStore.setState(message.fields as Partial<UIStore>);
      return;
    }
    default:
      return;
  }
};

export const startContextWindowOwner = (): (() => void) => {
  if (owner || isContextWindow()) return () => {};
  const channel = openContextWindowChannel();
  if (!channel) return () => {};
  const current: Owner = {
    id: readWindowId(),
    instance: generateUuid(),
    channel,
    panel: null,
    ready: false,
    queued: [],
    lastFollow: '',
    cancelWait: null,
    returnRequested: false,
  };
  owner = current;
  channel.onmessage = onMessage;
  setContextActionForwarder(forward);

  if (getSafeSessionStorage().getItem(DETACHED_KEY) === '1') {
    useContextWindowStore.setState({ detached: true });
    waitForPanel(PANEL_REPLY_MS);
  }
  post({ kind: 'owner-hello', ownerId: current.id, instance: current.instance });

  const unsubscribers = [
    useSessionUIStore.subscribe(() => sendFollowState()),
    useDirectoryStore.subscribe(() => sendFollowState()),
    useInputStore.subscribe((state, previous) => {
      if (state.composerAddress !== previous.composerAddress) sendFollowState();
    }),
    subscribeRuntimeEndpointChanged(() => {
      if (useContextWindowStore.getState().detached) post({ kind: 'close', ownerId: current.id });
    }),
  ];

  const onPageHide = () => {
    if (!isElectronShell()) post({ kind: 'owner-gone', ownerId: current.id });
  };
  const onDesktopClosed = (event: Event) => {
    const parsed = closedEventSchema.safeParse(event);
    if (parsed.success && parsed.data.detail.ownerId === current.id) returnContextPanel();
  };
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('openchamber:context-window-closed', onDesktopClosed);

  if (isElectronShell() && !useContextWindowStore.getState().detached) {
    restoreRequest ??= invokeDesktop('desktop_take_context_window_restore')
      .then((owners) => restoreOwnersSchema.parse(owners), () => []);
    void restoreRequest.then((owners) => {
      if (owners.length > 0 && owner === current) void detachContextPanel({ restoreFrom: new Set(owners) });
    });
  }

  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('openchamber:context-window-closed', onDesktopClosed);
    stopWaiting();
    setContextActionForwarder(null);
    channel.close();
    if (owner === current) owner = null;
  };
};
