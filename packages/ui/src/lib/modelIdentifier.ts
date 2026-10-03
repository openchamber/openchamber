export interface ParsedModelIdentifier {
  providerId: string;
  modelId: string;
}

export const parseModelIdentifier = (value: string | undefined): ParsedModelIdentifier | null => {
  if (!value) {
    return null;
  }

  const separatorIndex = value.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex >= value.length - 1) {
    return null;
  }

  return {
    providerId: value.slice(0, separatorIndex),
    modelId: value.slice(separatorIndex + 1),
  };
};

/**
 * A model reference as OpenCode 2 stores it in config: `providerID/modelID`
 * with an optional `#variant` suffix. The split/join pair mirrors
 * `parseModelSelection`/`formatModelSelection` in the server's `config-v2.js`
 * so the Settings UI and the config writer agree on one spelling.
 */
export interface ModelSelection {
  providerID: string;
  modelID: string;
  variant?: string;
}

export const parseModelSelection = (
  model: string | null | undefined,
  variant?: string | null,
): ModelSelection | null => {
  const trimmed = model?.trim();
  if (!trimmed) return null;
  const separator = trimmed.indexOf('/');
  if (separator <= 0) return null;
  const providerID = trimmed.slice(0, separator);
  if (providerID.includes('#')) return null;
  const hash = trimmed.indexOf('#', separator + 1);
  const modelID = trimmed.slice(separator + 1, hash === -1 ? undefined : hash);
  const embedded = hash === -1 ? undefined : trimmed.slice(hash + 1);
  if (!modelID) return null;
  const chosen = embedded !== undefined ? embedded : variant?.trim();
  if (chosen !== undefined && (!chosen || chosen.includes('#'))) return { providerID, modelID };
  return chosen ? { providerID, modelID, variant: chosen } : { providerID, modelID };
};

export const formatModelSelection = (selection: ModelSelection | null | undefined): string | null => {
  if (!selection) return null;
  const providerID = selection.providerID?.trim() ?? '';
  const modelID = selection.modelID?.trim() ?? '';
  if (!providerID || !modelID) return null;
  const variant = selection.variant?.trim() ?? '';
  return variant ? `${providerID}/${modelID}#${variant}` : `${providerID}/${modelID}`;
};
