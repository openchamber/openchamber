import React from 'react';

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

const HEADER_BUTTON_CLASS = 'flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none';

/**
 * The walkthrough of what the phone's Changes shows, pushed over its list the
 * way a file's diff is. It opens on the contents (what the change is about and
 * its steps); a step opens the stream there, with the step list and arrows in
 * the header. The model, the language and Regenerate wait in the options
 * sheet, except before the first walkthrough, when the empty state offers them.
 */
export const MobileWalkthroughScreen: React.FC<{
  directory: string;
  target: WalkthroughTarget;
  /** What is being walked through, such as "Commit · e1d7e102". */
  subtitle: string;
  /** Moves when the subject's content moves, so the walkthrough reads again. */
  revision: string;
  visible: boolean;
  onBack: () => void;
}> = ({ directory, target, subtitle, revision, visible, onBack }) => {
  const { t } = useI18n();
  const review = useWalkthroughReview({ directory, target, visible, needsSourceSelection: false, revision });
  const { view } = review;
  const commentOrigin = React.useMemo(() => diffCommentOriginFromTarget(target), [target]);
  const [optionsOpen, setOptionsOpen] = React.useState(false);
  // The walkthrough being read, by when it was generated: a new one starts
  // again from its contents.
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
      <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-1.5 border-b border-border/70 px-3 text-foreground">
        <button type="button" className={HEADER_BUTTON_CLASS} aria-label={t('header.actions.backAria')} onClick={goBack}>
          <Icon name="arrow-left" className="size-5" />
        </button>
        <div className="min-w-0 flex-1 px-1">
          <h2 className="truncate typography-ui-header text-foreground">{t('contextPanel.mode.walkthrough')}</h2>
          <p className="truncate typography-meta text-muted-foreground">{subtitle}</p>
        </div>
        {reading && view ? (
          <>
            <button type="button" className={HEADER_BUTTON_CLASS} aria-label={t('walkthrough.action.previous')} onClick={() => review.step(-1)}>
              <Icon name="arrow-right-s" className="size-5 rotate-180" />
            </button>
            <WalkthroughStepMenu review={review} view={view} size="mobile" />
            <button type="button" className={HEADER_BUTTON_CLASS} aria-label={t('walkthrough.action.next')} onClick={() => review.step(1)}>
              <Icon name="arrow-right-s" className="size-5" />
            </button>
          </>
        ) : (
          <button
            type="button"
            className={HEADER_BUTTON_CLASS}
            aria-label={t('walkthrough.options.moreAria')}
            aria-haspopup="dialog"
            onClick={() => setOptionsOpen(true)}
          >
            <Icon name="more" className="size-5" />
          </button>
        )}
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
        <div className="px-2 py-2">
          <WalkthroughOptions review={review} hasView={view !== null} size="mobile" onActed={() => setOptionsOpen(false)} />
        </div>
      </MobileOverlayPanel>
    </div>
  );
};
