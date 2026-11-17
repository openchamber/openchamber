import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n';
import type { ReceivedPage } from '@/lib/received-pages/api';

export type ReceivedStatusLook = { icon: IconName; key: I18nKey; color?: string };

export function receivedStatusLook(page: Pick<ReceivedPage, 'status' | 'opened' | 'wantsAnswer'> & { answer: object | null }): ReceivedStatusLook {
  if (page.answer) return { icon: 'checkbox-circle', key: 'chat.sharedPage.status.answerSent', color: 'var(--status-success)' };
  switch (page.status) {
    case 'locked':
      return { icon: 'lock', key: 'chat.sharedPage.status.locked', color: 'var(--status-error)' };
    case 'expired':
      return { icon: 'time', key: 'chat.sharedPage.status.expired' };
    case 'answered':
      return { icon: 'checkbox-circle', key: 'chat.sharedPage.status.answeredElsewhere' };
    case 'cancelled':
      return { icon: 'close-circle', key: 'chat.sharedPage.status.cancelled' };
    case 'missing':
      return { icon: 'error-warning', key: 'chat.sharedPage.status.missing' };
    case 'open':
      if (!page.opened) return { icon: 'lock', key: 'chat.sharedPage.status.notOpened' };
      return page.wantsAnswer
        ? { icon: 'time', key: 'chat.sharedPage.status.waiting', color: 'var(--status-warning)' }
        : { icon: 'eye', key: 'chat.sharedPage.status.readOnly' };
  }
}

export const takesAnswerNow = (page: ReceivedPage): boolean => page.opened && page.wantsAnswer && !page.answer && page.status === 'open';
