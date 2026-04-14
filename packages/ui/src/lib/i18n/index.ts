/**
 * i18n barrel export — re-exports everything from the i18n modules.
 *
 * Usage:
 *   import { useI18nStore, AVAILABLE_LOCALES, LOCALE_LABELS } from '@/lib/i18n';
 *   import { detectInitialLocale, initializeLocale } from '@/lib/i18n';
 *   import { toast } from '@/lib/i18n';
 *   import { I18nProvider, useLocale } from '@/lib/i18n';
 */

export { useI18nStore, initializeLocale } from './store';
export {
  detectInitialLocale,
  normalizeLocale,
  setLocale,
  getLocale,
  AVAILABLE_LOCALES,
  LOCALE_LABELS,
  type Locale,
} from './runtime';
export { toast } from './toast';
export { I18nProvider, useLocale } from './context';