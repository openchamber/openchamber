import type { ModelInfo } from '@opencode/client';
import { asNonEmptyString } from '../shared/guards.js';
import { isAutoModel } from '../routing/defaults.js';
import { OpenChamberControlError } from '../openchamber-control/error.js';

export interface ModelSelection { providerID: string; modelID: string }
interface ModelFields { providerID?: unknown; modelID?: unknown }
const hasModelFields = (value: unknown): value is ModelFields => value !== null && value !== undefined;

const FALLBACK_PROVIDER_ID = 'opencode';
const FALLBACK_MODEL_ID = 'big-pickle';

export const findCatalogModel = (models: readonly ModelInfo[], providerID: string, ref: string) => {
  const ofProvider = models.filter((model) => model?.providerID === providerID);
  return ofProvider.find((model) => model?.id === ref)
    || ofProvider.find((model) => model?.modelID === ref)
    || null;
};

export const isMissingFromCatalog = (models: readonly ModelInfo[], model: ModelSelection) => {
  if (models.length === 0 || isAutoModel(model)) return false;
  const entry = findCatalogModel(models, model.providerID, model.modelID);
  return !entry || entry.enabled === false;
};

export const isModelHidden = (hiddenModels: readonly unknown[], providerID: string, modelID: string) => hiddenModels.some(
  (hidden) => hasModelFields(hidden) && hidden.providerID === providerID && hidden.modelID === modelID,
);

export const resolveFallbackModel = (models: readonly ModelInfo[], hiddenModels: readonly unknown[]) => {
  const isVisible = (providerID: string, modelID: string) => !isModelHidden(hiddenModels, providerID, modelID);
  const candidates = models.filter(
    (entry) => asNonEmptyString(entry?.providerID) && asNonEmptyString(entry?.id),
  );
  const bigPickle = findCatalogModel(candidates, FALLBACK_PROVIDER_ID, FALLBACK_MODEL_ID);
  const pick = (bigPickle && isVisible(bigPickle.providerID, bigPickle.id) ? bigPickle : null)
    || candidates.find((entry) => isVisible(entry.providerID, entry.id))
    || bigPickle
    || candidates[0];
  return pick ? { providerID: pick.providerID, modelID: pick.id } : null;
};

export const requireListedDefault = (models: readonly ModelInfo[], model: ModelSelection) => {
  if (!isMissingFromCatalog(models, model)) return;
  throw new OpenChamberControlError(`Configured model '${model.providerID}/${model.modelID}' is not available in this directory. Reconnect its provider, choose another default model, or pass an explicit model.`, 400);
};
