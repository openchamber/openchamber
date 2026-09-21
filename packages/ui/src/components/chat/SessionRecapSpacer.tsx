import React from 'react';
import { useSessionAssistState } from '@/hooks/useSessionAssist';
import { useI18n } from '@/lib/i18n';

interface SessionRecapNoteProps {
  sessionId: string;
  directory?: string;
  isMobile: boolean;
}

// Quiet one-paragraph recap of the agent's last reply. A hint about the
// current state rather than part of the transcript: it floats over the
// reserved band above the composer (the same anchor as the working status
// row, which it never overlaps with — one needs an idle session, the other
// a working one), fades with that anchor when the reader scrolls away from
// the end, and simply vanishes in place once a new message makes it stale.
// Appears only after the 1-minute quiet window.
export const SessionRecapNote: React.FC<SessionRecapNoteProps> = React.memo(({ sessionId, directory, isMobile }) => {
  const { visibleRecap } = useSessionAssistState(sessionId, directory);
  const { t } = useI18n();

  if (!visibleRecap) {
    return null;
  }

  return (
    <div aria-label={t('chat.recap.aria')} className="px-1">
      <span className={`typography-meta text-muted-foreground/70 ${isMobile ? 'line-clamp-3' : 'line-clamp-2'}`}>
        <span className="italic text-muted-foreground/50">{t('chat.recap.label')} </span>
        {visibleRecap}
      </span>
    </div>
  );
});

SessionRecapNote.displayName = 'SessionRecapNote';
