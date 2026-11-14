import React from 'react';
import { toast } from '@/components/ui';
import { GuestRowMarkIcon } from '@/components/session/sidebar/sessions/GuestRowMarks';
import { ROW_GUEST_MARKS_SHOWN, type RowGuestMark } from '@/lib/guests/marks';
import { openGuestSurface } from '@/lib/guests/open-surface';
import { mayGuestShowOnPhone } from '@/lib/guests/phone';
import { useGuestsStore } from '@/lib/guests/store';
import { useI18n } from '@/lib/i18n';
import { pluginModeFromId } from '@/lib/surfaces/modes';
import { openExternalUrl } from '@/lib/url';

/** Whether a tap on the mark opens its extension's tab: it has a panel, opted into the phone. */
const opensPanelHere = (mark: RowGuestMark): boolean => {
  if (!mark.panel) return false;
  const guest = useGuestsStore.getState().guests.find((entry) => entry.id === mark.guestId);
  return Boolean(guest && mayGuestShowOnPhone(guest, 'panel'));
};

/**
 * The marks extensions put on a row (`contributes.marks`), drawn as the
 * desktop row draws them: an icon each in its tone, the first two. A tap on a
 * mark of an extension that opted its panel into the phone does what a
 * desktop click does: opens the row (`onOpenRow`), then the extension's
 * workspace tab, with no item, as the desktop panel gets none. Any other mark
 * says what the desktop tooltip says, since a phone has no hover, and opens
 * the mark's link when it has one. The tap stays off the row.
 */
export const MobileGuestMarks: React.FC<{
  marks: readonly RowGuestMark[];
  /** Opens what the row stands for, as a tap on the row does. */
  onOpenRow: () => void;
}> = ({ marks, onOpenRow }) => {
  const { t } = useI18n();
  if (marks.length === 0) return null;
  return <>
    {marks.slice(0, ROW_GUEST_MARKS_SHOWN).map((mark) => {
      const label = t('sessions.sidebar.session.guestMark.label', { name: mark.guestName, text: mark.text });
      return (
        // A span: the row it sits in is a button. The pseudo-element widens
        // the 12px icon to a 28px hit area without moving its neighbours.
        <span
          key={mark.guestId}
          data-guest-mark={mark.guestId}
          role="img"
          aria-label={label}
          className="relative inline-flex shrink-0 items-center before:absolute before:-inset-2 before:content-['']"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (opensPanelHere(mark)) {
              onOpenRow();
              if (openGuestSurface({ mode: pluginModeFromId(mark.guestId), directory: null, supported: true }).ok) return;
            }
            toast.info(label);
            if (mark.url) void openExternalUrl(mark.url);
          }}
        >
          <GuestRowMarkIcon mark={mark} />
        </span>
      );
    })}
  </>;
};
