import { asNonEmptyString } from '../shared/guards.js';
import { isAutoModel } from '../routing/defaults.js';
import { OpenChamberControlError } from '../openchamber-control/error.js';

interface ModelReference { model?: unknown; providerID?: unknown; modelID?: unknown }

export const EMPTY_SESSION_AUTO_ERROR = 'Auto cannot be selected for an empty session; provide a prompt or a specific model';

export const splitModel = (value: string | null | undefined) => {
  const model = asNonEmptyString(value);
  if (!model) return null;
  const slashIndex = model.indexOf('/');
  if (slashIndex <= 0 || slashIndex === model.length - 1) return null;
  return {
    providerID: model.slice(0, slashIndex),
    modelID: model.slice(slashIndex + 1),
  };
};

export const resolveRequestedModel = (payload: ModelReference) => {
  const model = splitModel(asNonEmptyString(payload?.model));
  if (model) return model;

  const providerID = asNonEmptyString(payload?.providerID);
  const modelID = asNonEmptyString(payload?.modelID);
  return providerID && modelID ? { providerID, modelID } : null;
};

export const assertEmptySessionModel = (payload: ModelReference, model: ReturnType<typeof resolveRequestedModel>) => {
  if (!model && [payload.model, payload.providerID, payload.modelID].some((value) => value != null && value !== '')) {
    throw new OpenChamberControlError("model must be a 'provider/model' reference, or providerID with modelID", 400);
  }
  if (isAutoModel(model)) throw new OpenChamberControlError(EMPTY_SESSION_AUTO_ERROR, 400);
};
