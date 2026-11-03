/** OpenCode's answer for a request in a folder that is gone. */
export const isLocationNotFoundError = (error: Error | undefined): boolean => (
  error !== undefined && 'tag' in error && error.tag === 'LocationNotFoundError'
);
