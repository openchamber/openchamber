export const isMissingFileError = (value: unknown): value is { code: 'ENOENT' } => (
  value !== null && (typeof value === 'object' || typeof value === 'function')
  && 'code' in value && value.code === 'ENOENT'
);
