import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { isReviewSuggested } from '@/lib/sessionWorkMetadata';
import { useSession, useSessionStatus } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { useWalkthroughStore } from '@/stores/useWalkthroughStore';

interface SessionReviewHintRowProps {
  sessionId: string | null;
  directory?: string;
  /** Opens the composer's review dialog, the one `/handoff-review` opens. */
  onAIReview: () => void;
}

/**
 * Jev thinks the last turn handed over changes worth a look. The same quiet
 * top row as the done hint, offering an AI review by another agent or a
 * walkthrough of the working tree; it goes away with the next message.
 */
export const SessionReviewHintRow: React.FC<SessionReviewHintRowProps> = React.memo(({ sessionId, directory, onAIReview }) => {
  const { t } = useI18n();
  const session = useSession(sessionId ?? '', directory);
  const status = useSessionStatus(sessionId ?? '', directory);
  const reviewOfferEnabled = useUIStore((state) => state.sessionReviewOfferEnabled);
  const openContextSurface = useUIStore((state) => state.openContextSurface);
  const requestWalkthroughTarget = useWalkthroughStore((state) => state.requestTarget);
  const isIdle = !status || status.type === 'idle';

  if (!sessionId || !directory || !reviewOfferEnabled || !isIdle || !isReviewSuggested(session)) return null;

  const handleWalkthrough = () => {
    // The whole working tree: what this session changed is not separable
    // from other sessions working in the same directory.
    requestWalkthroughTarget(directory, { source: { kind: 'working-tree', scope: 'all' } });
    openContextSurface(directory, 'walkthrough');
  };

  return (
    <div className="flex h-10 items-center gap-2 border-b border-border/60 pl-3 pr-1.5">
      <Icon name="file-edit" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{t('chat.work.reviewHint.text')}</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onAIReview}
        onMouseDown={(event) => event.preventDefault()}
        className="shrink-0 text-foreground/80 hover:bg-transparent hover:text-foreground"
      >
        {t('chat.work.reviewHint.aiReview')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleWalkthrough}
        onMouseDown={(event) => event.preventDefault()}
        className="shrink-0 text-status-info/80 hover:bg-transparent hover:text-status-info"
      >
        {t('walkthrough.action.open')}
      </Button>
    </div>
  );
});

SessionReviewHintRow.displayName = 'SessionReviewHintRow';
