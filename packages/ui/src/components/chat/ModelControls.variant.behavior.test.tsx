import React, { act } from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
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
const agent = { name: AGENT, mode: 'primary' as const };

let latestUserChoice: UserModelChoice | null = null;
let forcePreserveManualOverride: boolean | null = null;

/** Every effort written for the session, in order, including `undefined`. */
const variantWrites: VariantChoice[] = [];
/** Every `(override, inherited)` pair pushed into the config store. */
const overrideWrites: Array<{ override: VariantChoice; inherited: string | undefined }> = [];

type ConfigState = {
  providers: typeof provider[];
  agents: typeof agent[];
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
  getCurrentAgent: () => typeof agent;
  getVisibleAgents: () => typeof agent[];
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
  saveSessionModelSelection: () => void;
  saveSessionAgentSelection: () => void;
  saveAgentModelForSession: () => void;
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

const useSessionUIStore = create(() => ({
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
  DropdownMenu: passthrough,
  DropdownMenuContent: passthrough,
  DropdownMenuItem: passthrough,
  DropdownMenuLabel: passthrough,
  DropdownMenuSeparator: () => null,
  DropdownMenuTrigger: passthrough,
}));
mock.module('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));
mock.module('@/components/ui/MobileOverlayPanel', () => ({ MobileOverlayPanel: passthrough }));
mock.module('@/components/ui/ProviderLogo', () => ({ ProviderLogo: () => null }));
mock.module('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: passthrough }));
mock.module('@/components/ui/tooltip', () => ({
  Tooltip: passthrough,
  TooltipContent: passthrough,
  TooltipTrigger: passthrough,
}));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/model-picker/ModelPickerList', () => ({ ModelPickerList: () => null }));
mock.module('@/hooks/useRuntimeAPIs', () => ({ useIsVSCodeRuntime: () => false }));
mock.module('@/hooks/useModelLists', () => ({ useModelLists: () => ({ favoriteModels: [], recentModels: [] }) }));
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

const renderModelControls = async () => {
  const dom = installDom();
  const root = createRoot(dom.container);
  await act(async () => root.render(
    <I18nProvider>
      <ModelControls />
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
    useSelectionStore.setState({ savedVariant: undefined });
    useConfigStore.setState({
      currentProviderId: PROVIDER_ID,
      currentModelId: MODEL_ID,
      currentAgentName: AGENT,
      currentVariant: undefined,
      currentVariantSelection: { override: undefined, inherited: undefined },
      settingsDefaultVariant: undefined,
      selectionSource: 'auto',
    });
  });

  test('restores the concrete effort the session history carries', async () => {
    latestUserChoice = { id: 'msg-1', agent: AGENT, providerID: PROVIDER_ID, modelID: MODEL_ID, variant: 'low' };

    const { cleanup } = await renderModelControls();
    try {
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
});
