
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

export const explicitBridgeGitGenerationModel = (
  payloadModel: BridgeGitGenerationPayloadModel,
  settings: Parameters<typeof readSmallModelOverride>[0],
): BridgeGitGenerationModelChoice | null => {
  const providerID = typeof payloadModel.providerId === 'string' ? payloadModel.providerId.trim() : '';
  const modelID = typeof payloadModel.modelId === 'string' ? payloadModel.modelId.trim() : '';
  return providerID && modelID ? { providerID, modelID } : readSmallModelOverride(settings);
};

export const chooseBridgeGitGenerationModel = (
  payloadModel: BridgeGitGenerationPayloadModel,
  settings: Record<string, unknown>,
  hasModel: (providerID: string, modelID: string) => boolean,
  configuredModel?: BridgeGitGenerationModelChoice | null,
  hasVariant?: (providerID: string, modelID: string, variant: string) => boolean,
): BridgeGitGenerationModelChoice => {
  const chosen = explicitBridgeGitGenerationModel(payloadModel, settings) ?? configuredModel;
  if (chosen) {
    if (hasModel(chosen.providerID, chosen.modelID)) return withKnownVariant(chosen, hasVariant);
    throw new Error(`The model chosen for this text, ${chosen.providerID}/${chosen.modelID}, is turned off or unavailable. Turn it on or choose another small model.`);
  }

  const payloadZenModel = typeof payloadModel.zenModel === 'string' ? payloadModel.zenModel.trim() : '';
  const settingsZenModel = readStringField(settings, 'zenModel');
  return {
    providerID: 'zen',
    modelID: payloadZenModel || settingsZenModel || BRIDGE_ZEN_DEFAULT_MODEL,
  };
};
