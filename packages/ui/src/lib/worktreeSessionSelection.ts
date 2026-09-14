import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSelectionStore } from '@/sync/selection-store';

export type WorktreeSessionOverrides = {
  agentName?: string;
  providerID?: string;
  modelID?: string;
  variant?: string;
};

export type WorktreeSessionSelection = {
  agentName: string;
  providerID: string;
  modelID: string;
  variant?: string;
};

type ModelSelectionCandidate = {
  providerID?: string;
  modelID?: string;
} | null | undefined;

type WorktreeSessionConfigState = {
  providers: Array<{
    id: string;
    models: Array<{ id: string; variants?: Record<string, unknown> }>;
  }>;
  settingsDefaultAgent?: string;
  settingsDefaultModel?: string;
  settingsDefaultVariant?: string;
  currentProviderId?: string;
  currentModelId?: string;
  currentVariant?: string;
  getVisibleAgents: () => Array<{ name: string }>;
  getModelMetadata: (providerID: string, modelID: string) => unknown | undefined;
};

const resolveValidModelSelection = (
  configState: WorktreeSessionConfigState,
  candidate: ModelSelectionCandidate,
): { providerID: string; modelID: string } | null => {
  if (!candidate?.providerID || !candidate.modelID) {
    return null;
  }

  return configState.getModelMetadata(candidate.providerID, candidate.modelID)
    ? { providerID: candidate.providerID, modelID: candidate.modelID }
    : null;
};

const resolveValidSettingsModelSelection = (
  configState: WorktreeSessionConfigState,
): { providerID: string; modelID: string } | null => {
  const settingsDefaultModel = configState.settingsDefaultModel;
  if (!settingsDefaultModel) {
    return null;
  }

  const parsed = parseModelIdentifier(settingsDefaultModel);
  if (!parsed) {
    return null;
  }

  return resolveValidModelSelection(configState, {
    providerID: parsed.providerId,
    modelID: parsed.modelId,
  });
};

const resolveFirstValidModelSelection = (
  configState: WorktreeSessionConfigState,
): { providerID: string; modelID: string } | null => {
  for (const provider of configState.providers) {
    for (const model of provider.models) {
      const selection = resolveValidModelSelection(configState, {
        providerID: provider.id,
        modelID: model.id,
      });
      if (selection) {
        return selection;
      }
    }
  }
  return null;
};

const resolveValidVariant = (
  configState: WorktreeSessionConfigState,
  providerID: string,
  modelID: string,
  candidate: string | undefined,
): string | undefined => {
  if (!candidate) {
    return undefined;
  }

  const provider = configState.providers.find((item) => item.id === providerID);
  const model = provider?.models.find((item) => item.id === modelID);
  return model?.variants && Object.prototype.hasOwnProperty.call(model.variants, candidate)
    ? candidate
    : undefined;
};

export const isValidWorktreeSessionSelection = (
  configState: WorktreeSessionConfigState,
  selection: WorktreeSessionSelection,
): boolean => {
  if (!configState.getVisibleAgents().some((agent) => agent.name === selection.agentName)) {
    return false;
  }

  if (!resolveValidModelSelection(configState, selection)) {
    return false;
  }

  return selection.variant === undefined
    || resolveValidVariant(configState, selection.providerID, selection.modelID, selection.variant) === selection.variant;
};

export const resolveWorktreeSessionSelection = (
  configState: WorktreeSessionConfigState = useConfigStore.getState(),
  overrides?: WorktreeSessionOverrides,
  lastUsedProvider: ModelSelectionCandidate = useSelectionStore.getState().lastUsedProvider,
): WorktreeSessionSelection | null => {
  const visibleAgents = configState.getVisibleAgents();
  const overrideAgent = overrides?.agentName
    ? visibleAgents.find((agent) => agent.name === overrides.agentName)
    : undefined;
  const settingsAgent = configState.settingsDefaultAgent
    ? visibleAgents.find((agent) => agent.name === configState.settingsDefaultAgent)
    : undefined;
  const agentName = overrideAgent?.name
    ?? settingsAgent?.name
    ?? visibleAgents.find((agent) => agent.name === 'build')?.name
    ?? visibleAgents[0]?.name;
  if (!agentName) {
    return null;
  }

  const modelSelection =
    resolveValidModelSelection(configState, overrides)
    ?? resolveValidSettingsModelSelection(configState)
    ?? resolveValidModelSelection(configState, {
      providerID: configState.currentProviderId,
      modelID: configState.currentModelId,
    })
    ?? resolveValidModelSelection(configState, lastUsedProvider)
    ?? resolveFirstValidModelSelection(configState);
  if (!modelSelection) {
    return null;
  }

  const isCurrentModel =
    modelSelection.providerID === configState.currentProviderId
    && modelSelection.modelID === configState.currentModelId;
  const explicitVariant = resolveValidVariant(
    configState,
    modelSelection.providerID,
    modelSelection.modelID,
    overrides?.variant,
  );
  const settingsVariant = resolveValidVariant(
    configState,
    modelSelection.providerID,
    modelSelection.modelID,
    configState.settingsDefaultVariant,
  );
  const currentVariant = isCurrentModel
    ? resolveValidVariant(
      configState,
      modelSelection.providerID,
      modelSelection.modelID,
      configState.currentVariant,
    )
    : undefined;

  return {
    agentName,
    ...modelSelection,
    variant: overrides?.variant === ''
      ? undefined
      : explicitVariant ?? settingsVariant ?? currentVariant,
  };
};
