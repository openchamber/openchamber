import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { resolveEffortChoice, resolveEffortForModelSelection } from '@/lib/modelEfforts';
import { modelVariantNames } from '@/lib/modelVariants';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSelectionStore } from '@/sync/selection-store';

/**
 * The model, agent and variant a session the app starts on its own sends with:
 * the defaults from Settings, falling back to what the user picked last. Used
 * where no composer is involved, such as an extension starting a session or the
 * Memory panel's tidy-up.
 */
const resolveDefaultAgentName = (): string | undefined => {
  const configState = useConfigStore.getState();
  if (configState.settingsDefaultAgent) {
    return configState.settingsDefaultAgent;
  }
  const visibleAgents = configState.agents.filter((agent) => !agent.hidden);
  return (
    configState.currentAgentName
    || visibleAgents.find((agent) => agent.mode === 'primary' || !agent.mode)?.name
    || visibleAgents[0]?.name
  );
};

const resolveDefaultModelSelection = (): { providerID: string; modelID: string } | null => {
  const parsed = parseModelIdentifier(useConfigStore.getState().settingsDefaultModel);
  if (!parsed) {
    return null;
  }
  if (!useConfigStore.getState().getModelMetadata(parsed.providerId, parsed.modelId)) {
    return null;
  }
  return { providerID: parsed.providerId, modelID: parsed.modelId };
};

const resolveDefaultVariant = (
  providerID: string,
  modelID: string,
  agentName: string | undefined,
): string | null | undefined => {
  const configState = useConfigStore.getState();
  // The configured effort belongs to its default model; on the fallback model it does not apply.
  const configuredVariant = configState.getDefaultVariantForModel(providerID, modelID);
  const currentVariant = configState.currentProviderId === providerID && configState.currentModelId === modelID
    ? configState.currentVariant
    : undefined;
  const provider = configState.providers.find((entry) => entry.id === providerID);
  const model = provider?.models.find((entry) => entry.id === modelID);
  const variantNames = modelVariantNames(model);
  if (variantNames.length === 0) {
    return configuredVariant || currentVariant || undefined;
  }
  // The agent's pin for this model is configuration too; after it the level
  // this model was last sent with, then whatever the composer currently shows.
  // `null` is an explicit Default and is kept as the answer.
  return resolveEffortChoice(
    [resolveEffortForModelSelection({
      providerID, modelID, variants: variantNames,
      agents: configState.agents, agentName, configuredVariant,
    }), currentVariant],
    variantNames,
  );
};

export const captureDefaultSendSelection = () => {
  const configState = useConfigStore.getState();
  const lastUsedProvider = useSelectionStore.getState().lastUsedProvider;
  const defaultModel = resolveDefaultModelSelection();
  const providerID = defaultModel?.providerID || configState.currentProviderId || lastUsedProvider?.providerID;
  const modelID = defaultModel?.modelID || configState.currentModelId || lastUsedProvider?.modelID;
  const agentName = resolveDefaultAgentName() || configState.currentAgentName || undefined;
  if (!providerID || !modelID) {
    return null;
  }
  return { providerID, modelID, agentName, variant: resolveDefaultVariant(providerID, modelID, agentName) };
};
