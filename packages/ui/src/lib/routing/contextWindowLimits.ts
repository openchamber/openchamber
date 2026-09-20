export type ContextWindowLimits = {
  /** 0 when unknown; the readouts then fall back to their own default. */
  context: number;
  output: number;
};

export const NO_CONTEXT_WINDOW_LIMITS: ContextWindowLimits = { context: 0, output: 0 };

type AnsweringMessage = { role?: string; providerID?: string; modelID?: string };

/**
 * `provider/model` of the newest assistant message, or null before the first
 * answer. Reduced to a string so a store selector can return it and only
 * notify when the answering model changes, not on every streamed part.
 */
export const findAnsweringModelKey = (messages: readonly AnsweringMessage[]): string | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    if (!message.providerID || !message.modelID) continue;
    return `${message.providerID}/${message.modelID}`;
  }
  return null;
};

type ProviderModelLike = { id: string; limit?: { context?: number; output?: number } };
type ProviderLike = { id: string; models: readonly ProviderModelLike[] };

/**
 * Limits of the model behind a key produced by `findAnsweringModelKey`, read
 * from OpenCode's provider list — the same source the composer model and the
 * context overview use. The models.dev catalog can disagree with it (it lists
 * a 1M window for a model OpenCode serves with 400K), and the readouts must
 * not switch catalogs just because Auto is selected.
 */
export const limitsForAnsweringModel = (
  answeringModelKey: string | null,
  providers: readonly ProviderLike[],
): ContextWindowLimits => {
  if (!answeringModelKey) return NO_CONTEXT_WINDOW_LIMITS;
  const separator = answeringModelKey.indexOf('/');
  const providerId = answeringModelKey.slice(0, separator);
  const modelId = answeringModelKey.slice(separator + 1);
  const model = providers.find((provider) => provider.id === providerId)?.models.find((entry) => entry.id === modelId);
  return { context: model?.limit?.context ?? 0, output: model?.limit?.output ?? 0 };
};
