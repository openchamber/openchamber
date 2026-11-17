import React from 'react';
import { useSessionAssistState } from '@/hooks/useSessionAssist';
import { useI18n } from '@/lib/i18n';

interface SessionRecapNoteProps {
  sessionId: string;
  directory?: string;
  isMobile: boolean;
}

const plainRecap = (recap: string): string => recap
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\*\*([^*]+)\*\*/g, '$1');

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
        {plainRecap(visibleRecap)}
      </span>
    </div>
  );
});

SessionRecapNote.displayName = 'SessionRecapNote';
