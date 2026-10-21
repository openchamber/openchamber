/**
 * The export document's own text.
 *
 * The document is read by a person, so it speaks the app's language. The
 * renderers are not components and hold no hook, so they read the current
 * dictionary when they write, not when they are loaded: a locale change
 * between two exports changes the second document.
 */

import { formatMessage, useI18nStore, type I18nKey, type I18nParams } from '@/lib/i18n';

/** The export document's text, in the reader's language. */
export const exportText = (key: I18nKey, params?: I18nParams): string => (
  formatMessage(useI18nStore.getState().dictionary, key, params)
);
