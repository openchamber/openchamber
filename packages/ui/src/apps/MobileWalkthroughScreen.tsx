import React from 'react';
import { cn } from '@/lib/utils';

import { Icon } from '@/components/icon/Icon';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import {
  WalkthroughBanners,
  WalkthroughEmptyState,
  WalkthroughOptions,
  WalkthroughStepMenu,
} from '@/components/views/walkthrough/WalkthroughControls';
import { WalkthroughBlocker } from '@/components/views/walkthrough/WalkthroughBlocker';
import { WalkthroughStages } from '@/components/views/walkthrough/WalkthroughStages';
import { WalkthroughStream } from '@/components/views/walkthrough/WalkthroughStream';
import { WalkthroughToc } from '@/components/views/walkthrough/WalkthroughToc';
import { useWalkthroughReview } from '@/components/views/walkthrough/useWalkthroughReview';
import { useI18n } from '@/lib/i18n';
import type { WalkthroughTarget } from '@/lib/walkthrough/types';
import { diffCommentOriginFromTarget } from '@/lib/diffCommentOrigin';
import { MOBILE_HEADER_BUTTON_CLASS, MOBILE_HEADER_CLASS, MOBILE_HEADER_TITLE_CLASS } from '@/components/ui/mobileHeader';

export const MobileWalkthroughScreen: React.FC<{
  directory: string;
  target: WalkthroughTarget;
  subtitle: string;
  revision: string;
  visible: boolean;
  onBack: () => void;
}> = ({ directory, target, subtitle, revision, visible, onBack }) => {
  const { t } = useI18n();
  const review = useWalkthroughReview({ directory, target, visible, needsSourceSelection: false, revision });
  const { view } = review;
  const commentOrigin = React.useMemo(() => diffCommentOriginFromTarget(target), [target]);
  const [optionsOpen, setOptionsOpen] = React.useState(false);
  const generatedAt = review.entry.result?.generatedAt ?? null;
  const [readingAt, setReadingAt] = React.useState<string | null>(null);
  const reading = view !== null && readingAt !== null && readingAt === generatedAt;

  const openStop = (stopId: string) => {
    review.handleSelectStop(stopId);
    setReadingAt(generatedAt);
  };
  const goBack = () => {
    if (reading) setReadingAt(null);
    else onBack();
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <header className={cn(MOBILE_HEADER_CLASS, 'border-b border-edge text-foreground')}>
        <button type="button" className={MOBILE_HEADER_BUTTON_CLASS} aria-label={t('header.actions.backAria')} onClick={goBack}>
          <Icon name="arrow-left" className="size-5" />
        </button>
        <div className="min-w-0 flex-1 px-1">
          <h2 className={cn('truncate', MOBILE_HEADER_TITLE_CLASS)}>{t('contextPanel.mode.walkthrough')}</h2>
          <p className="truncate typography-meta text-muted-foreground">{subtitle}</p>
        </div>
        {reading && view ? (
          <>
            <button type="button" className={MOBILE_HEADER_BUTTON_CLASS} aria-label={t('walkthrough.action.previous')} onClick={() => review.step(-1)}>
              <Icon name="arrow-right-s" className="size-5 rotate-180" />
            </button>
            <WalkthroughStepMenu review={review} view={view} size="mobile" />
            <button type="button" className={MOBILE_HEADER_BUTTON_CLASS} aria-label={t('walkthrough.action.next')} onClick={() => review.step(1)}>
              <Icon name="arrow-right-s" className="size-5" />
            </button>
          </>
        ) : view || review.blocked || review.showStages ? (
          <button
            type="button"
            className={MOBILE_HEADER_BUTTON_CLASS}
            aria-label={t('walkthrough.options.moreAria')}
            aria-haspopup="dialog"
            onClick={() => setOptionsOpen(true)}
          >
            <Icon name="more" className="size-5" />
          </button>
        ) : null}
      </header>

      <WalkthroughBanners review={review} view={view} />

      <div className="flex min-h-0 flex-1 flex-col">
        {review.blocked ? (
          <WalkthroughBlocker
            reason={review.blocked.reason}
            model={review.blocked.model}
            requiredChars={review.blocked.requiredChars}
            availableChars={review.blocked.availableChars}
            onRetry={review.retry}
          />
        ) : review.showStages ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
            <WalkthroughStages progress={review.stageProgress} />
          </div>
        ) : view && reading ? (
          <WalkthroughStream
            view={view}
            activeStopId={review.activeStopId}
            scrollToStopId={review.scrollToStopId}
            onActiveStopChange={review.handleActiveStopChange}
            onScrollHandled={review.clearScrollRequest}
            renderSideBySide={false}
            wrapLines
            commentOrigin={commentOrigin}
          />
        ) : view ? (
          <WalkthroughToc
            view={view}
            activeStopId={review.activeStopId}
            visitedStopIds={review.visitedStopIds}
            onSelectStop={openStop}
          />
        ) : (
          <WalkthroughEmptyState review={review} size="mobile" />
        )}
      </div>

      <MobileOverlayPanel open={optionsOpen} onClose={() => setOptionsOpen(false)} title={t('walkthrough.options.title')}>
        <WalkthroughOptions review={review} hasView={view !== null} size="mobile" onActed={() => setOptionsOpen(false)} />
      </MobileOverlayPanel>
    </div>
  );
};
