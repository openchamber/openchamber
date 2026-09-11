import React, { act } from 'react';
import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { create } from 'zustand';

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
type Agent = {
  name: string;
  mode: 'primary';
  model?: { providerID: string; modelID: string };
  variant?: string;
};
const agent: Agent = { name: AGENT, mode: 'primary' };

let latestUserChoice: UserModelChoice | null = null;
let forcePreserveManualOverride: boolean | null = null;

/** Every effort written for the session, in order, including `undefined`. */
const variantWrites: VariantChoice[] = [];
/** Every `(override, inherited)` pair pushed into the config store. */
const overrideWrites: Array<{ override: VariantChoice; inherited: string | undefined }> = [];

type ConfigState = {
  providers: typeof provider[];
  agents: Agent[];
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
  setAgent: (agentName: string) => void;
  setCurrentVariant: (variant: string | undefined) => void;
  setCurrentVariantOverride: (override: VariantChoice, inherited: string | undefined) => void;
  getCurrentProvider: () => typeof provider;
  getCurrentAgent: () => Agent;
  getVisibleAgents: () => Agent[];
  getCurrentModelVariants: () => string[];
  getModelMetadata: () => undefined;
};

const useConfigStore = create<ConfigState>((set) => ({
  providers: [provider],
  agents: [agent],
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
  setAgent: (agentName) => set({ currentAgentName: agentName }),
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
  getCurrentProvider: () => provider,
  getCurrentAgent: () => agent,
  getVisibleAgents: () => [agent],
  getCurrentModelVariants: () => Object.keys(model.variants),
  getModelMetadata: () => undefined,
}));

type SelectionState = {
  savedVariant: VariantChoice;
  sessionAgentSelections: Map<string, string>;
  getSessionModelSelection: () => { providerId: string; modelId: string } | null;
  getSessionAgentSelection: () => string | null;
  getAgentModelForSession: () => { providerId: string; modelId: string } | null;
  getAgentModelVariantForSession: () => VariantChoice;
  saveSessionModelSelection: (sessionId: string, providerId: string, modelId: string) => void;
  saveSessionAgentSelection: () => void;
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
  getSessionModelSelection: () => ({ providerId: PROVIDER_ID, modelId: MODEL_ID }),
  getSessionAgentSelection: () => AGENT,
  getAgentModelForSession: () => ({ providerId: PROVIDER_ID, modelId: MODEL_ID }),
  getAgentModelVariantForSession: () => get().savedVariant,
  saveSessionModelSelection: () => undefined,
  saveSessionAgentSelection: () => undefined,
  saveAgentModelForSession: () => undefined,
  saveAgentModelVariantForSession: (_sessionId, _agentName, _providerId, _modelId, variant) => {
    variantWrites.push(variant);
    set({ savedVariant: variant });
  },
}));

const useSessionUIStore = create<{
  currentSessionId: string | null;
  getDirectoryForSession: () => string;
}>(() => ({
  currentSessionId: SESSION_ID,
  getDirectoryForSession: () => '/workspace/project',
}));

const useUIStore = create(() => ({
  isMobile: false,
  isModelSelectorOpen: false,
  hiddenModels: [],
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

mock.module('@/stores/useConfigStore', () => ({ useConfigStore }));
mock.module('@/sync/selection-store', () => ({ useSelectionStore }));
mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore }));
mock.module('@/stores/useUIStore', () => ({ useUIStore }));
mock.module('@/stores/contextStore', () => ({
  useContextStore: <T,>(selector: (state: { hasHydrated: boolean }) => T): T => selector({ hasHydrated: true }),
}));

mock.module('@/sync/sync-context', () => ({
  useSessionMessages: () => [],
  useSessionRenderable: () => true,
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
mock.module('@/hooks/useOpenCodeReadiness', () => ({
  useOpenCodeReadiness: () => ({ isReady: true, isUnavailable: false }),
}));
mock.module('@/lib/device', () => ({ useDeviceInfo: () => ({ isTouch: false }) }));
mock.module('@/lib/desktop', () => ({ isDesktopShell: () => false }));
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
  await act(async () => root.render(
    <I18nProvider>
      <ModelControls {...props} />
    </I18nProvider>,
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
    latestUserChoice = null;
    forcePreserveManualOverride = null;
    useUIStore.setState({ isMobile: false, isModelSelectorOpen: false });
    useSelectionStore.setState({ savedVariant: undefined });
    useSessionUIStore.setState({ currentSessionId: SESSION_ID });
    useConfigStore.setState({
      agents: [agent],
      currentProviderId: PROVIDER_ID,
      currentModelId: MODEL_ID,
      currentAgentName: AGENT,
      currentVariant: undefined,
      currentVariantSelection: { override: undefined, inherited: undefined },
      settingsDefaultVariant: undefined,
      selectionSource: 'auto',
    });
  });

  test('a draft inherits a pinned agent variant over the settings default', async () => {
    useSessionUIStore.setState({ currentSessionId: null });
    useConfigStore.setState({
      agents: [{
        ...agent,
        model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
        variant: 'high',
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
      expect(useSelectionStore.getState().savedVariant).toBe('low');
      expect(useConfigStore.getState().currentVariantSelection.override).toBe('low');
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
});
