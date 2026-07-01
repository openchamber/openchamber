import type { ModelMetadata } from '@/types';

type LiveProviderModel = Record<string, unknown> & { id?: string; name?: string };

const getNumericLimit = (limit: unknown, key: 'context' | 'output') => {
  if (!limit || typeof limit !== 'object') return undefined;
  const value = (limit as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

export const mergeModelMetadataWithLiveModel = (
  providerId: string,
  model: LiveProviderModel,
  metadata?: ModelMetadata,
): ModelMetadata | undefined => {
  const liveContextLimit = getNumericLimit(model.limit, 'context');
  const liveOutputLimit = getNumericLimit(model.limit, 'output');
  const contextLimit = liveContextLimit ?? metadata?.limit?.context;
  const outputLimit = liveOutputLimit ?? metadata?.limit?.output;

  if (contextLimit === undefined && outputLimit === undefined) return metadata;

  return {
    ...(metadata ?? {
      id: typeof model.id === 'string' ? model.id : '',
      providerId,
      name: typeof model.name === 'string' ? model.name : undefined,
    }),
    limit: {
      ...metadata?.limit,
      ...(contextLimit !== undefined ? { context: contextLimit } : {}),
      ...(outputLimit !== undefined ? { output: outputLimit } : {}),
    },
  };
};
