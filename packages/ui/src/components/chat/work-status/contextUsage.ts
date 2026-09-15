/**
 * Context-window usage for a specific session.
 *
 * `useSessionUIStore.getContextUsage` cannot serve this panel. It reads
 * `getSyncMessages(sessionId)` with **no directory**, which resolves to the
 * *current* directory's child store, and it keys off the store's own
 * `currentSessionId`. A session held by another directory — a worktree, or any
 * moment right after a directory switch — therefore reads as "no messages" and
 * the readout silently disappears while the header still shows a value.
 *
 * This computes the same quantity from messages the caller has already
 * subscribed to for a known session and directory, so there is no hidden
 * global read to race with.
 */

import { contextTokensFromBreakdown } from '@/stores/utils/tokenUtils';
import { mergeModelMetadataWithLiveModel } from '@/lib/modelMetadata';
import type { ModelMetadata } from '@/types';

type MessageTokens = {
  /** Server-reported window of the turn's final round-trip; absent on older servers. */
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
};

type MessageLike = {
  id?: string;
  role?: string;
  providerID?: string;
  modelID?: string;
  tokens?: MessageTokens;
};

type ModelLike = {
  id: string;
  limit?: {
    context?: number;
    output?: number;
  };
};

type ProviderLike = {
  id: string;
  models: readonly ModelLike[];
};

type SessionContextSnapshot = {
  messageID?: string;
  providerID: string;
  modelID: string;
  totalTokens: number;
  contextLimit: number;
  outputLimit: number;
  percent: number;
};

type WorkStatusContextUsage = {
  totalTokens: number;
  /** Context limit actually used for the ratio, after the default fallback. */
  limit: number;
  /** Unrounded, so the panel and the header cannot disagree by a rounding step. */
  percent: number;
};

/** The store's own fallback when a model exposes no context limit. */
export const DEFAULT_CONTEXT_LIMIT = 200_000;

/** Resolve usage and limits from the same token-reporting assistant message. */
export const resolveSessionContextSnapshot = (
  messages: readonly MessageLike[],
  providers: readonly ProviderLike[],
  modelsMetadata: ReadonlyMap<string, ModelMetadata>,
): SessionContextSnapshot | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant' || !message.tokens || !message.providerID || !message.modelID) continue;

    const totalTokens = contextTokensFromBreakdown(message.tokens);
    if (totalTokens <= 0) continue;

    const provider = providers.find((entry) => entry.id === message.providerID);
    const liveModel = provider?.models.find((entry) => entry.id === message.modelID);
    const metadata = modelsMetadata.get(`${message.providerID.toLowerCase()}/${message.modelID}`);
    if (!liveModel && !metadata) return null;

    const resolvedMetadata = liveModel
      ? mergeModelMetadataWithLiveModel(message.providerID, liveModel, metadata)
      : metadata;
    const advertisedContextLimit = resolvedMetadata?.limit?.context ?? 0;
    const contextLimit = advertisedContextLimit > 0 ? advertisedContextLimit : DEFAULT_CONTEXT_LIMIT;
    const advertisedOutputLimit = resolvedMetadata?.limit?.output ?? 0;
    const outputLimit = advertisedOutputLimit > 0 ? advertisedOutputLimit : 0;

    return {
      messageID: message.id,
      providerID: message.providerID,
      modelID: message.modelID,
      totalTokens,
      contextLimit,
      outputLimit,
      percent: (totalTokens / contextLimit) * 100,
    };
  }

  return null;
};

/**
 * Usage from the newest assistant message that reported a non-zero token count.
 * The latest turn describes the current fill — not a sum across turns. Within
 * a turn, the server-reported `total` is the final round-trip's window;
 * summing the breakdown fields instead overstates multi-step turns, whose
 * input/cache fields accumulate across round-trips.
 */
export const computeContextUsage = (
  messages: readonly MessageLike[],
  contextLimit: number,
): WorkStatusContextUsage | null => {
  if (messages.length === 0) return null;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant' || !message.tokens) continue;

    const totalTokens = contextTokensFromBreakdown(message.tokens);
    if (totalTokens <= 0) continue;

    const limit = contextLimit > 0 ? contextLimit : DEFAULT_CONTEXT_LIMIT;
    return { totalTokens, limit, percent: (totalTokens / limit) * 100 };
  }

  return null;
};
