/**
 * i18n store — narrow Zustand store for locale state.
 *
 * This store has exactly TWO fields: `locale` and `setLocale`.
 * It deliberately does NOT live in `useUIStore` (which is already ~1,900 lines
 * with 60+ fields). Per AGENTS.md:
 *
 *   "Never add unrelated state to an existing store just because it's
 *    convenient. Create a new store."
 *
 * Locale changes are rare (user action in Settings). Only components that
 * explicitly subscribe to `useI18nStore(s => s.locale)` re-render on switch.
 * All Paraglide message functions are direct imports that don't subscribe
 * to any store — they read from Paraglide's internal module state.
 */

import { create } from 'zustand';
import { detectInitialLocale, setLocale as paraglideSetLocale, type Locale } from './runtime';

interface I18nState {
  /** The currently active locale. */
  locale: Locale;
  /**
   * Set the active locale.
   *
   * This calls Paraglide's `setLocale` (which updates the module-level
   * message resolution) and updates this store (which triggers re-renders
   * only for components subscribed to `locale`).
   *
   * Persistence: The locale is also persisted via `useUIStore`'s localStorage
   * mechanism so it survives session restarts. This is done as a side effect
   * inside `setLocale` to avoid circular imports.
   */
  setLocale: (locale: Locale) => void;
}

export const useI18nStore = create<I18nState>()((set) => ({
  locale: 'en', // Overridden at startup by detectInitialLocale()
  setLocale: (locale: Locale) => {
    paraglideSetLocale(locale);
    set({ locale });
    // Persist to useUIStore for cross-session retention.
    // Import lazily to avoid circular dependency (useI18nStore → useUIStore).
    import('@/stores/useUIStore').then(({ useUIStore }) => {
      useUIStore.getState().setLocale(locale);
    });
  },
}));

/**
 * Initialize the i18n store from persisted preference + runtime detection.
 *
 * Call this once at app startup, BEFORE React renders, so that
 * Paraglide's module-level locale is set before any message functions
 * are called.
 */
export function initializeLocale(): Locale {
  // Read persisted locale from useUIStore's localStorage
  let persistedLocale: Locale | undefined;
  try {
    const stored = localStorage.getItem('ui-store');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed?.state?.locale) {
        persistedLocale = parsed.state.locale as Locale;
      }
    }
  } catch {
    // localStorage unavailable or corrupt — skip
  }

  const initialLocale = detectInitialLocale(persistedLocale);

  // Set both Paraglide's internal state and our Zustand store.
  // runtime.setLocale already passes { reload: false } to Paraglide.
  paraglideSetLocale(initialLocale);
  useI18nStore.setState({ locale: initialLocale });

  return initialLocale;
}