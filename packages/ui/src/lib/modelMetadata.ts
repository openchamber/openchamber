import type { ModelMetadata } from '@/types';

type LiveProviderModel = Record<string, unknown> & { id?: string; name?: string };

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;

const getBoolean = (value: unknown, key: string) => {
  const candidate = asRecord(value)?.[key];
  return typeof candidate === 'boolean' ? candidate : undefined;
};

const getModalities = (value: unknown, key: 'input' | 'output') => {
  const candidate = asRecord(value)?.[key];
  if (Array.isArray(candidate)) {
    return candidate.filter((entry): entry is string => typeof entry === 'string');
  }

  const modalityFlags = asRecord(candidate);
  if (!modalityFlags) return undefined;
  return Object.entries(modalityFlags)
    .filter(([, supported]) => supported === true)
    .map(([modality]) => modality);
};

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
  const liveModel = model as Record<string, unknown>;
  const liveCapabilities = liveModel.capabilities;
  const liveContextLimit = getNumericLimit(liveModel.limit, 'context');
  const liveOutputLimit = getNumericLimit(liveModel.limit, 'output');
  const contextLimit = liveContextLimit ?? metadata?.limit?.context;
  const outputLimit = liveOutputLimit ?? metadata?.limit?.output;
  const toolCall = getBoolean(liveCapabilities, 'toolcall')
    ?? getBoolean(liveCapabilities, 'tools')
    ?? getBoolean(liveModel, 'tool_call')
    ?? metadata?.tool_call;
  const reasoning = getBoolean(liveCapabilities, 'reasoning')
    ?? getBoolean(liveModel, 'reasoning')
    ?? metadata?.reasoning;
  const attachment = getBoolean(liveCapabilities, 'attachment')
    ?? getBoolean(liveModel, 'attachment')
    ?? metadata?.attachment;
  const inputModalities = getModalities(liveCapabilities, 'input') ?? metadata?.modalities?.input;
  const outputModalities = getModalities(liveCapabilities, 'output') ?? metadata?.modalities?.output;

  if (
    contextLimit === undefined
    && outputLimit === undefined
    && toolCall === undefined
    && reasoning === undefined
    && attachment === undefined
    && inputModalities === undefined
    && outputModalities === undefined
  ) return metadata;

  return {
    ...(metadata ?? {
      id: typeof model.id === 'string' ? model.id : '',
      providerId,
      name: typeof model.name === 'string' ? model.name : undefined,
    }),
    ...(toolCall !== undefined ? { tool_call: toolCall } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(attachment !== undefined ? { attachment } : {}),
    ...(inputModalities !== undefined || outputModalities !== undefined
      ? {
          modalities: {
            ...metadata?.modalities,
            ...(inputModalities !== undefined ? { input: inputModalities } : {}),
            ...(outputModalities !== undefined ? { output: outputModalities } : {}),
          },
        }
      : {}),
    ...(contextLimit !== undefined || outputLimit !== undefined
      ? {
          limit: {
            ...metadata?.limit,
            ...(contextLimit !== undefined ? { context: contextLimit } : {}),
            ...(outputLimit !== undefined ? { output: outputLimit } : {}),
          },
        }
      : {}),
  };
};
