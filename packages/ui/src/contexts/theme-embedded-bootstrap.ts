import { isEmbeddedSessionChat } from '@/components/layout/contextPanelEmbeddedChat';

export const readEmbeddedThemeSearchParams = (): URLSearchParams | null => {
  if (!isEmbeddedSessionChat()) {
    return null;
  }
  return new URLSearchParams(window.location.search);
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
