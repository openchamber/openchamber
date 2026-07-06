import React from 'react';
import { useSessionAssistState } from '@/hooks/useSessionAssist';
import { useI18n } from '@/lib/i18n';

interface SessionRecapNoteProps {
  sessionId: string;
  isMobile: boolean;
}

// Quiet one-paragraph recap of the agent's last reply, rendered right under
// the last message (above the reserved bottom gap). Appears only after the
// 5-minute quiet window, so the layout shift happens off-screen in practice.
export const SessionRecapNote: React.FC<SessionRecapNoteProps> = React.memo(({ sessionId, isMobile }) => {
  const { visibleRecap } = useSessionAssistState(sessionId);
  const { t } = useI18n();

  if (!visibleRecap) {
    return null;
  }

  return (
    <div className="chat-message-column">
      {/* The last assistant turn carries pb-8 — pull the recap up into that gap. */}
      <div className="-mt-6" aria-label={t('chat.recap.aria')}>
        <span className={`typography-meta text-muted-foreground/70 ${isMobile ? 'line-clamp-4' : 'line-clamp-2'}`}>
          <span className="italic text-muted-foreground/50">{t('chat.recap.label')} </span>
          {visibleRecap}
        </span>
      </div>
    </div>
  );
});

SessionRecapNote.displayName = 'SessionRecapNote';
