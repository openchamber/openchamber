import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import type { ContextPartPayload } from '@/lib/messages/contextParts';

import { useOpenReceivedPage } from './openReceivedPage';
import { receivedStatusLook } from './status';
import { useReceivedPage } from './useReceivedPage';
import { useReceivedPageText } from './useReceivedPageText';

/**
 * Under the user's message that carried a page someone else shared: its
 * title, what it asks or holds, where it stands, and Open. The state is read
 * live from the server, so the card turns to "answer sent" once the user
 * answers in the tab, on every window.
 */
export function ReceivedPageCard({ payload }: { payload: Extract<ContextPartPayload, { kind: 'shared-page' }> }) {
  const { t } = useI18n();
  const state = useReceivedPage(payload.receivedId);
  const page = state.page;
  const text = useReceivedPageText(page);
  const openPage = useOpenReceivedPage();

  const title = page?.title || payload.title || t('chat.sharedPage.chip.label', { host: payload.host });
  const look = page ? receivedStatusLook(page) : null;
  const receivedId = payload.receivedId;
  const canOpen = !state.missing && !state.turnedOff && !isVSCodeRuntime();

  return (
    <div data-component="received-page-card" className="my-1.5 min-w-0 max-w-full border-s-2 border-[var(--interactive-border)] ps-3">
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Icon name="pages" className="size-3.5 shrink-0" />
        <span dir="auto" className="min-w-0 truncate text-sm text-[var(--surface-foreground)]" title={title}>{title}</span>
        {canOpen && receivedId ? (
          <Button type="button" size="xs" variant="ghost" className="ms-auto shrink-0 pointer-coarse:h-9" onClick={() => openPage(receivedId, title)}>
            {t('chat.sharedPage.card.open')}
          </Button>
        ) : null}
      </div>
      {text?.outline.length ? (
        <ul className="mt-1 flex flex-col gap-0.5 text-[0.8125rem] text-[var(--surface-foreground)]">
          {text.outline.slice(0, 4).map((line, index) => (
            <li key={index} className="flex min-w-0 gap-2">
              <span aria-hidden className="text-muted-foreground">•</span>
              <span dir="auto" className="min-w-0 truncate oc-ui-start-align">{line}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground" style={look?.color ? { color: look.color } : undefined}>
        {state.turnedOff ? t('chat.sharedPage.turnedOff')
          : state.missing ? t('chat.sharedPage.card.gone')
          : !payload.receivedId ? t('chat.sharedPage.status.notOpened')
            : look ? (
              <>
                <Icon name={look.icon} className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">{t(look.key)}</span>
              </>
            ) : null}
      </p>
    </div>
  );
}
