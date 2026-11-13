import React from 'react';
import { useSessionAssistState } from '@/hooks/useSessionAssist';
import { useI18n } from '@/lib/i18n';

interface SessionRecapNoteProps {
  sessionId: string;
  directory?: string;
  isMobile: boolean;
}

// Quiet one-paragraph recap of the agent's last reply. A hint about the
// current state rather than part of the transcript: it lies over the empty
// band the transcript keeps above the composer, right under the last
// answer's footer (ChatContainer's tail spacer), and simply vanishes in place
// once a new message makes it stale. Appears only after the 1-minute quiet
// window.
export const SessionRecapNote: React.FC<SessionRecapNoteProps> = React.memo(({ sessionId, directory, isMobile }) => {
  const { visibleRecap } = useSessionAssistState(sessionId, directory);
  const { t } = useI18n();

  if (!visibleRecap) {
    return null;
  }

  return (
    <div aria-label={t('chat.recap.aria')}>
      <span className={`typography-meta text-muted-foreground ${isMobile ? 'line-clamp-3' : 'line-clamp-2'}`}>
        <span className="italic text-muted-foreground">{t('chat.recap.label')} </span>
        {visibleRecap}
      </span>
    </div>
  );
});

SessionRecapNote.displayName = 'SessionRecapNote';
