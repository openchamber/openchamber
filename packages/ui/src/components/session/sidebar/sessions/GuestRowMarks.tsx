import React from 'react';
import type { GuestTone } from '@openchamber/sdk';
import { Icon } from '@/components/icon/Icon';
import { resolveGuestIconName } from '@/lib/guests/icon';
import { ROW_GUEST_MARKS_SHOWN, type RowGuestMark } from '@/lib/guests/marks';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { RowMarkTooltip } from './RowMarkTooltip';

const MARK_TONE_CLASS = {
  neutral: 'text-muted-foreground',
  info: 'text-status-info',
  success: 'text-status-success',
  warning: 'text-status-warning',
  error: 'text-status-error',
} satisfies Record<GuestTone, string>;

export const GuestRowMarkIcon: React.FC<{ mark: RowGuestMark; className?: string }> = ({ mark, className }) => (
  <Icon name={resolveGuestIconName(mark.icon)} className={cn('h-3 w-3 flex-shrink-0', MARK_TONE_CLASS[mark.tone], className)} />
);

type Props = {
  marks: readonly RowGuestMark[];
  onOpen: (mark: RowGuestMark) => void;
};

export const GuestRowMarks: React.FC<Props> = ({ marks, onOpen }) => {
  const { t } = useI18n();
  return <>
    {marks.slice(0, ROW_GUEST_MARKS_SHOWN).map((mark) => {
      const label = t('sessions.sidebar.session.guestMark.label', { name: mark.guestName, text: mark.text });
      return (
        <RowMarkTooltip key={mark.guestId} label={label}>
          {mark.panel || mark.url ? (
            <button
              type="button"
              data-guest-mark={mark.guestId}
              className="inline-flex flex-shrink-0 items-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={label}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onKeyDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpen(mark);
              }}
            >
              <GuestRowMarkIcon mark={mark} />
            </button>
          ) : (
            <span data-guest-mark={mark.guestId} className="inline-flex flex-shrink-0 items-center" role="img" aria-label={label}>
              <GuestRowMarkIcon mark={mark} />
            </span>
          )}
        </RowMarkTooltip>
      );
    })}
  </>;
};

export const GuestRowMarkLines: React.FC<{ marks: readonly RowGuestMark[] }> = ({ marks }) => {
  const { t } = useI18n();
  return <>
    {marks.map((mark) => (
      <div key={mark.guestId} data-guest-mark-line={mark.guestId} className="flex min-w-0 items-start gap-1.5 text-muted-foreground">
        <GuestRowMarkIcon mark={mark} className="mt-0.5" />
        <span dir="auto" className="oc-ui-start-align min-w-0 break-words">{t('sessions.sidebar.session.guestMark.label', { name: mark.guestName, text: mark.text })}</span>
      </div>
    ))}
  </>;
};
