import React from 'react';
import type { GuestTone } from '@openchamber/sdk';
import { Icon } from '@/components/icon/Icon';
import { resolveGuestIconName } from '@/lib/guests/icon';
import { ROW_GUEST_MARKS_SHOWN, type RowGuestMark } from '@/lib/guests/marks';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { RowMarkTooltip } from './RowMarkTooltip';

// Written out in full: the stylesheet is built from the class names it finds in the source.
const MARK_TONE_CLASS = {
  neutral: 'text-muted-foreground',
  info: 'text-status-info',
  success: 'text-status-success',
  warning: 'text-status-warning',
  error: 'text-status-error',
} satisfies Record<GuestTone, string>;

/** An extension's mark as a bare icon in its tone; a name the sprite lacks draws the fallback glyph. */
export const GuestRowMarkIcon: React.FC<{ mark: RowGuestMark; className?: string }> = ({ mark, className }) => (
  <Icon name={resolveGuestIconName(mark.icon)} className={cn('h-3 w-3 flex-shrink-0', MARK_TONE_CLASS[mark.tone], className)} />
);

type Props = {
  /** Every mark of the row, in order; the first `ROW_GUEST_MARKS_SHOWN` are drawn. */
  marks: readonly RowGuestMark[];
  /** Opens what the mark opens: the extension's panel, or the mark's link when it has no panel. */
  onOpen: (mark: RowGuestMark) => void;
};

/**
 * The marks extensions put on a sidebar row (`contributes.marks`): an icon
 * each, named in a tooltip above it by the extension and the mark's text. A
 * mark with something to open is a button that keeps the press off the row,
 * as the row's PR badge does; one with nothing to open is an image.
 */
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

/** The row's marks as lines of its whole-row tooltip: icon, extension name and text, never a link. */
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
