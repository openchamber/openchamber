export const requiresProviderAuth = (
  sourcesLoaded: boolean,
  hasCredentials: boolean,
  isConfigDefinedCustomProvider: boolean,
): boolean => sourcesLoaded && !hasCredentials && !isConfigDefinedCustomProvider;
