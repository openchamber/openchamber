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

const opensPanelHere = (mark: RowGuestMark): boolean => {
  if (!mark.panel) return false;
  const guest = useGuestsStore.getState().guests.find((entry) => entry.id === mark.guestId);
  return Boolean(guest && mayGuestShowOnPhone(guest, 'panel'));
};

export const MobileGuestMarks: React.FC<{
  marks: readonly RowGuestMark[];
  onOpenRow: () => void;
}> = ({ marks, onOpenRow }) => {
  const { t } = useI18n();
  if (marks.length === 0) return null;
  return <>
    {marks.slice(0, ROW_GUEST_MARKS_SHOWN).map((mark) => {
      const label = t('sessions.sidebar.session.guestMark.label', { name: mark.guestName, text: mark.text });
      return (
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
