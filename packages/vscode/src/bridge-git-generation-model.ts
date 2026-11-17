
export const BRIDGE_ZEN_DEFAULT_MODEL = 'gpt-5-nano';

export type BridgeGitGenerationPayloadModel = {
  providerId?: string;
  modelId?: string;
  zenModel?: string;
};

export type BridgeGitGenerationModelChoice = { providerID: string; modelID: string; variant?: string };

const readStringField = (settings: Record<string, unknown>, key: string): string => {
  const candidate = settings[key];
  return typeof candidate === 'string' ? candidate.trim() : '';
};

const readSmallModelOverride = (settings: Record<string, unknown>): BridgeGitGenerationModelChoice | null => {
  if (settings.smallModelUseDefault !== false) return null;
  const override = readStringField(settings, 'smallModelOverride');
  const separator = override.indexOf('/');
  if (separator <= 0) return null;
  const providerID = override.slice(0, separator).trim();
  const modelID = override.slice(separator + 1).trim();
  if (!providerID || !modelID) return null;
  const choice: BridgeGitGenerationModelChoice = { providerID, modelID };
  const variant = readStringField(settings, 'smallModelVariant');
  if (variant) choice.variant = variant;
  return choice;
};

const withKnownVariant = (
  choice: BridgeGitGenerationModelChoice,
  hasVariant?: (providerID: string, modelID: string, variant: string) => boolean,
): BridgeGitGenerationModelChoice => {
  if (!choice.variant || !hasVariant) return choice;
  if (hasVariant(choice.providerID, choice.modelID, choice.variant)) return choice;
  return { providerID: choice.providerID, modelID: choice.modelID };
};

export const chooseBridgeGitGenerationModel = (
  payloadModel: BridgeGitGenerationPayloadModel,
  settings: Record<string, unknown>,
  hasModel: (providerID: string, modelID: string) => boolean,
  configuredModel?: BridgeGitGenerationModelChoice | null,
  hasVariant?: (providerID: string, modelID: string, variant: string) => boolean,
): BridgeGitGenerationModelChoice => {
  const requestProviderId = typeof payloadModel.providerId === 'string' ? payloadModel.providerId.trim() : '';
  const requestModelId = typeof payloadModel.modelId === 'string' ? payloadModel.modelId.trim() : '';
  if (requestProviderId && requestModelId && hasModel(requestProviderId, requestModelId)) {
    return { providerID: requestProviderId, modelID: requestModelId };
  }

  const override = readSmallModelOverride(settings);
  if (override && hasModel(override.providerID, override.modelID)) {
    return withKnownVariant(override, hasVariant);
  }

  if (configuredModel && hasModel(configuredModel.providerID, configuredModel.modelID)) {
    return withKnownVariant(configuredModel, hasVariant);
  }

  const payloadZenModel = typeof payloadModel.zenModel === 'string' ? payloadModel.zenModel.trim() : '';
  const settingsZenModel = readStringField(settings, 'zenModel');
  return {
    providerID: 'zen',
    modelID: payloadZenModel || settingsZenModel || BRIDGE_ZEN_DEFAULT_MODEL,
  };
};
