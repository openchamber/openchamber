import * as React from 'react';
import { useConfigStore } from '@/stores/useConfigStore';
import { useAgentsStore } from '@/stores/useAgentsStore';
import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';
import { resolveWorktreeSessionSelection } from '@/lib/worktreeSessionSelection';

export type InitialSessionOverridesOptions = {
  /** Whether the host dialog is currently open. Used to gate load + prefill. */
  open: boolean;
  /** Directory passed to loadProviders/loadConfigAgents. Use null to skip per-directory loading. */
  projectDirectory: string | null;
  /** Source tag for the loadProviders trace (e.g. 'forkSessionDialog'). */
  source: string;
  /**
   * Optional extra deps that, when toggled together with `open`, re-run the prefill.
   * Use this for gates like `createInWorktree` that should reset the selectors to defaults.
   */
  extraPrefillTriggers?: ReadonlyArray<unknown>;
};

export type InitialSessionOverrides = {
  providerID: string;
  modelID: string;
  variant: string;
  agent: string;
  setProviderID: (next: string) => void;
  setModelID: (next: string) => void;
  setVariant: (next: string) => void;
  setAgent: (next: string) => void;
  /** Helper: re-prefill from current config defaults. Useful for explicit triggers. */
  prefillFromDefaults: () => void;
  providers: ReturnType<typeof useConfigStore.getState>['providers'];
  variantOptions: string[];
  hasVariantOptions: boolean;
  agentFilter: (candidate: { mode?: string }) => boolean;
  /** Set provider+model together; clears variant (matches ThinkingPill onModelChange pattern). */
  setProviderAndModel: (nextProviderID: string, nextModelID: string) => void;
};

export const createInitialSessionOverridePrefillGuard = () => {
  let initialSelectionEstablished = false;
  let manuallyEdited = false;

  return {
    reset: () => {
      initialSelectionEstablished = false;
      manuallyEdited = false;
    },
    markInitialSelection: (established: boolean) => {
      initialSelectionEstablished = established;
    },
    markManualEdit: () => {
      manuallyEdited = true;
    },
    shouldRetryForAgents: (hasAgents: boolean) => (
      hasAgents && !initialSelectionEstablished && !manuallyEdited
    ),
  };
};

/**
 * Shared session-override state used by dialogs that let the user pick a
 * provider / model / variant / agent before kicking off a new session or worktree.
 *
 * Encapsulates:
 *   - loading providers + agents when the dialog opens
   *   - prefilling selector defaults through the shared validated selection cascade:
   *     settings, current selection, last-used selection, then first available model
   *   - reapplying that cascade when a selected provider/model is invalidated by a refresh
 *   - resetting the variant when the selected model no longer offers it
 *   - exposing a stable agentFilter for primary-mode agents and a
 *     setProviderAndModel helper that mirrors the ThinkingPill pattern
 *
 * Initial state is read from the config store once via getState() so background
 * config refreshes do not clobber in-progress user edits.
 */
export const useInitialSessionOverrides = (
  options: InitialSessionOverridesOptions
): InitialSessionOverrides => {
  const { open, projectDirectory, source, extraPrefillTriggers = [] } = options;

  // Reactive: providers (so the fallback effect can re-validate selection)
  const providers = useConfigStore((state) => state.providers);
  // Agent availability completes the initial shared resolver cascade when
  // providers arrive before the asynchronous agent load.
  const configAgents = useConfigStore((state) => state.agents);
  // Stable function references
  const loadProviders = useConfigStore((state) => state.loadProviders);
  const loadConfigAgents = useConfigStore((state) => state.loadAgents);
  const loadAgentsStoreAgents = useAgentsStore((state) => state.loadAgents);

  // Initial state snapshot — read once, don't subscribe to background config changes
  // (background config refreshes would otherwise clobber in-progress user edits).
  const initial = React.useMemo(() => {
    const s = useConfigStore.getState();
    return {
      providerID: s.currentProviderId,
      modelID: s.currentModelId,
      variant: s.currentVariant || '',
      agent: s.currentAgentName || '',
    };
  }, []);

  const [providerID, setProviderID] = React.useState(initial.providerID);
  const [modelID, setModelID] = React.useState(initial.modelID);
  const [variant, setVariant] = React.useState(initial.variant);
  const [agent, setAgent] = React.useState(initial.agent);
  const prefillGuard = React.useRef(createInitialSessionOverridePrefillGuard());

  // Resolve defaults from the shared selection cascade. Re-runs on `open`
  // transitions and any extraPrefillTriggers change.
  const applyDefaultPrefill = React.useCallback(() => {
    const s = useConfigStore.getState();
    const selection = resolveWorktreeSessionSelection(s);
    setProviderID(selection?.providerID ?? '');
    setModelID(selection?.modelID ?? '');
    setVariant(selection?.variant ?? '');
    setAgent(selection?.agentName ?? '');
    return selection;
  }, []);

  const prefillFromDefaults = React.useCallback(() => {
    prefillGuard.current.reset();
    const selection = applyDefaultPrefill();
    prefillGuard.current.markInitialSelection(selection !== null);
    return selection;
  }, [applyDefaultPrefill]);

  // Load on open
  React.useEffect(() => {
    if (!open) return;
    void loadProviders({ directory: projectDirectory, source });
    void loadConfigAgents({ directory: projectDirectory });
    void loadAgentsStoreAgents();
  }, [open, loadProviders, loadConfigAgents, loadAgentsStoreAgents, projectDirectory, source]);

  // Prefill on open + extra triggers
  React.useEffect(() => {
    if (!open) {
      prefillGuard.current.reset();
      return;
    }
    prefillFromDefaults();
    // extraPrefillTriggers are flattened into deps so the effect re-runs on each
    // declared trigger (e.g. when createInWorktree toggles back on).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefillFromDefaults, ...extraPrefillTriggers]);

  // A provider response can precede `loadAgents`, making the first resolver
  // attempt intentionally return null. Retry only until that first valid
  // selection is established so later background refreshes cannot overwrite
  // dialog edits.
  React.useEffect(() => {
    if (!open || !prefillGuard.current.shouldRetryForAgents(configAgents.length > 0)) return;
    prefillGuard.current.markInitialSelection(applyDefaultPrefill() !== null);
  }, [open, configAgents, applyDefaultPrefill]);

  // Preserve valid user choices. If a refresh invalidates one, return to the
  // shared cascade rather than promoting an arbitrary provider into an override.
  React.useEffect(() => {
    if (!open || providers.length === 0) return;

    const provider = providers.find((p) => p.id === providerID) ?? providers[0];
    const models = Array.isArray(provider?.models) ? provider.models : [];
    const hasModel = models.some((m) => m.id === modelID);

    if (provider?.id === providerID && hasModel) return;

    const selection = resolveWorktreeSessionSelection(useConfigStore.getState());
    setProviderID(selection?.providerID ?? '');
    setModelID(selection?.modelID ?? '');
    setVariant(selection?.variant ?? '');
    setAgent(selection?.agentName ?? '');
  }, [open, providers, providerID, modelID]);

  // Reset variant when the model no longer offers it
  const variantOptions = React.useMemo(() => {
    const provider = providers.find((p) => p.id === providerID);
    const model = provider?.models?.find((m) => m.id === modelID) as
      | { variants?: Record<string, unknown> }
      | undefined;
    return model?.variants ? Object.keys(model.variants) : [];
  }, [providers, providerID, modelID]);

  const hasVariantOptions = variantOptions.length > 0;

  React.useEffect(() => {
    if (!variant) return;
    if (!hasVariantOptions || !variantOptions.includes(variant)) {
      setVariant('');
    }
  }, [hasVariantOptions, variantOptions, variant]);

  const agentFilter = React.useCallback(
    (candidate: { mode?: string }) => isPrimaryMode(candidate.mode),
    []
  );

  const setProviderAndModel = React.useCallback((nextProviderID: string, nextModelID: string) => {
    prefillGuard.current.markManualEdit();
    setProviderID(nextProviderID);
    setModelID(nextModelID);
    setVariant('');
  }, []);

  const setProviderIDWithManualGuard = React.useCallback((next: string) => {
    prefillGuard.current.markManualEdit();
    setProviderID(next);
  }, []);

  const setModelIDWithManualGuard = React.useCallback((next: string) => {
    prefillGuard.current.markManualEdit();
    setModelID(next);
  }, []);

  const setVariantWithManualGuard = React.useCallback((next: string) => {
    prefillGuard.current.markManualEdit();
    setVariant(next);
  }, []);

  const setAgentWithManualGuard = React.useCallback((next: string) => {
    prefillGuard.current.markManualEdit();
    setAgent(next);
  }, []);

  return {
    providerID,
    modelID,
    variant,
    agent,
    setProviderID: setProviderIDWithManualGuard,
    setModelID: setModelIDWithManualGuard,
    setVariant: setVariantWithManualGuard,
    setAgent: setAgentWithManualGuard,
    prefillFromDefaults,
    providers,
    variantOptions,
    hasVariantOptions,
    agentFilter,
    setProviderAndModel,
  };
};
