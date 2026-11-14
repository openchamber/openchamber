import type { ReactNode } from 'react';

import { Icon } from '@/components/icon/Icon';
import { BusyDots } from '@/components/ui/busy-dots';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type { ReceivedPageItem } from '@/lib/received-pages/api';

import { reloadReceivedPages, useReceivedPages } from './receivedPagesStore';
import { receivedStatusLook } from './status';

/**
 * The pages other people shared with this user (decision 0018), newest first:
 * what each is, who it came from, where it stands. A row opens the page. The
 * `pages` surface shows it when no page tab is open; the phone's workspace
 * drawer shows it as a tab.
 */
export function ReceivedPagesList({ onOpen }: { onOpen: (page: ReceivedPageItem, title: string) => void }) {
  const { t } = useI18n();
  const { pages, error, turnedOff } = useReceivedPages();

  const message = (text: ReactNode) => (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">{text}</div>
  );
  if (turnedOff) return message(t('chat.sharedPage.turnedOff'));
  if (pages === null) {
    return message(error ? (
      <span className="flex items-center gap-2">
        {t('chat.sharedPage.list.loadFailed')}
        <Button type="button" size="xs" variant="ghost" onClick={reloadReceivedPages}>{t('chat.sharedPage.retry')}</Button>
      </span>
    ) : <>{t('chat.sharedPage.list.loading')}<BusyDots /></>);
  }
  if (pages.length === 0) return message(t('chat.sharedPage.list.empty'));

  return (
    <ul className="flex flex-col gap-0.5 overflow-y-auto p-2" aria-label={t('contextPanel.mode.pages')}>
      {pages.map((page) => {
        const title = page.title || t('chat.sharedPage.untitled');
        const look = receivedStatusLook(page);
        return (
          <li key={page.receivedId}>
            <button
              type="button"
              onClick={() => onOpen(page, title)}
              className="flex w-full min-w-0 flex-col gap-0.5 rounded-lg px-2.5 py-2 text-start transition-colors hover:bg-[var(--interactive-hover)] pointer-coarse:min-h-11"
            >
              <span className="flex w-full min-w-0 items-center gap-1.5">
                <Icon name="pages" className="size-3.5 shrink-0 text-muted-foreground" />
                <span dir="auto" className="min-w-0 truncate text-sm text-foreground">{title}</span>
              </span>
              <span className="flex w-full min-w-0 items-center gap-1 text-xs text-muted-foreground">
                {/* Who sent it: the link's host until pages carry a sender's name. */}
                <span dir="ltr" className="min-w-0 shrink truncate">{page.host}</span>
                <span aria-hidden>·</span>
                <span className="flex min-w-0 items-center gap-1" style={look.color ? { color: look.color } : undefined}>
                  <Icon name={look.icon} className="size-3.5 shrink-0" />
                  <span className="truncate">{t(look.key)}</span>
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
