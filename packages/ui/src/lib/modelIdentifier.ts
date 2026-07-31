export interface ParsedModelIdentifier {
  providerId: string;
  modelId: string;
  variant?: string;
}

export const parseModelIdentifier = (value: string | undefined): ParsedModelIdentifier | null => {
  if (!value) {
    return null;
  }

  const separatorIndex = value.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex >= value.length - 1) {
    return null;
  }

  const rest = value.slice(separatorIndex + 1);
  // Optional "#variant" suffix (e.g. "provider/model#low") is split off so
  // the model id matches catalog entries; the variant is applied separately.
  const hashIndex = rest.indexOf('#');
  const modelId = hashIndex === -1 ? rest : rest.slice(0, hashIndex);
  if (!modelId) {
    return null;
  }
  const variant = hashIndex === -1 || hashIndex === rest.length - 1 ? undefined : rest.slice(hashIndex + 1);

  return {
    providerId: value.slice(0, separatorIndex),
    modelId,
    ...(variant ? { variant } : {}),
  };
};
