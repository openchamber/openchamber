import React, { act } from 'react';
import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { create } from 'zustand';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getThemeById } from '@/lib/theme/themes';
import { AUTO_MODEL_ID, AUTO_PROVIDER_ID, isAutoModel } from '@/lib/routing/autoModel';
import { useRoutingStore } from '@/stores/useRoutingStore';

/**
 * Restoring a session must not invent an effort choice.
 *
 * The selection store keeps three states for a session's effort: an effort
 * name, `null` for an explicit "Default", and `undefined` for no choice at all.
 * Only the picker may write `null`. When a restore path writes it instead, the
 * session latches onto "Default" — `null` outranks the agent and settings
 * defaults by design — and the concrete effort the session's own history
 * carries can never come back. These tests pin who writes what.
 */

type VariantChoice = string | null | undefined;

type UserModelChoice = {
  id: string;
  agent?: string;
  providerID: string;
  modelID: string;
  variant?: string;
};

const PROVIDER_ID = 'openai';
const MODEL_ID = 'gpt-5.5';
const AGENT = 'build';
const SESSION_ID = 'ses_restore';

const model = {
  id: MODEL_ID,
  name: MODEL_ID,
  providerID: PROVIDER_ID,
  variants: { low: {}, high: {} },
};
const provider = { id: PROVIDER_ID, name: PROVIDER_ID, models: [model] };
const agent = { id: AGENT, name: AGENT, displayName: 'Build', mode: 'primary' as const, hidden: false, request: { settings: {}, headers: {}, body: {} }, permissions: [] };
/** v2 pins an agent's model, and its effort, in one model reference. */
type TestAgent = typeof agent & { model?: { providerID: string; id: string; variant?: string } };
const planAgent: TestAgent = { ...agent, id: 'plan', name: 'plan', displayName: 'Plan' };
const reviewAgent: TestAgent = { ...agent, id: 'review', name: 'review', displayName: 'Review' };

let latestUserChoice: UserModelChoice | null = null;
/** Models and agents another directory's catalog lists, for the display fallback. */
type KnownElsewhere = { models: typeof model[]; agents: TestAgent[] };
const nothingKnownElsewhere = (): KnownElsewhere => ({ models: [], agents: [] });
let knownElsewhere = nothingKnownElsewhere();
let forcePreserveManualOverride: boolean | null = null;

/** Every effort written for the session, in order, including `undefined`. */
const variantWrites: VariantChoice[] = [];
/** Every `(override, inherited)` pair pushed into the config store. */
const overrideWrites: Array<{ override: VariantChoice; inherited: string | undefined }> = [];
/** Every model remembered as the last chat pick. */
const lastSelectedWrites: string[] = [];

type ConfigState = {
  providers: typeof provider[];
  agents: TestAgent[];
  providersLoaded: boolean;
  agentsLoaded: boolean;
  settingsDefaultsLoaded: boolean;
  modelsMetadata: Record<string, never>;
  currentProviderId: string;
  currentModelId: string;
  currentVariant: string | undefined;
  currentVariantSelection: { override: VariantChoice; inherited: string | undefined };
  currentAgentName: string | undefined;
  settingsDefaultVariant: string | undefined;
  settingsDefaultAgent: string | undefined;
  selectionSource: 'auto' | 'manual';
  setProvider: (providerId: string) => void;
  setSelectedProvider: (providerId: string) => void;
  setModel: (modelId: string) => void;
  setAgent: (agentName: string, options?: { keepModel?: boolean }) => void;
  setCurrentVariant: (variant: string | undefined) => void;
  setCurrentVariantOverride: (override: VariantChoice, inherited: string | undefined) => void;
  getCurrentProvider: () => typeof provider | undefined;
  getCurrentAgent: () => TestAgent;
  getVisibleAgents: () => TestAgent[];
  getCurrentModelVariants: () => string[];
  getModelMetadata: () => undefined;
};

const useConfigStore = create<ConfigState>((set, get) => ({
  providers: [provider],
  agents: [agent],
  providersLoaded: true,
  agentsLoaded: true,
  settingsDefaultsLoaded: true,
  modelsMetadata: {},
  currentProviderId: PROVIDER_ID,
  currentModelId: MODEL_ID,
  currentVariant: undefined,
  currentVariantSelection: { override: undefined, inherited: undefined },
  currentAgentName: AGENT,
  settingsDefaultVariant: undefined,
  settingsDefaultAgent: undefined,
  selectionSource: 'auto',
  setProvider: (providerId) => set({ currentProviderId: providerId }),
  setSelectedProvider: () => undefined,
  setModel: (modelId) => set({ currentModelId: modelId }),
  // Like the real store, picking an agent also records it for the open session.
  setAgent: (agentName) => {
    set({ currentAgentName: agentName });
    const sessionId = useSessionUIStore.getState().currentSessionId;
    if (sessionId) useSelectionStore.getState().saveSessionAgentSelection(sessionId, agentName);
  },
  // Mirrors the real store, including its no-op guard: without that guard an
  // unchanged write returns a fresh state object every render and the
  // component's variant effects never settle.
  setCurrentVariant: (variant) => {
    useConfigStore.getState().setCurrentVariantOverride(undefined, variant);
  },
  setCurrentVariantOverride: (override, inherited) => {
    set((state) => {
      const currentVariant = override === null ? undefined : override ?? inherited;
      if (
        state.currentVariant === currentVariant
        && state.currentVariantSelection.override === override
        && state.currentVariantSelection.inherited === inherited
      ) {
        return state;
      }
      overrideWrites.push({ override, inherited });
      return { currentVariant, currentVariantSelection: { override, inherited } };
    });
  },
  getCurrentProvider: () => get().providers.find((entry) => entry.id === get().currentProviderId),
  getCurrentAgent: () => get().agents.find((entry) => entry.name === get().currentAgentName) ?? agent,
  getVisibleAgents: () => get().agents,
  getCurrentModelVariants: () => Object.keys(model.variants),
  getModelMetadata: () => undefined,
}));

type SelectionState = {
  savedVariant: VariantChoice;
  sessionAgentSelections: Map<string, string>;
  sessionFollowedAgents: Map<string, string>;
  sessionFollowedModels: Map<string, string>;
  getSessionModelSelection: () => { providerId: string; modelId: string } | null;
  getSessionAgentSelection: (sessionId: string) => string | null;
  followSessionAgent: (sessionId: string, agent: string) => boolean;
  isSessionModelSwitched: (sessionId: string, model: string) => boolean;
  markSessionModelFollowed: (sessionId: string, model: string) => void;
  getAgentModelForSession: (sessionId: string, agentName: string) => { providerId: string; modelId: string } | null;
  getAgentModelVariantForSession: () => VariantChoice;
  saveSessionModelSelection: (sessionId: string, providerId: string, modelId: string) => void;
  saveSessionAgentSelection: (sessionId: string, agentName: string) => void;
  saveAgentModelForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => void;
  saveAgentModelVariantForSession: (
    sessionId: string,
    agentName: string,
    providerId: string,
    modelId: string,
    variant: VariantChoice,
  ) => void;
};

const useSelectionStore = create<SelectionState>((set, get) => ({
  savedVariant: undefined,
  sessionAgentSelections: new Map([[SESSION_ID, AGENT]]),
  sessionFollowedAgents: new Map(),
  sessionFollowedModels: new Map(),
  getSessionModelSelection: () => ({ providerId: PROVIDER_ID, modelId: MODEL_ID }),
  getSessionAgentSelection: (sessionId) => get().sessionAgentSelections.get(sessionId) ?? null,
  // The real transition: only a record agent not followed yet moves the pick.
  followSessionAgent: (sessionId, agentName) => {
    if (get().sessionFollowedAgents.get(sessionId) === agentName) return false;
    set((state) => ({
      sessionFollowedAgents: new Map(state.sessionFollowedAgents).set(sessionId, agentName),
      sessionAgentSelections: new Map(state.sessionAgentSelections).set(sessionId, agentName),
    }));
    return true;
  },
  isSessionModelSwitched: (sessionId, modelKey) => {
    const followed = get().sessionFollowedModels.get(sessionId);
    return followed !== undefined && followed !== modelKey;
  },
  markSessionModelFollowed: (sessionId, modelKey) => set((state) => ({
    sessionFollowedModels: new Map(state.sessionFollowedModels).set(sessionId, modelKey),
  })),
  getAgentModelForSession: () => ({ providerId: PROVIDER_ID, modelId: MODEL_ID }),
  getAgentModelVariantForSession: () => get().savedVariant,
  saveSessionModelSelection: () => undefined,
  saveSessionAgentSelection: (sessionId, agentName) => set((state) => ({
    sessionAgentSelections: new Map(state.sessionAgentSelections).set(sessionId, agentName),
  })),
  saveAgentModelForSession: () => undefined,
  saveAgentModelVariantForSession: (_sessionId, _agentName, _providerId, _modelId, variant) => {
    variantWrites.push(variant);
    set({ savedVariant: variant });
  },
}));

type SessionUIState = { currentSessionId: string | null; getDirectoryForSession: () => string };
const useSessionUIStore = create<SessionUIState>(() => ({
  currentSessionId: SESSION_ID,
  getDirectoryForSession: () => '/workspace/project',
}));

const useUIStore = create(() => ({
  isMobile: false,
  isModelSelectorOpen: false,
  hiddenModels: [],
  favoriteAgents: [],
  toggleFavoriteAgent: () => undefined,
  providerOrder: [],
  shortcutOverrides: {},
  isFavoriteModel: () => false,
  toggleFavoriteModel: () => undefined,
  reorderFavoriteModel: () => undefined,
  setProviderOrder: () => undefined,
  setModelSelectorOpen: () => undefined,
  setSettingsDialogOpen: () => undefined,
  setSettingsPage: () => undefined,
  addRecentAgent: () => undefined,
  addRecentModel: () => undefined,
  setLastSelectedModel: (providerID: string, modelID: string) => { lastSelectedWrites.push(`${providerID}/${modelID}`); },
  addRecentEffort: () => undefined,
}));

const passthrough = ({ children }: React.PropsWithChildren) => <div>{children}</div>;

// Captured by value before the module is replaced: reading it back off the
// namespace afterwards would resolve to the replacement and recurse.
const { shouldPreserveManualModelOverride: realShouldPreserveManualModelOverride } =
  await import('@/lib/messages/userModelChoice');

mock.module('@/lib/messages/userModelChoice', () => ({
  findLatestUserModelChoice: () => latestUserChoice,
  // The real guard, unless a test opts out: whether it fires decides which
  // restore branch runs, and the branch that erased a recorded Default is the
  // one it declines to protect.
  shouldPreserveManualModelOverride: (args: Parameters<typeof realShouldPreserveManualModelOverride>[0]) => (
    forcePreserveManualOverride ?? realShouldPreserveManualModelOverride(args)
  ),
}));

mock.module('@/stores/useConfigStore', () => ({
  useConfigStore,
  isStaleAutoSelection: () => false,
  selectCatalogLoadedForDirectory: (state: ConfigState, resource: 'models' | 'agents') => resource === 'models' ? state.providersLoaded : state.agentsLoaded,
  // The active catalog first, then what other directories' catalogs know.
  selectKnownCatalogModel: (state: ConfigState, providerId: string, modelId: string) =>
    state.providers.find((provider) => provider.id === providerId)?.models.find((entry) => entry.id === modelId)
      ?? knownElsewhere.models.find((entry) => entry.providerID === providerId && entry.id === modelId),
  selectKnownAgent: (state: ConfigState, name: string) =>
    state.agents.find((agent) => agent.name === name) ?? knownElsewhere.agents.find((agent) => agent.name === name),
}));
mock.module('@/sync/selection-store', () => ({ useSelectionStore }));
mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore }));
mock.module('@/stores/useUIStore', () => ({ useUIStore }));
mock.module('@/stores/contextStore', () => ({
  useContextStore: <T,>(selector: (state: { hasHydrated: boolean }) => T): T => selector({ hasHydrated: true }),
}));

// The session record the composer restores its selection from; a test sets
// it to drive the "open a historical session" path.
type SessionRecord = { id: string; agent?: string; model?: { providerID: string; id: string; variant?: string } };
const useSessionRecordStore = create<{ record: SessionRecord | undefined }>(() => ({ record: undefined }));
const setSessionRecord = (record: SessionRecord | undefined) => useSessionRecordStore.setState({ record });
mock.module('@/sync/sync-context', () => ({
  useSessionMessages: () => [],
  useSessionRenderable: () => true,
  useSession: () => useSessionRecordStore((state) => state.record),
}));
mock.module('@/sync/use-sync', () => ({ useSync: () => ({ sessions: [] }) }));
mock.module('@/sync/sync-refs', () => ({ getSyncParts: () => [] }));

mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children, open }: React.PropsWithChildren<{ open?: boolean }>) => <div data-menu-open={open}>{children}</div>,
  DropdownMenuContent: passthrough,
  DropdownMenuItem: ({ children, onSelect }: React.PropsWithChildren<{ onSelect?: () => void }>) => (
    <button onClick={onSelect}>{children}</button>
  ),
  DropdownMenuLabel: passthrough,
  DropdownMenuSeparator: () => null,
  DropdownMenuTrigger: passthrough,
}));
mock.module('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));
mock.module('@/components/ui/MobileOverlayPanel', () => ({
  MobileOverlayPanel: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => open ? <div>{children}</div> : null,
}));
mock.module('@/components/ui/ProviderLogo', () => ({ ProviderLogo: () => null }));
mock.module('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: passthrough }));
mock.module('@/components/ui/tooltip', () => ({
  Tooltip: passthrough,
  TooltipContent: passthrough,
  TooltipTrigger: passthrough,
}));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/model-picker/ModelPickerList', () => ({
  ModelPickerList: ({ onSelect }: React.ComponentProps<typeof import('@/components/model-picker/ModelPickerList').ModelPickerList>) => (
    <button onClick={() => onSelect({ providerID: PROVIDER_ID, modelID: MODEL_ID, model })}>{MODEL_ID}</button>
  ),
}));
mock.module('@/hooks/useRuntimeAPIs', () => ({ useIsVSCodeRuntime: () => false }));
mock.module('@/hooks/useModelLists', () => ({ useModelLists: () => ({ favoriteModelsList: [], recentModelsList: [] }) }));
mock.module('@/hooks/useIsTextTruncated', () => ({ useIsTextTruncated: () => false }));
mock.module('@/lib/device', () => ({ useDeviceInfo: () => ({ isTouch: false }) }));
mock.module('@/lib/startupTrace', () => ({ markStartupTrace: () => undefined }));

const { ModelControls } = await import('./ModelControls');
const { I18nProvider } = await import('@/lib/i18n');

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
    // The component focuses the composer through rAF on several paths.
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

const renderModelControls = async (props: React.ComponentProps<typeof ModelControls> = {}) => {
  const dom = installDom();
  const root = createRoot(dom.container);
  const theme = getThemeById('openchamber-dark');
  if (!theme) throw new Error('Expected built-in theme');
  const themeContext: ThemeContextValue = {
    currentTheme: theme, availableThemes: [theme], customThemeIds: [], customThemesLoading: false,
    isSystemPreference: false, themeMode: 'dark', lightThemeId: 'openchamber-light', darkThemeId: 'openchamber-dark',
    setTheme: () => undefined, setSystemPreference: () => undefined, setThemeMode: () => undefined,
    setLightThemePreference: () => undefined, setDarkThemePreference: () => undefined,
    reloadCustomThemes: async () => undefined, importTheme: async () => theme, deleteImportedTheme: async () => undefined,
  };
  await act(async () => root.render(
    <ThemeSystemContext.Provider value={themeContext}>
      <I18nProvider>
        <ModelControls {...props} />
      </I18nProvider>
    </ThemeSystemContext.Provider>,
  ));
  return {
    dom,
    cleanup: async () => {
      await act(async () => root.unmount());
      dom.restore();
    },
  };
};

describe('ModelControls effort restore', () => {
  beforeEach(() => {
    variantWrites.length = 0;
    overrideWrites.length = 0;
    lastSelectedWrites.length = 0;
    latestUserChoice = null;
    knownElsewhere = nothingKnownElsewhere();
    setSessionRecord(undefined);
    forcePreserveManualOverride = null;
    useSessionUIStore.setState({ currentSessionId: SESSION_ID });
    useUIStore.setState({ isMobile: false, isModelSelectorOpen: false });
    useSelectionStore.setState({
      savedVariant: undefined,
      sessionAgentSelections: new Map([[SESSION_ID, AGENT]]),
      sessionFollowedAgents: new Map(),
      sessionFollowedModels: new Map(),
    });
    useConfigStore.setState({
      providers: [provider],
      agents: [agent],
      providersLoaded: true,
      agentsLoaded: true,
      settingsDefaultsLoaded: true,
      currentProviderId: PROVIDER_ID,
      currentModelId: MODEL_ID,
      currentAgentName: AGENT,
      currentVariant: undefined,
      currentVariantSelection: { override: undefined, inherited: undefined },
      settingsDefaultVariant: undefined,
      selectionSource: 'auto',
    });
  });

  for (const missing of ['request', 'body', 'permissions', 'v2 fields']) {
    test(`renders a cached agent without ${missing}`, async () => {
      const request = agent.request;
      const body = request.body;
      const permissions = agent.permissions;
      if (missing === 'request' || missing === 'v2 fields') Reflect.deleteProperty(agent, 'request');
      if (missing === 'body') Reflect.deleteProperty(request, 'body');
      if (missing === 'permissions' || missing === 'v2 fields') Reflect.deleteProperty(agent, 'permissions');
      try {
        const { dom, cleanup } = await renderModelControls();
        try {
          expect(dom.container.querySelector('.model-controls__agent-label')?.textContent).toBe('Build');
        } finally {
          await cleanup();
        }
      } finally {
        agent.request = request;
        request.body = body;
        agent.permissions = permissions;
      }
    });
  }

  test('a draft inherits a pinned agent variant over the settings default', async () => {
    useSessionUIStore.setState({ currentSessionId: null });
    useConfigStore.setState({
      agents: [{
        ...agent,
        // v2 pins the agent's effort inside its model reference.
        model: { providerID: PROVIDER_ID, id: MODEL_ID, variant: 'high' },
      }],
      currentVariant: 'high',
      currentVariantSelection: { override: undefined, inherited: 'high' },
      settingsDefaultVariant: 'low',
    });

    const { cleanup } = await renderModelControls();
    try {
      expect(useConfigStore.getState().currentVariant).toBe('high');
      expect(useConfigStore.getState().currentVariantSelection).toEqual({
        override: undefined,
        inherited: 'high',
      });
    } finally {
      await cleanup();
    }
  });

  test('restores the concrete effort the session history carries', async () => {
    latestUserChoice = { id: 'msg-1', agent: AGENT, providerID: PROVIDER_ID, modelID: MODEL_ID, variant: 'low' };
    useUIStore.setState({ isModelSelectorOpen: true });

    const { dom, cleanup } = await renderModelControls();
    try {
      expect(dom.container.querySelector('.model-controls__model-trigger')?.closest('[data-menu-open]')?.getAttribute('data-menu-open')).toBe('true');
      expect(variantWrites).toContain('low');
      expect(variantWrites).not.toContain(null);
      // Opening a session is not a pick: the next new session must not inherit its model.
      expect(lastSelectedWrites).toEqual([]);
      expect(useSelectionStore.getState().savedVariant).toBe('low');
      expect(useConfigStore.getState().currentVariantSelection.override).toBe('low');
    } finally {
      await cleanup();
    }
  });

  test('restores the effort the session record carries, before any transcript is loaded', async () => {
    // OpenCode 2 keeps model, variant and agent on the session itself; a
    // historical session opens on that selection even when its messages
    // are not in memory yet and the last reply says nothing.
    setSessionRecord({ id: SESSION_ID, agent: AGENT, model: { providerID: PROVIDER_ID, id: MODEL_ID, variant: 'high' } });
    latestUserChoice = null;

    const { cleanup } = await renderModelControls();
    try {
      expect(variantWrites).toContain('high');
      expect(useSelectionStore.getState().savedVariant).toBe('high');
      expect(useConfigStore.getState().currentVariantSelection.override).toBe('high');
      expect(lastSelectedWrites).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test('the session record outranks an older reply in the transcript', async () => {
    setSessionRecord({ id: SESSION_ID, agent: AGENT, model: { providerID: PROVIDER_ID, id: MODEL_ID, variant: 'high' } });
    latestUserChoice = { id: 'msg-1', agent: AGENT, providerID: PROVIDER_ID, modelID: MODEL_ID, variant: 'low' };

    const { cleanup } = await renderModelControls();
    try {
      expect(useSelectionStore.getState().savedVariant).toBe('high');
      expect(variantWrites).not.toContain('low');
    } finally {
      await cleanup();
    }
  });

  test('a draft keeps its chosen model and effort through a provider discovery gap', async () => {
    useSessionUIStore.setState({ currentSessionId: null });
    useConfigStore.setState({
      providers: [], currentVariant: 'high', settingsDefaultVariant: 'high',
      currentVariantSelection: { override: 'high', inherited: 'high' },
    });
    const { dom, cleanup } = await renderModelControls();
    try {
      expect(useConfigStore.getState().currentModelId).toBe(MODEL_ID);
      expect(useConfigStore.getState().currentVariant).toBe('high');
      expect(overrideWrites).toEqual([]);
      await act(async () => { useConfigStore.setState({ providers: [provider] }); });
      expect(dom.container.textContent).toContain(MODEL_ID);
      expect(useConfigStore.getState().currentVariant).toBe('high');
      expect(overrideWrites).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test('a draft in a directory still starting shows the model, effort and agent other catalogs know', async () => {
    // OpenCode answers a directory it is still starting with part of its
    // catalog; the composer keeps what it already knows instead of a raw id
    // and "Select agent", and writes nothing while it waits.
    useSessionUIStore.setState({ currentSessionId: null });
    knownElsewhere.models.push({ ...model, name: 'GPT Five' });
    knownElsewhere.agents.push(agent);
    useConfigStore.setState({
      providers: [], agents: [], currentAgentName: undefined,
      currentVariant: 'high', settingsDefaultVariant: 'high',
      currentVariantSelection: { override: 'high', inherited: 'high' },
    });
    const { dom, cleanup } = await renderModelControls();
    try {
      expect(dom.container.querySelector('.model-controls__model-trigger')?.textContent).toContain('GPT Five');
      expect(dom.container.querySelector('.model-controls__variant-label')?.textContent?.trim()).toBe('high');
      expect(dom.container.querySelector('.model-controls__agent-label')?.textContent).toBe('Build');
      expect(useConfigStore.getState().currentVariant).toBe('high');
      expect(overrideWrites).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test('a draft keeps its picked effort while another directory resolves the automatic model', async () => {
    // Activating another directory empties the automatic model until its
    // catalog arrives; the effort the draft picked must survive that gap.
    useSessionUIStore.setState({ currentSessionId: null });
    useConfigStore.setState({
      providers: [], providersLoaded: false, currentProviderId: '', currentModelId: '',
      currentVariant: 'high', currentVariantSelection: { override: 'high', inherited: undefined },
    });
    const { cleanup } = await renderModelControls();
    try {
      expect(overrideWrites).toEqual([]);
      await act(async () => {
        useConfigStore.setState({ providers: [provider], providersLoaded: true, currentProviderId: PROVIDER_ID, currentModelId: MODEL_ID });
      });
      expect(useConfigStore.getState().currentVariantSelection.override).toBe('high');
      expect(useConfigStore.getState().currentVariant).toBe('high');
    } finally {
      await cleanup();
    }
  });

  test('a project draft inherits its own effort instead of the global default', async () => {
    useSessionUIStore.setState({ currentSessionId: null });
    useConfigStore.setState({
      currentVariant: 'high', settingsDefaultVariant: 'low',
      currentVariantSelection: { override: undefined, inherited: 'high' },
    });
    const { cleanup } = await renderModelControls();
    try {
      expect(useConfigStore.getState().currentVariant).toBe('high');
      expect(useConfigStore.getState().currentVariantSelection.override).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  for (const ready of [true, false]) {
    test(`a saved Auto ${ready ? 'wins over' : 'is not overwritten by'} the model history ran on`, async () => {
      latestUserChoice = { id: 'msg-1', agent: AGENT, providerID: PROVIDER_ID, modelID: MODEL_ID, variant: undefined };
      const selections = useSelectionStore.getState();
      // Picking Auto records it for the session and for the agent alike.
      const auto = { providerId: AUTO_PROVIDER_ID, modelId: AUTO_MODEL_ID };
      const getSaved = spyOn(selections, 'getSessionModelSelection');
      const getAgentSaved = spyOn(selections, 'getAgentModelForSession');
      getSaved.mockReturnValue(auto);
      getAgentSaved.mockReturnValue(auto);
      const saveModel = spyOn(selections, 'saveSessionModelSelection');
      useRoutingStore.setState({ available: ready, autoReady: ready });
      const { cleanup } = await renderModelControls();
      try {
        const { currentProviderId, currentModelId } = useConfigStore.getState();
        if (ready) {
          expect([currentProviderId, currentModelId]).toEqual([AUTO_PROVIDER_ID, AUTO_MODEL_ID]);
        } else {
          expect([currentProviderId, currentModelId]).toEqual([PROVIDER_ID, MODEL_ID]);
        }
        // History must never replace the saved Auto, ready or not.
        expect(saveModel.mock.calls.some(([, providerId, modelId]) => !isAutoModel(providerId, modelId))).toBe(false);
      } finally {
        await cleanup();
        for (const spy of [getSaved, getAgentSaved, saveModel]) spy.mockRestore();
        useSelectionStore.setState(selections);
        useRoutingStore.setState({ available: false, autoReady: false });
      }
    });
  }

  for (const savedVariant of ['high', null]) {
    test(`a saved effort choice wins over older message history: ${savedVariant}`, async () => {
      latestUserChoice = { id: 'old', agent: AGENT, providerID: PROVIDER_ID, modelID: MODEL_ID, variant: 'low' };
      useSelectionStore.setState({ savedVariant });
      const { cleanup } = await renderModelControls();
      try {
        expect(useSelectionStore.getState().savedVariant).toBe(savedVariant);
        expect(useConfigStore.getState().currentVariant).toBe(savedVariant ?? undefined);
      } finally {
        await cleanup();
      }
    });
  }

  for (const mobile of [false, true]) {
    test(`keeps loading labels until selections arrive (${mobile ? 'mobile' : 'desktop'})`, async () => {
      useUIStore.setState({ isMobile: mobile });
      useSessionUIStore.setState({ currentSessionId: null });
      useConfigStore.setState({
        providers: [], agents: [], providersLoaded: false, agentsLoaded: false, settingsDefaultsLoaded: false,
        currentProviderId: '', currentModelId: '', currentAgentName: undefined,
      });
      const { dom, cleanup } = await renderModelControls();
      const modelLabel = () => dom.container.querySelector('.model-controls__model-trigger')?.textContent;
      const agentLabel = () => dom.container.querySelector('.model-controls__agent-label')?.textContent;
      try {
        expect(modelLabel()).toContain('Loading');
        expect(agentLabel()).toContain('Loading');
        await act(async () => { useConfigStore.setState({ providers: [provider], providersLoaded: true }); });
        expect(modelLabel()).toContain('Loading');
        expect(agentLabel()).toContain('Loading');
        await act(async () => {
          useConfigStore.setState({
            settingsDefaultsLoaded: true, currentProviderId: PROVIDER_ID, currentModelId: MODEL_ID,
            currentAgentName: AGENT,
          });
        });
        expect(modelLabel()).toContain(MODEL_ID);
        expect(agentLabel()).toBe('Build');
        await act(async () => { useConfigStore.setState({ agents: [agent], agentsLoaded: true }); });
        expect(modelLabel()).toContain(MODEL_ID);
        expect(agentLabel()).toBe('Build');
      } finally {
        await cleanup();
      }
    });

    test(`shows known choices before catalogs arrive (${mobile ? 'mobile' : 'desktop'})`, async () => {
      useUIStore.setState({ isMobile: mobile });
      useSessionUIStore.setState({ currentSessionId: null });
      useConfigStore.setState({ providers: [], agents: [], providersLoaded: false, agentsLoaded: false });
      const { dom, cleanup } = await renderModelControls();
      try {
        expect(dom.container.querySelector('.model-controls__model-trigger')?.textContent?.toLowerCase()).toContain(MODEL_ID);
        expect(dom.container.querySelector('.model-controls__agent-label')?.textContent).toBe('Build');
      } finally {
        await cleanup();
      }
    });
  }

  test('enables the agent picker before providers and distinguishes a completed empty catalog', async () => {
    useUIStore.setState({ isMobile: true });
    useSessionUIStore.setState({ currentSessionId: null });
    useConfigStore.setState({
      providers: [], providersLoaded: false, agents: [agent], agentsLoaded: true,
      currentProviderId: '', currentModelId: '', currentAgentName: AGENT,
    });
    const { dom, cleanup } = await renderModelControls();
    try {
      expect(dom.container.querySelector('.model-controls__agent-trigger')?.hasAttribute('disabled')).toBe(false);
      expect(dom.container.querySelector('.model-controls__model-trigger')?.hasAttribute('disabled')).toBe(true);
      expect(dom.container.querySelector('.model-controls__model-trigger')?.textContent).toContain('Loading');
      await act(async () => {
        useConfigStore.setState({ providersLoaded: true, agents: [], currentAgentName: undefined });
      });
      expect(dom.container.querySelector('.model-controls__model-trigger')?.textContent?.toLowerCase()).toContain('select model');
      expect(dom.container.querySelector('.model-controls__agent-label')?.textContent?.toLowerCase()).toContain('select agent');
    } finally {
      await cleanup();
    }
  });

  test('history without an effort records no choice instead of an explicit Default', async () => {
    latestUserChoice = { id: 'msg-2', agent: AGENT, providerID: PROVIDER_ID, modelID: MODEL_ID };

    const { cleanup } = await renderModelControls();
    try {
      expect(variantWrites).not.toContain(null);
      expect(useSelectionStore.getState().savedVariant).toBe(undefined);
      expect(useConfigStore.getState().currentVariantSelection.override).toBe(undefined);
    } finally {
      await cleanup();
    }
  });

  test('does not reapply persisted session selections after a live agent change', async () => {
    const selections = useSelectionStore.getState();
    const getSessionModel = spyOn(selections, 'getSessionModelSelection');
    const { cleanup } = await renderModelControls();
    try {
      const callsAfterHydration = getSessionModel.mock.calls.length;

      await act(async () => useConfigStore.setState({ currentAgentName: 'plan' }));

      expect(getSessionModel.mock.calls.length).toBe(callsAfterHydration);
      expect(useConfigStore.getState().currentAgentName).toBe('plan');
    } finally {
      getSessionModel.mockRestore();
      await cleanup();
    }
  });

  test('the echo of a Default send does not erase the recorded Default', async () => {
    // The reported repro. The send under "Default" carried no effort, so the
    // message it echoes back carries none either, and its model matches the one
    // the send saved — which is exactly when the manual-override guard declines
    // to protect the selection and the history branch runs.
    latestUserChoice = { id: 'msg-echo', agent: AGENT, providerID: PROVIDER_ID, modelID: MODEL_ID };
    useSelectionStore.setState({ savedVariant: null });
    useConfigStore.setState({
      selectionSource: 'manual',
      settingsDefaultVariant: 'low',
      currentVariantSelection: { override: null, inherited: 'low' },
    });

    const { cleanup } = await renderModelControls();
    try {
      expect(useSelectionStore.getState().savedVariant).toBeNull();
      expect(useConfigStore.getState().currentVariantSelection.override).toBeNull();
      expect(useConfigStore.getState().currentVariant).toBe(undefined);
    } finally {
      await cleanup();
    }
  });

  test('a preserved manual override keeps a recorded explicit Default', async () => {
    latestUserChoice = { id: 'msg-3', agent: AGENT, providerID: PROVIDER_ID, modelID: MODEL_ID, variant: 'high' };
    forcePreserveManualOverride = true;
    useSelectionStore.setState({ savedVariant: null });
    useConfigStore.setState({ selectionSource: 'manual' });

    const { cleanup } = await renderModelControls();
    try {
      expect(useSelectionStore.getState().savedVariant).toBeNull();
      expect(useConfigStore.getState().currentVariantSelection.override).toBeNull();
    } finally {
      await cleanup();
    }
  });

  for (const [isMobile, variant] of [
    [false, 'low'], [true, null],
  ] as const) {
    test(`controlled BTW selection stays independent (mobile: ${isMobile}, effort: ${variant})`, async () => {
      const btwSessionId = 'btw-pending:ses_restore';
      latestUserChoice = { id: 'msg-main', agent: AGENT, providerID: PROVIDER_ID, modelID: MODEL_ID, variant: 'high' };
      useUIStore.setState({ isMobile, isModelSelectorOpen: true });
      useConfigStore.setState({
        currentProviderId: 'main-provider', currentModelId: 'main-model',
        currentVariant: 'low', currentVariantSelection: { override: undefined, inherited: 'low' },
      });
      const selections = useSelectionStore.getState();
      const saveModel = spyOn(selections, 'saveSessionModelSelection');
      const saveAgentModel = spyOn(selections, 'saveAgentModelForSession');
      const saveVariant = spyOn(selections, 'saveAgentModelVariantForSession');
      const { dom, cleanup } = await renderModelControls({
        sessionId: btwSessionId,
        selection: { model: { providerId: PROVIDER_ID, modelId: MODEL_ID }, agent: 'plan', variant },
      });
      try {
        expect(overrideWrites).toEqual([]);
        expect(variantWrites).toEqual([]);
        expect(saveModel.mock.calls).toEqual([]);
        expect(dom.container.querySelector('.model-controls__agent-label')).toBeNull();
        expect(dom.container.querySelector('.model-controls__variant-label')?.textContent?.trim()).toBe(variant ?? 'Default');
        if (!isMobile) {
          expect(dom.container.querySelector('.model-controls__model-trigger')?.closest('[data-menu-open]')?.getAttribute('data-menu-open')).toBe('false');
        }

        await act(async () => dom.container.querySelector<HTMLButtonElement>('.model-controls__model-trigger')?.click());
        const modelButton = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button:not(.model-controls__model-trigger)')).find((button) => button.textContent?.trim() === MODEL_ID);
        await act(async () => modelButton?.click());
        expect(saveModel.mock.calls.at(-1)).toEqual([btwSessionId, PROVIDER_ID, MODEL_ID]);
        expect(saveAgentModel.mock.calls.at(-1)).toEqual([btwSessionId, 'plan', PROVIDER_ID, MODEL_ID]);

        await act(async () => dom.container.querySelector<HTMLButtonElement>('.model-controls__variant-trigger')?.click());
        const defaultButton = Array.from(dom.container.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Default');
        await act(async () => defaultButton?.click());
        expect(saveVariant.mock.calls.at(-1)).toEqual([btwSessionId, 'plan', PROVIDER_ID, MODEL_ID, null]);
        const config = useConfigStore.getState();
        expect([config.currentProviderId, config.currentModelId, config.currentAgentName, config.currentVariant])
          .toEqual(['main-provider', 'main-model', AGENT, 'low']);
        expect(overrideWrites).toEqual([]);
      } finally {
        await cleanup();
        for (const write of [saveModel, saveAgentModel, saveVariant]) write.mockRestore();
        useSelectionStore.setState(selections);
      }
    });
  }

  describe('following the session agent', () => {
    const OTHER_MODEL_ID = 'gpt-other';
    const recordOn = (agentName: string) => ({
      id: SESSION_ID, agent: agentName, model: { providerID: PROVIDER_ID, id: MODEL_ID, variant: 'high' },
    });
    const agentLabel = (container: HTMLElement) => container.querySelector('.model-controls__agent-label')?.textContent;
    /** The picker writes both stores, like `handleAgentChange`. */
    const pickAgent = (agentName: string) => useConfigStore.getState().setAgent(agentName);
    const switchSession = (sessionId: string) => act(async () => useSessionUIStore.setState({ currentSessionId: sessionId }));

    beforeEach(() => {
      useConfigStore.setState({ agents: [agent, planAgent, reviewAgent] });
    });

    test('a switch another client or a plugin made moves the picker, and keeps the session model', async () => {
      setSessionRecord(recordOn(AGENT));
      const selections = useSelectionStore.getState();
      // What the session last ran on with Plan is not what it runs on now.
      const getAgentModel = spyOn(selections, 'getAgentModelForSession');
      getAgentModel.mockImplementation((_sessionId: string, agentName: string) => (
        agentName === 'plan' ? { providerId: PROVIDER_ID, modelId: OTHER_MODEL_ID } : { providerId: PROVIDER_ID, modelId: MODEL_ID }
      ));
      useConfigStore.setState({ providers: [{ ...provider, models: [model, { ...model, id: OTHER_MODEL_ID, name: OTHER_MODEL_ID }] }] });
      const { dom, cleanup } = await renderModelControls();
      try {
        expect(agentLabel(dom.container)).toBe('Build');

        await act(async () => setSessionRecord(recordOn('plan')));
        // The agent-change effect waits 50ms before it applies a remembered model.
        await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));

        expect(agentLabel(dom.container)).toBe('Plan');
        expect(useConfigStore.getState().currentAgentName).toBe('plan');
        expect(useSelectionStore.getState().getSessionAgentSelection(SESSION_ID)).toBe('plan');
        expect(useConfigStore.getState().currentModelId).toBe(MODEL_ID);
      } finally {
        getAgentModel.mockRestore();
        await cleanup();
      }
    });

    test('a pick made after the session record survives reopening the session', async () => {
      setSessionRecord(recordOn(AGENT));
      const { dom, cleanup } = await renderModelControls();
      try {
        await act(async () => pickAgent('plan'));
        await switchSession('ses_other');
        await switchSession(SESSION_ID);

        expect(agentLabel(dom.container)).toBe('Plan');
        expect(useConfigStore.getState().currentAgentName).toBe('plan');
      } finally {
        await cleanup();
      }
    });

    test('a newer switch wins over a pick that was not sent', async () => {
      setSessionRecord(recordOn(AGENT));
      const { dom, cleanup } = await renderModelControls();
      try {
        await act(async () => pickAgent('plan'));
        await act(async () => setSessionRecord(recordOn('review')));

        expect(agentLabel(dom.container)).toBe('Review');
        expect(useConfigStore.getState().currentAgentName).toBe('review');
      } finally {
        await cleanup();
      }
    });

    test('the picker follows a switch while a manual model choice is kept', async () => {
      setSessionRecord(recordOn(AGENT));
      forcePreserveManualOverride = true;
      useConfigStore.setState({ selectionSource: 'manual' });
      const { dom, cleanup } = await renderModelControls();
      try {
        await act(async () => setSessionRecord(recordOn('plan')));

        expect(agentLabel(dom.container)).toBe('Plan');
        expect(useConfigStore.getState().currentAgentName).toBe('plan');
      } finally {
        await cleanup();
      }
    });

    const THIRD_MODEL_ID = 'gpt-third';
    const recordWith = (modelId: string, agentName = AGENT) => ({
      id: SESSION_ID, agent: agentName, model: { providerID: PROVIDER_ID, id: modelId },
    });
    const withModels = () => useConfigStore.setState({
      providers: [{ ...provider, models: [model, ...[OTHER_MODEL_ID, THIRD_MODEL_ID].map((id) => ({ ...model, id, name: id }))] }],
    });

    test('a model switch made elsewhere wins over a model picked here, an unchanged record does not', async () => {
      withModels();
      // The picker holds a model the session has not been sent with yet.
      useConfigStore.setState({ selectionSource: 'manual' });
      setSessionRecord(recordWith(OTHER_MODEL_ID));
      const { cleanup } = await renderModelControls();
      try {
        expect(useConfigStore.getState().currentModelId).toBe(MODEL_ID);

        await act(async () => setSessionRecord(recordWith(THIRD_MODEL_ID)));
        expect(useConfigStore.getState().currentModelId).toBe(THIRD_MODEL_ID);
        // A switch made elsewhere is not this person's pick.
        expect(lastSelectedWrites).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    for (const change of ['agent', 'model'] as const) {
      test(`Auto stays on screen when the session switches ${change}`, async () => {
        withModels();
        const selections = useSelectionStore.getState();
        const auto = { providerId: AUTO_PROVIDER_ID, modelId: AUTO_MODEL_ID };
        const spies = [spyOn(selections, 'getSessionModelSelection'), spyOn(selections, 'getAgentModelForSession')];
        for (const spy of spies) spy.mockReturnValue(auto);
        const saveModel = spyOn(selections, 'saveSessionModelSelection');
        useRoutingStore.setState({ available: true, autoReady: true });
        useConfigStore.setState({ currentProviderId: AUTO_PROVIDER_ID, currentModelId: AUTO_MODEL_ID });
        setSessionRecord(recordWith(OTHER_MODEL_ID));
        const { cleanup } = await renderModelControls();
        try {
          await act(async () => setSessionRecord(change === 'agent'
            ? recordWith(OTHER_MODEL_ID, 'plan')
            // The router moving the session to another model each turn.
            : recordWith(THIRD_MODEL_ID)));
          await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));

          const { currentProviderId, currentModelId, currentAgentName } = useConfigStore.getState();
          expect([currentProviderId, currentModelId]).toEqual([AUTO_PROVIDER_ID, AUTO_MODEL_ID]);
          expect(saveModel.mock.calls.some(([, providerId, modelId]) => !isAutoModel(providerId, modelId))).toBe(false);
          // Auto hides the agent picker; the agent still follows for sends.
          if (change === 'agent') expect(currentAgentName).toBe('plan');
        } finally {
          await cleanup();
          for (const spy of [...spies, saveModel]) spy.mockRestore();
          useSelectionStore.setState(selections);
          useRoutingStore.setState({ available: false, autoReady: false });
        }
      });
    }
  });
});
