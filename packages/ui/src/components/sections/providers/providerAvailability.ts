export const shouldLoadAvailableProviders = (isAddMode: boolean): boolean => isAddMode;

export const requiresProviderAuth = (
  sourcesLoaded: boolean,
  hasCredentials: boolean,
  isConfigDefinedCustomProvider: boolean,
): boolean => sourcesLoaded && !hasCredentials && !isConfigDefinedCustomProvider;
