import { z } from 'zod';
import { isRecord, isString } from '../shared/object-guards.js';

export interface QueueSendConfig {
  providerID?: string;
  modelID?: string;
  agent?: string;
  variant?: string;
  keepSessionModel?: boolean;
  keepSessionAgent?: boolean;
}

const asNonEmptyString = z.unknown().transform((value) => isString(value) && value.trim() ? value.trim() : '').parse;

const sendConfigSchema = z.unknown().transform((value): QueueSendConfig | null => {
  if (!isRecord(value)) return null;
  const providerID = asNonEmptyString(value.providerID);
  const modelID = asNonEmptyString(value.modelID);
  if (!providerID || !modelID) return null;
  const sendConfig: QueueSendConfig = { providerID, modelID };
  const agent = asNonEmptyString(value.agent);
  if (agent) sendConfig.agent = agent;
  const variant = asNonEmptyString(value.variant);
  if (variant) sendConfig.variant = variant;
  if (value.keepSessionModel === true) sendConfig.keepSessionModel = true;
  if (value.keepSessionAgent === true) sendConfig.keepSessionAgent = true;
  return sendConfig;
});

export const parseSendConfig = sendConfigSchema.parse;

export const switchesQueuedModel = (sendConfig: QueueSendConfig, routed: boolean, scheduled: boolean) => {
  if (routed) return true;
  if (sendConfig.keepSessionModel) return false;
  return !scheduled || Boolean(sendConfig.providerID && sendConfig.modelID);
};
