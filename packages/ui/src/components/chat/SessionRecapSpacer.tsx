import React from 'react';
import { useSessionAssistState } from '@/hooks/useSessionAssist';
import { useI18n } from '@/lib/i18n';
import { TimelineRevealGateContext } from '@/components/chat/timelineRevealGate';

interface SessionRecapNoteProps {
  sessionId: string;
  directory?: string;
  isMobile: boolean;
}

// Quiet one-paragraph recap of the agent's last reply, rendered right under
// the last message (above the reserved bottom gap). Appears only after the
// 1-minute quiet window, so the layout shift happens off-screen in practice.
export const SessionRecapNote: React.FC<SessionRecapNoteProps> = React.memo(({ sessionId, directory, isMobile }) => {
  const { visibleRecap, sessionKnown } = useSessionAssistState(sessionId, directory);
  const { t } = useI18n();
  // The recap is part of the opened session's finished picture: until the
  // session record is in memory it cannot be decided, and appearing a commit
  // later would grow the footer under a viewport already pinned to the end.
  const revealGate = React.useContext(TimelineRevealGateContext);
  React.useLayoutEffect(() => {
    if (sessionKnown) return undefined;
    const release = revealGate?.hold();
    return release ?? undefined;
  }, [revealGate, sessionKnown]);

  if (!visibleRecap) {
    return null;
  }

  return (
    <div className="chat-message-column">
      {/* The last assistant turn carries pb-8 — pull the recap up into that gap. */}
      <div aria-label={t('chat.recap.aria')}>
        <span className={`typography-meta text-muted-foreground/70 ${isMobile ? 'line-clamp-4' : 'line-clamp-2'}`}>
          <span className="italic text-muted-foreground/50">{t('chat.recap.label')} </span>
          {visibleRecap}
        </span>
      </div>
    </div>
  );
});

SessionRecapNote.displayName = 'SessionRecapNote';
