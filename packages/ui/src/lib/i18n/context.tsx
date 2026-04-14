/**
 * I18n context — triggers React re-renders when locale changes.
 *
 * Paraglide message functions read from module-level state (`currentLocale`).
 * When locale changes, Zustand's `useI18nStore` updates but components using
 * only `import { settingsTitle } from '@/lib/i18n/messages'` won't re-render
 * because they don't subscribe to any React state.
 *
 * This provider forces a full subtree re-render when locale changes by using
 * React's `key` prop. Changing `key` unmounts and remounts the entire child
 * tree, which causes all message functions to be called fresh with the new
 * locale. This is heavy (all state is lost, all effects re-run) but locale
 * changes are rare (explicit user action in Settings) so it's acceptable.
 *
 * Per AGENTS.md performance rules:
 * - Locale changes are rare (user action in Settings) → full remount is acceptable
 * - This is the ONLY mechanism that guarantees all Paraglide message functions
 *   return the correct locale, since they read from module-level state
 */

import React, { useContext, useMemo } from 'react';
import { useI18nStore } from './store';

const I18nContext = React.createContext<{ locale: string }>({ locale: 'en' });

/**
 * Provider that re-renders children when locale changes.
 * Must be placed ABOVE any component that uses Paraglide message functions.
 * In the app, this is placed in main.tsx inside ThemeSystemProvider.
 *
 * Uses `key={locale}` to force a full subtree remount when locale changes.
 * This is necessary because Paraglide message functions are pure module-level
 * functions — React doesn't know they depend on locale. Without the key,
 * only components that explicitly subscribe to I18nContext would re-render.
 */
export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const locale = useI18nStore((s) => s.locale);

  // Memoize the context value to prevent unnecessary re-renders
  const value = useMemo(() => ({ locale }), [locale]);

  return (
    <I18nContext.Provider value={value} key={locale}>
      {children}
    </I18nContext.Provider>
  );
};

/**
 * Hook that returns the current locale and triggers re-render on change.
 * Components that call Paraglide message functions directly should use this
 * to ensure they re-render when locale changes.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useLocale() {
  return useContext(I18nContext).locale;
}