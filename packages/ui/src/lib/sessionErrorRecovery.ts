import { z } from 'zod';
import type { Message, ModelSelection } from '@/lib/opencode/model';

export const MODEL_ROUTE_PROVIDER_ID = 'opencode-route';

const modelSelectionSchema = z.object({
  providerID: z.string().min(1),
  id: z.string().min(1),
  variant: z.string().optional(),
});

const routeSettingsSchema = z.object({
  opencodeRoute: z.object({
    targets: z.array(z.any()).optional(),
  }).passthrough().optional(),
}).passthrough();

type CatalogModel = {
  id: string;
  settings?: z.infer<typeof routeSettingsSchema>;
};

type CatalogProvider = {
  id: string;
  models?: CatalogModel[];
};

/** The concrete and nested targets OpenCode compiled into a routed catalog model. */
export const getModelPoolTargets = (
  providers: readonly CatalogProvider[],
  providerID: string,
  modelID: string,
): ModelSelection[] => {
  if (providerID !== MODEL_ROUTE_PROVIDER_ID || !modelID) return [];
  const model = providers.find((provider) => provider.id === providerID)?.models?.find((entry) => entry.id === modelID);
  const parsedSettings = routeSettingsSchema.safeParse(model?.settings);
  if (!parsedSettings.success || !parsedSettings.data.opencodeRoute?.targets) return [];
  const targets: ModelSelection[] = [];
  for (const rawTarget of parsedSettings.data.opencodeRoute.targets) {
    const parsedTarget = modelSelectionSchema.safeParse(rawTarget);
    if (parsedTarget.success) {
      targets.push(parsedTarget.data);
    }
  }
  return targets;
};

/**
 * The next pool target in configured order after the models that already
 * failed for this prompt. It never wraps back to the start: once the last
 * target has failed, the pool is used up and the caller says so.
 */
export const nextModelPoolTarget = (
  targets: readonly ModelSelection[],
  failedModels: readonly Pick<ModelSelection, 'providerID' | 'id'>[] = [],
): ModelSelection | null => {
  if (targets.length < 2) return null;
  const failed = (target: Pick<ModelSelection, 'providerID' | 'id'>) =>
    failedModels.some((model) => model.providerID === target.providerID && model.id === target.id);
  const lastFailed = targets.reduce((last, target, index) => (failed(target) ? index : last), -1);
  // Nothing known failed: the first target is the one that just ran.
  const start = lastFailed >= 0 ? lastFailed + 1 : 1;
  return targets.slice(start).find((target) => !failed(target)) ?? null;
};

/** The models that answered the prompt with an error, oldest first, each once. */
export const failedModelsForPrompt = (
  messages: readonly Message[],
  userMessageID: string,
): Pick<ModelSelection, 'providerID' | 'id'>[] => {
  const start = messages.findIndex((message) => message.id === userMessageID);
  if (start < 0) return [];
  const failed: Pick<ModelSelection, 'providerID' | 'id'>[] = [];
  for (const message of messages.slice(start + 1)) {
    if (message.role === 'user') break;
    if (message.role !== 'assistant' || !message.providerID || !message.modelID) continue;
    if (!message.error && message.finish !== 'error') continue;
    if (!failed.some((model) => model.providerID === message.providerID && model.id === message.modelID))
      failed.push({ providerID: message.providerID, id: message.modelID });
  }
  return failed;
};

/** The prompt associated with an error anchor, or the latest prompt for a session-level notice. */
export const recoveryUserMessage = (
  messages: readonly Message[],
  anchorMessageID?: string,
): Extract<Message, { role: 'user' }> | null => {
  if (!anchorMessageID) {
    return [...messages].reverse().find((message): message is Extract<Message, { role: 'user' }> => message.role === 'user') ?? null;
  }

  const anchorIndex = messages.findIndex((message) => message.id === anchorMessageID);
  if (anchorIndex < 0) return null;
  const anchor = messages[anchorIndex];
  if (anchor?.role === 'user') return anchor;
  for (let index = anchorIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') return message;
  }
  return null;
};

/** The error anchor's model is the best clue; a previous reply is the fallback for a no-reply error. */
export const modelForRecoveryAnchor = (
  messages: readonly Message[],
  anchorMessageID: string | undefined,
  userMessageID: string,
): Pick<ModelSelection, 'providerID' | 'id'> | null => {
  const anchor = anchorMessageID ? messages.find((message) => message.id === anchorMessageID) : undefined;
  if (anchor?.role === 'assistant' && anchor.providerID && anchor.modelID) {
    return { providerID: anchor.providerID, id: anchor.modelID };
  }

  const userIndex = messages.findIndex((message) => message.id === userMessageID);
  for (let index = userIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && message.providerID && message.modelID) {
      return { providerID: message.providerID, id: message.modelID };
    }
  }
  return null;
};
