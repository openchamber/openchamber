export const readEmbeddedThemeSearchParams = (): URLSearchParams | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  const params = new URLSearchParams(window.location.search);
  return params.get('ocPanel') === 'session-chat' ? params : null;
};

const getSystemPreference = (): boolean => {
  if (typeof window === 'undefined') {
    return true;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
};

export const getInitialSystemPreference = (): boolean => {
  const embeddedParams = readEmbeddedThemeSearchParams();
  const embeddedVariant = embeddedParams?.get('themeVariant');
  if (embeddedVariant === 'dark' || embeddedVariant === 'light') {
    return embeddedVariant === 'dark';
  }
  return getSystemPreference();
};
