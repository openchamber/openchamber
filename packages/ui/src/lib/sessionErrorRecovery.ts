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
 * Advance in the pool's configured order from the concrete model that just
 * failed. If the failed attempt is not known, try the second configured target
 * (the first fallback); a one-target pool has no next choice.
 */
export const nextModelPoolTarget = (
  targets: readonly ModelSelection[],
  failedModel?: Pick<ModelSelection, 'providerID' | 'id'> | null,
): ModelSelection | null => {
  if (targets.length < 2) return null;
  const failedIndex = failedModel
    ? targets.findIndex((target) => target.providerID === failedModel.providerID && target.id === failedModel.id)
    : -1;
  const nextIndex = failedIndex >= 0 ? (failedIndex + 1) % targets.length : 1;
  return targets[nextIndex] ?? null;
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
