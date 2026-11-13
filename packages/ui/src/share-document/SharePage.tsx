import React from 'react';
import { DirectionProvider } from '@base-ui/react/direction-provider';

import { UiBlock, type UiBlockHost } from '@/components/chat/uiBlocks/UiBlock';
import { pageAnswerSummary, type UiBlockAnswer } from '@/components/chat/uiBlocks/answer';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { formatTemplate } from '@/lib/i18n/format';
import { I18nContext, type I18nContextValue } from '@/lib/i18n/react-context';
import { getLocaleDirection, LOCALE_LABEL_KEYS, LOCALES, type Locale } from '@/lib/i18n/runtime';
import { DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID } from '@/lib/theme/themes';
import type { JsonValue } from '@/lib/opencode/model';
import type { Theme } from '@/types/theme';
import { SHARE_DOCUMENT_MESSAGES } from './messages.generated';
import { setShareIntlLocale } from './shims/i18n';
import { darkScheme, darkTheme, lightTheme } from './themes';


const intlTag = (locale: Locale): string => (locale === 'ar' ? 'ar-u-nu-latn' : locale);

const noop = () => undefined;
const noopAsync = async () => undefined;

function useSchemeTheme(): Theme {
  return React.useSyncExternalStore(
    (notify) => {
      darkScheme.addEventListener('change', notify);
      return () => darkScheme.removeEventListener('change', notify);
    },
    () => (darkScheme.matches ? darkTheme : lightTheme),
  );
}

/** The program drawn with the chat's renderer, in the reader's language and system theme, answering through `submit`. */
export function SharePage({ source, takesAnswer, initialLocale, subscribeLocale, submit }: {
  source: string;
  takesAnswer: boolean;
  initialLocale: Locale;
  subscribeLocale: (listener: (locale: Locale) => void) => void;
  submit: (data: JsonValue, summary: string) => Promise<void>;
}) {
  const [locale, setLocale] = React.useState(initialLocale);
  React.useEffect(() => subscribeLocale(setLocale), [subscribeLocale]);
  const direction = getLocaleDirection(locale);
  React.useLayoutEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = direction;
    setShareIntlLocale(intlTag(locale));
  }, [direction, locale]);

  const i18n = React.useMemo<I18nContextValue>(() => {
    const dictionary = new Map(Object.entries(SHARE_DOCUMENT_MESSAGES[locale]));
    const english = new Map(Object.entries(SHARE_DOCUMENT_MESSAGES.en));
    const t: I18nContextValue['t'] = (key, params) => formatTemplate(dictionary.get(key) ?? english.get(key) ?? key, params);
    return { locale, direction, locales: LOCALES, setLocale: noop, label: (target) => t(LOCALE_LABEL_KEYS[target]), t };
  }, [direction, locale]);

  const currentTheme = useSchemeTheme();
  const theme = React.useMemo<ThemeContextValue>(() => ({
    currentTheme,
    availableThemes: [lightTheme, darkTheme],
    customThemeIds: [],
    setTheme: noop,
    customThemesLoading: false,
    reloadCustomThemes: noopAsync,
    importTheme: async () => currentTheme,
    deleteImportedTheme: noopAsync,
    isSystemPreference: true,
    setSystemPreference: noop,
    themeMode: 'system',
    setThemeMode: noop,
    lightThemeId: DEFAULT_LIGHT_THEME_ID,
    darkThemeId: DEFAULT_DARK_THEME_ID,
    setLightThemePreference: noop,
    setDarkThemePreference: noop,
  }), [currentTheme]);

  // Once the viewer has the answer it replaces the page with its own "sent"
  // screen; until then the form freezes on what was sent. A page that takes no
  // answer draws like one the agent only shows: no note, no Send.
  const [sent, setSent] = React.useState<UiBlockAnswer | null>(null);
  const host = React.useMemo<UiBlockHost>(() => ({
    kind: 'page',
    submit: sent || !takesAnswer ? null : async (answer) => {
      await submit(answer.data, pageAnswerSummary(answer.summary));
      setSent(answer);
    },
    answered: sent?.data ?? null,
  }), [sent, submit, takesAnswer]);

  return (
    <I18nContext.Provider value={i18n}>
      <DirectionProvider direction={direction}>
        <ThemeSystemContext.Provider value={theme}>
          <TooltipProvider>
            <UiBlock source={source} complete host={host} />
          </TooltipProvider>
        </ThemeSystemContext.Provider>
      </DirectionProvider>
    </I18nContext.Provider>
  );
}

