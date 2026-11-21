export const isLocationNotFoundError = (error: Error | undefined): boolean => (
  error !== undefined && 'tag' in error && error.tag === 'LocationNotFoundError'
);
