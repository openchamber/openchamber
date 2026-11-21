const MODEL_MODALITIES = new Set(['text', 'image', 'audio', 'video', 'pdf']);
const MIME_TOP_LEVEL_MODALITIES = new Set(['text', 'image', 'audio', 'video']);
const MIME_TYPE = /^([a-z0-9][a-z0-9!#$&^_.+-]*)\/([a-z0-9][a-z0-9!#$&^_.+-]*)\s*(?:;.*)?$/;

export const isModelModality = (value: string) => MODEL_MODALITIES.has(value);

const toModelModality = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (MODEL_MODALITIES.has(normalized)) return normalized;
  const mime = MIME_TYPE.exec(normalized);
  if (!mime) return value;
  const [, type, subtype] = mime;
  if (type === 'application' && subtype === 'pdf') return 'pdf';
  return type && MIME_TOP_LEVEL_MODALITIES.has(type) ? type : value;
};

export const toModelModalities = (values: readonly unknown[]): string[] => {
  const modalities: string[] = [];
  for (const value of values) {
    const modality = toModelModality(String(value));
    if (!modalities.includes(modality)) modalities.push(modality);
  }
  return modalities;
};
