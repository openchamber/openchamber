export type ContextWindowLimits = {
  context: number;
  output: number;
};

const NO_CONTEXT_WINDOW_LIMITS: ContextWindowLimits = { context: 0, output: 0 };

type AnsweringMessage = { role?: string; providerID?: string; modelID?: string };

export const findAnsweringModelKey = (messages: readonly AnsweringMessage[]): string | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    if (!message.providerID || !message.modelID) continue;
    return `${message.providerID}/${message.modelID}`;
  }
  return null;
};

type SessionModelLike = { model?: { providerID: string; id: string } };

export const findSessionModelKey = (session: SessionModelLike | undefined): string | null => {
  const model = session?.model;
  if (!model?.providerID || !model.id) return null;
  return `${model.providerID}/${model.id}`;
};

type ProviderModelLike = { id: string; limit?: { context?: number; output?: number } };
type ProviderLike = { id: string; models: readonly ProviderModelLike[] };

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
