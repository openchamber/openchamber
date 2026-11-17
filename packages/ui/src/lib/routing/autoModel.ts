export const AUTO_PROVIDER_ID = 'openchamber';
export const AUTO_MODEL_ID = 'auto';

export const isAutoModel = (providerId: string | null | undefined, modelId: string | null | undefined): boolean =>
  providerId === AUTO_PROVIDER_ID && modelId === AUTO_MODEL_ID;
