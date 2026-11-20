import React from 'react';
import { Popover } from '@base-ui/react/popover';

import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Icon } from '@/components/icon/Icon';
import { dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import { GlassRedrawGuard } from '@/components/ui/glass-redraw-guard';
import { useMinuteTickerNow } from '@/hooks/useDurationTicker';
import { useI18n } from '@/lib/i18n';
import { getLeadDigest } from '@/lib/sessionLead';
import { cn } from '@/lib/utils';
import { useSession } from '@/sync/live-session-hooks';

type Translate = ReturnType<typeof useI18n>['t'];

const MINUTE_MS = 60_000;

const relativeTime = (t: Translate, at: number, now: number): string => {
  const minutes = Math.floor(Math.max(0, now - at) / MINUTE_MS);
  if (minutes < 1) return t('common.relative.justNow');
  if (minutes < 60) return t('common.relative.minutesAgoShort', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('common.relative.hoursAgoShort', { count: hours });
  return t('common.relative.daysAgoShort', { count: Math.floor(hours / 24) });
};

const DigestSection: React.FC<{ title: string; items: string[]; waiting?: boolean }> = ({ title, items, waiting = false }) => {
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-1">
      <h3 className={cn('typography-micro font-medium', waiting ? 'text-status-warning' : 'text-muted-foreground')}>{title}</h3>
      <SimpleMarkdownRenderer
        content={items.map((item) => `- ${item}`).join('\n')}
        className="typography-meta text-foreground [&_ul]:my-0 [&_ul]:ps-4"
        enableFileReferences={false}
      />
    </section>
  );
};

export const LeadDigestRow: React.FC<{ sessionId: string | null; directory: string | undefined }> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const session = useSession(sessionId, directory);
  const digest = getLeadDigest(session);
  const now = useMinuteTickerNow(digest !== null);
  if (!digest) return null;

  const waiting = digest.needsYou.length;
  const summary = (digest.now[0] ?? digest.news[0] ?? digest.needsYou[0] ?? '').replace(/`/g, '');
  return (
    <Popover.Root>
      <Popover.Trigger
        data-lead-digest=""
        className="group/digest relative z-20 flex h-7 w-full min-w-0 shrink-0 items-center gap-1.5 bg-background px-4 text-start typography-meta text-muted-foreground hover:text-foreground focus-visible:outline-none"
      >
        <Icon name="arrow-right-s" className="size-3.5 shrink-0 transition-transform group-data-[popup-open]/digest:rotate-90 rtl:group-data-[popup-open]/digest:-rotate-90" />
        {waiting > 0 ? (
          <span className="shrink-0 text-status-warning">
            {waiting === 1 ? t('chat.leadDigest.needsYouOne') : t('chat.leadDigest.needsYouMany', { count: waiting })}
          </span>
        ) : null}
        {waiting > 0 && summary ? <span aria-hidden="true" className="shrink-0 text-muted-foreground/50">·</span> : null}
        <span dir="auto" className="min-w-0 flex-1 truncate text-foreground">{summary}</span>
        <span className="shrink-0 tabular-nums">{relativeTime(t, digest.updatedAt, now)}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="center" sideOffset={2} className="z-50">
          <Popover.Popup className={cn(dropdownMenuPopupClass, 'flex max-h-[min(60vh,var(--available-height))] w-[calc(var(--anchor-width)-1.5rem)] flex-col gap-3 overflow-y-auto px-4 py-3')}>
            <DigestSection title={t('chat.leadDigest.needsYou')} items={digest.needsYou} waiting />
            <DigestSection title={t('chat.leadDigest.now')} items={digest.now} />
            <DigestSection title={t('chat.leadDigest.news')} items={digest.news} />
            <GlassRedrawGuard />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};
