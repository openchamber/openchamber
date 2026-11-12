const trimTrailingSeparators = (value: string): string => value.trim().replace(/[\\/]+$/, '');

/**
 * Home and disk roots never get a repository: Git surfaces ignore one there
 * (it would cover every file), and the server refuses the request anyway.
 */
export const canOfferGitInitialization = (directory: string, homeDirectory: string | null | undefined): boolean => {
  const normalized = trimTrailingSeparators(directory);
  if (!normalized || /^[A-Za-z]:$/.test(normalized)) return false;
  if (!homeDirectory) return true;
  const home = trimTrailingSeparators(homeDirectory);
  const windows = /^[A-Za-z]:/.test(normalized);
  return windows ? normalized.toLowerCase() !== home.toLowerCase() : normalized !== home;
};
