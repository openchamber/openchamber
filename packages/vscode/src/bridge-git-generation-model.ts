// Which model a bridge Git generation flow (PR description / commit message)
// talks to. Pure so the choice is unit-tested without `vscode`; the catalog
// lookup is injected.
//
// Order: the request's explicit model, then the user's small-model override
// from OpenChamber settings (the same setting every other utility generation in
// the product uses), then zen when the catalog has it, then a catalog model.
// Vanilla OpenCode has no zen provider. Sending zen/gpt-5-nano there hangs
// until the generation timeout. The catalog fallback is OpenCode's default
// (`big-pickle`), then any other `opencode/*` row, then the first catalog row.

export const BRIDGE_ZEN_DEFAULT_MODEL = 'gpt-5-nano';

export type BridgeGitGenerationPayloadModel = {
  providerId?: string;
  modelId?: string;
  zenModel?: string;
};

type BridgeGitGenerationModelChoice = { providerID: string; modelID: string };

const parseCatalogRef = (ref: string): BridgeGitGenerationModelChoice | null => {
  const separator = ref.indexOf('/');
  if (separator <= 0) return null;
  const providerID = ref.slice(0, separator).trim();
  const modelID = ref.slice(separator + 1).trim();
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
};

const compareCatalogChoice = (
  left: BridgeGitGenerationModelChoice,
  right: BridgeGitGenerationModelChoice,
): number => {
  const byProvider = left.providerID.localeCompare(right.providerID);
  if (byProvider !== 0) return byProvider;
  return left.modelID.localeCompare(right.modelID);
};

/**
 * When zen is missing from the live catalog, pick a model that actually exists.
 * Vanilla OpenCode's default is `opencode/big-pickle`. Some other `*-free` ids
 * accept prompt_async and never finish, so do not rank by "free" in the name.
 */
export const pickCatalogGitGenerationFallback = (
  refs: Iterable<string>,
): BridgeGitGenerationModelChoice | null => {
  const models: BridgeGitGenerationModelChoice[] = [];
  for (const ref of refs) {
    const parsed = parseCatalogRef(ref);
    if (parsed) models.push(parsed);
  }
  if (models.length === 0) return null;

  const bigPickle = models.find((model) => (
    model.providerID === 'opencode' && model.modelID === 'big-pickle'
  ));
  if (bigPickle) return bigPickle;

  models.sort(compareCatalogChoice);
  return models.find((model) => model.providerID === 'opencode') ?? models[0];
};

type GitGenerationCatalogRowInput = {
  providerID?: string;
  id?: string;
  modelID?: string;
};

export type GitGenerationCatalogListPayload = {
  location?: { directory?: string };
  data?: ReadonlyArray<GitGenerationCatalogRowInput>;
};

/**
 * `client.v2.model.list` unwraps to `{ location, data: ModelV2Info[] }`.
 * Treating that object as a missing catalog sends zen/gpt-5-nano and hangs
 * on vanilla OpenCode.
 */
const catalogRowsFromListPayload = (
  payload: GitGenerationCatalogListPayload | readonly GitGenerationCatalogRowInput[],
): ReadonlyArray<GitGenerationCatalogRowInput> => {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!('data' in payload)) {
    return [];
  }
  const rows = payload.data;
  return Array.isArray(rows) ? rows : [];
};

export const catalogModelRefsFromListPayload = (
  payload: GitGenerationCatalogListPayload | readonly GitGenerationCatalogRowInput[],
): string[] => {
  const refs: string[] = [];
  for (const item of catalogRowsFromListPayload(payload)) {
    const providerID = item.providerID?.trim() ?? '';
    const modelID = item.id?.trim() || item.modelID?.trim() || '';
    if (providerID && modelID) refs.push(`${providerID}/${modelID}`);
  }
  return refs;
};

// Bridge settings are the merged persisted dictionary; a value is a string
// only when the stored file says so, hence the narrowing here.
const readStringField = (settings: Record<string, unknown>, key: string): string => {
  const candidate = settings[key];
  return typeof candidate === 'string' ? candidate.trim() : '';
};

/**
 * `smallModelOverride` is stored as `provider/model`; the model id may itself
 * contain slashes, so only the first one separates the two.
 */
const readSmallModelOverride = (settings: Record<string, unknown>): BridgeGitGenerationModelChoice | null => {
  if (settings.smallModelUseDefault !== false) return null;
  const override = readStringField(settings, 'smallModelOverride');
  const separator = override.indexOf('/');
  if (separator <= 0) return null;
  const providerID = override.slice(0, separator).trim();
  const modelID = override.slice(separator + 1).trim();
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
};

export const chooseBridgeGitGenerationModel = (
  payloadModel: BridgeGitGenerationPayloadModel,
  settings: Record<string, unknown>,
  hasModel: (providerID: string, modelID: string) => boolean,
  catalogFallback?: BridgeGitGenerationModelChoice | null,
): BridgeGitGenerationModelChoice => {
  // The payload reaches here from a webview message that is cast, not parsed,
  // so a wrong-typed field must degrade to "absent" instead of throwing.
  const requestProviderId = typeof payloadModel.providerId === 'string' ? payloadModel.providerId.trim() : '';
  const requestModelId = typeof payloadModel.modelId === 'string' ? payloadModel.modelId.trim() : '';
  if (requestProviderId && requestModelId && hasModel(requestProviderId, requestModelId)) {
    return { providerID: requestProviderId, modelID: requestModelId };
  }

  const override = readSmallModelOverride(settings);
  if (override && hasModel(override.providerID, override.modelID)) {
    return override;
  }

  const payloadZenModel = typeof payloadModel.zenModel === 'string' ? payloadModel.zenModel.trim() : '';
  const settingsZenModel = readStringField(settings, 'zenModel');
  const zenChoice = {
    providerID: 'zen',
    modelID: payloadZenModel || settingsZenModel || BRIDGE_ZEN_DEFAULT_MODEL,
  };
  if (hasModel(zenChoice.providerID, zenChoice.modelID)) {
    return zenChoice;
  }
  if (catalogFallback) {
    return catalogFallback;
  }
  // Never send zen when the catalog did not confirm it. Vanilla OpenCode
  // has no zen provider; prompt_async dies and the UI spins until timeout.
  return { providerID: 'opencode', modelID: 'big-pickle' };
};
