import type { z } from 'zod';

import type { I18nKey, I18nParams } from '@/lib/i18n';
import type { waitArgsSchema } from '@/sync/extension-waits';

type Translate = (key: I18nKey, params?: I18nParams) => string;

type NamedWait = {
  source: string;
  title: string;
  label?: string | null;
  extension?: string | null;
  args?: z.infer<typeof waitArgsSchema>;
};

const TIMER_SOURCE = 'timer';
const SCRIPT_SOURCE = 'script';
const MINUTE_MS = 60_000;

export const waitSubject = (wait: NamedWait, t: Translate): string => {
  if (wait.source === TIMER_SOURCE) {
    const minutes = wait.args?.minutes;
    return minutes === undefined ? t('chat.waits.source.timer') : t('chat.waits.timer', { minutes });
  }
  if (wait.source === SCRIPT_SOURCE) {
    const minutes = wait.args?.minutes;
    return minutes === undefined ? t('chat.waits.source.script') : t('chat.waits.script', { minutes });
  }
  return wait.label ? `${wait.title} (${wait.label})` : wait.title;
};

export const timerMinutesLeft = (wait: NamedWait & { startedAt: number }, now: number): number | undefined => {
  const minutes = wait.args?.minutes;
  if (wait.source !== TIMER_SOURCE || minutes === undefined) return undefined;
  const left = Math.ceil((wait.startedAt + minutes * MINUTE_MS - now) / MINUTE_MS);
  return left > 0 ? left : undefined;
};

export const waitOrigin = (wait: NamedWait): string | undefined => (
  wait.source.includes('/') && wait.extension ? wait.extension : undefined
);
