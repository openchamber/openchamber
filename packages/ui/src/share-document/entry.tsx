import { createRoot } from 'react-dom/client';

import appCss from '@/index.css?inline';
import { normalizeLocale, type Locale } from '@/lib/i18n/runtime';
import type { JsonValue } from '@/lib/opencode/model';
import { CSSVariableGenerator } from '@/lib/theme/cssGenerator';
import { createShareSubmitter, viewerMessageSchema } from './protocol';
import { SHARE_PAGE_DATA_ID, SHARE_PAGE_ROOT_ID, sharePageDataSchema } from './page';
import { SharePage } from './SharePage';
import { darkScheme, darkTheme, lightTheme } from './themes';

/**
 * A shared `ui` page: the chat's own UI block renderer, run in the document
 * the relay's viewer shows another person. The page carries its program as
 * JSON (`page.ts`); this mounts it with OpenChamber's default light and dark
 * themes (picked by the reader's system), the reader's language, and a host
 * that sends the form's answer to the viewer. The page waits like a form an
 * agent waits on, so it gets the note and the Send the chat adds.
 */

// The app's stylesheet, its theme variables for both schemes, and what a page
// on its own needs: it scrolls itself and sits on the theme's background.
// One width for the whole page, by what it is: a questionnaire keeps a reading
// column, a page the recipients only read (a report with tables and charts)
// gets room for them. Wider blocks scroll sideways inside themselves.
function installStyles(expectAnswer: boolean) {
  const generator = new CSSVariableGenerator();
  const style = document.createElement('style');
  style.textContent = `${appCss}\n:root{\n${generator.generate(lightTheme)}\n}\n@media (prefers-color-scheme: dark){:root{\n${generator.generate(darkTheme)}\n}}\n`
    + 'html,body{height:auto;min-height:100%;overflow:auto;background:var(--background);color:var(--foreground)}'
    + `#${SHARE_PAGE_ROOT_ID}{box-sizing:border-box;max-width:${expectAnswer ? '48rem' : '64rem'};margin:0 auto;padding:24px 16px 40px}`;
  document.head.appendChild(style);
}

const applyScheme = () => {
  const dark = darkScheme.matches;
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.classList.toggle('light', !dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
};

const readerLocale = (): Locale => normalizeLocale(navigator.languages?.[0] ?? navigator.language);

function mount() {
  const root = document.getElementById(SHARE_PAGE_ROOT_ID);
  const data = sharePageDataSchema.safeParse(JSON.parse(document.getElementById(SHARE_PAGE_DATA_ID)?.textContent || 'null'));
  if (!root || !data.success) return;
  installStyles(data.data.expectAnswer);
  applyScheme();
  darkScheme.addEventListener('change', applyScheme);

  let localeListener: ((locale: Locale) => void) | null = null;
  let viewerLocale: Locale | null = null;
  let answerListener: ((answer: JsonValue) => void) | null = null;
  let sentAnswer: JsonValue | null = null;
  const submit = createShareSubmitter({
    // An opaque-origin page can only address its parent as any origin.
    post: (message) => window.parent.postMessage(message, '*'),
    listen: (handler) => window.addEventListener('message', (event) => {
      if (event.source !== window.parent) return;
      const message = viewerMessageSchema.safeParse(event.data);
      if (message.success) handler(message.data);
    }),
    // The viewer picks the reader's language from the same list; its pick wins.
    onInit: ({ locale, answer }) => {
      // The recipient's app shows a page it already answered: frozen on that answer.
      if (answer !== undefined && answer !== null) {
        sentAnswer = answer;
        answerListener?.(answer);
      }
      if (!locale) return;
      viewerLocale = normalizeLocale(locale);
      localeListener?.(viewerLocale);
    },
  });
  const subscribeLocale = (listener: (locale: Locale) => void) => {
    localeListener = listener;
    if (viewerLocale) listener(viewerLocale);
  };
  const subscribeAnswer = (listener: (answer: JsonValue) => void) => {
    answerListener = listener;
    if (sentAnswer !== null) listener(sentAnswer);
  };
  createRoot(root).render(
    <SharePage source={data.data.ui} takesAnswer={data.data.expectAnswer} initialLocale={readerLocale()} subscribeLocale={subscribeLocale} subscribeAnswer={subscribeAnswer} submit={submit} />,
  );
}

mount();
