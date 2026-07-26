import { isEmbeddedSessionChat } from '@/components/layout/contextPanelEmbeddedChat';
import type { Theme } from '@/types/theme';
import { isValidTheme } from './theme-validation';

type ThemeBootstrapWindow = Window & {
  __openchamberEmbeddedThemeBootstrap?: unknown;
};

export const readEmbeddedThemeSearchParams = (): URLSearchParams | null => {
  if (!isEmbeddedSessionChat()) {
    return null;
  }
  return new URLSearchParams(window.location.search);
};

export const publishEmbeddedThemeBootstrap = (theme: Theme): void => {
  if (typeof window === 'undefined') {
    return;
  }

  (window as ThemeBootstrapWindow).__openchamberEmbeddedThemeBootstrap = theme;
};

export const readEmbeddedThemeBootstrap = (): Theme | null => {
  if (!isEmbeddedSessionChat()) {
    return null;
  }

  try {
    const parent = window.parent as ThemeBootstrapWindow;
    if (parent === window) {
      return null;
    }
    return isValidTheme(parent.__openchamberEmbeddedThemeBootstrap)
      ? parent.__openchamberEmbeddedThemeBootstrap
      : null;
  } catch {
    return null;
  }
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
