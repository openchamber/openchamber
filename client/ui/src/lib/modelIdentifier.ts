export interface ParsedModelIdentifier {
  providerId: string;
  modelId: string;
}

export const parseModelIdentifier = (value: string | undefined): ParsedModelIdentifier | null => {
  if (!value) {
    return null;
  }

  const separatorIndex = value.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex >= value.length - 1) {
    return null;
  }

  return {
    providerId: value.slice(0, separatorIndex),
    modelId: value.slice(separatorIndex + 1),
  };
};
