import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/icon/Icon';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { groupHunksByFile } from '@/lib/walkthrough/model';
import type { WalkthroughStopView, WalkthroughView } from '@/lib/walkthrough/model';
import type { WalkthroughHunk, WalkthroughStopImportance } from '@/lib/walkthrough/types';
import { cn } from '@/lib/utils';
import { WalkthroughHunkRun } from './WalkthroughHunkRun';
import { stopElementId } from './stopElementId';

interface WalkthroughStreamProps {
  view: WalkthroughView;
  activeStopId: string | null;
  scrollToStopId: string | null;
  onActiveStopChange: (stopId: string) => void;
  onScrollHandled: () => void;
  renderSideBySide: boolean;
  wrapLines: boolean;
}

const IMPORTANCE_CLASS: Record<WalkthroughStopImportance, string> = {
  critical: 'bg-status-error/10 text-status-error',
  normal: 'bg-surface-muted text-muted-foreground',
  context: 'bg-surface-muted text-muted-foreground',
};

const StopHeader = ({ stopView }: { stopView: WalkthroughStopView }) => {
  const { t } = useI18n();
  const { stop } = stopView;

  return (
    <header className="flex flex-col gap-2 px-4 pt-5 pb-3">
      <div className="flex items-center gap-2">
        <span className="typography-micro flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-surface-muted px-1.5 tabular-nums text-muted-foreground">
          {stopView.position}
        </span>
        <h3 className="typography-ui-label font-semibold text-foreground">{stop.title}</h3>
        {/* Same height as the step badge, so a row with an importance pill is
            exactly as tall as one without: vertical padding on a smaller type
            size was pushing past the tallest element in the row. */}
        {stop.importance !== 'normal' && (
          <span className={cn('typography-micro flex h-5 items-center rounded px-1.5 leading-none', IMPORTANCE_CLASS[stop.importance])}>
            {stop.importance === 'critical'
              ? t('walkthrough.importance.critical')
              : t('walkthrough.importance.context')}
          </span>
        )}
      </div>
      <p className="typography-body text-muted-foreground">{stop.prose}</p>
      {stopView.isStale && (
        <p className="typography-meta flex items-center gap-1.5 text-status-warning">
          <Icon name="error-warning" className="size-3.5 shrink-0" />
          {stopView.hunks.length === 0
            ? t('walkthrough.stop.staleAll')
            : t('walkthrough.stop.stalePartial', { count: stopView.missingHunkIds.length })}
        </p>
      )}
    </header>
  );
};

/**
 * Sticky so the file you are reading stays named while you scroll through its
 * hunks — the path is the main orientation cue in a long stream, and as a plain
 * caption it was easy to scroll straight past.
 */
const FileHeader = ({ path }: { path: string }) => (
  <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-[var(--interactive-border)]/35 bg-[var(--surface-elevated)]/90 px-4 py-1.5 backdrop-blur-md supports-[backdrop-filter]:bg-[var(--surface-elevated)]/80">
    <FileTypeIcon filePath={path} className="size-3.5 shrink-0" />
    <span className="typography-meta truncate font-mono text-foreground">{path}</span>
  </div>
);

const HunkRuns = ({
  hunks,
  renderSideBySide,
  wrapLines,
}: {
  hunks: WalkthroughHunk[];
  renderSideBySide: boolean;
  wrapLines: boolean;
}) => {
  const runs = useMemo(() => groupHunksByFile(hunks), [hunks]);

  return (
    <>
      {runs.map((run, index) => (
        <div key={`${run.path}-${index}`}>
          <FileHeader path={run.path} />
          <WalkthroughHunkRun
            path={run.path}
            hunks={run.hunks}
            renderSideBySide={renderSideBySide}
            wrapLines={wrapLines}
          />
        </div>
      ))}
    </>
  );
};

/**
 * Everything the walkthrough covers, plus everything it does not, in one
 * continuous scroll: a stop's explanation sits directly above the code it
 * explains.
 */
export const WalkthroughStream = memo(function WalkthroughStream({
  view,
  activeStopId,
  scrollToStopId,
  onActiveStopChange,
  onScrollHandled,
  renderSideBySide,
  wrapLines,
}: WalkthroughStreamProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [uncoveredOpen, setUncoveredOpen] = useState(false);

  // Set while a click-driven jump is in flight. Without it the observer reports
  // every stop the viewport passes over on the way to the target and the
  // highlight ends up on whichever one happened to be reported last — the
  // sidebar showing step 5 while the stream shows step 6.
  const navigatingRef = useRef<string | null>(null);
  const navigationTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (navigationTimerRef.current !== null) window.clearTimeout(navigationTimerRef.current);
  }, []);

  // Scrolling is driven by the DOM rather than a virtualizer: only the visible
  // stops mount their diff viewers, and each stop is its own element, so there
  // is nothing to translate between index space and pixel space.
  useEffect(() => {
    if (!scrollToStopId) return;
    const element = document.getElementById(stopElementId(scrollToStopId));
    if (element) {
      navigatingRef.current = scrollToStopId;
      // Instant, not smooth: picking a step is a jump to a known destination,
      // and a long animation only creates a window for the highlight to drift
      // through everything in between.
      element.scrollIntoView({ behavior: 'auto', block: 'start' });

      // The observer fires asynchronously after the jump, and an element that
      // was already in view may not fire at all — so the mute is released on a
      // timer as well as on arrival.
      if (navigationTimerRef.current !== null) window.clearTimeout(navigationTimerRef.current);
      navigationTimerRef.current = window.setTimeout(() => {
        navigatingRef.current = null;
        navigationTimerRef.current = null;
      }, 250);
    }
    onScrollHandled();
  }, [scrollToStopId, onScrollHandled]);

  const handleIntersection = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      const stopId = visible.target.getAttribute('data-stop-id');
      if (!stopId) return;

      const navigatingTo = navigatingRef.current;
      if (navigatingTo) {
        // Arrived: hand control back to free scrolling.
        if (stopId === navigatingTo) navigatingRef.current = null;
        return;
      }

      onActiveStopChange(stopId);
    },
    [onActiveStopChange]
  );

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;

    const observer = new IntersectionObserver(handleIntersection, {
      root,
      // Only count a stop as active once its header reaches the upper band of
      // the viewport, so scrolling through a long diff does not flicker the
      // active step back and forth.
      rootMargin: '0px 0px -70% 0px',
      threshold: 0,
    });

    for (const stopView of view.stops) {
      const element = document.getElementById(stopElementId(stopView.stop.id));
      if (element) observer.observe(element);
    }

    return () => observer.disconnect();
  }, [handleIntersection, view.stops]);

  const uncoveredRuns = useMemo(() => groupHunksByFile(view.uncoveredHunks), [view.uncoveredHunks]);

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto"
      data-diff-virtual-root
      data-diff-virtual-content
    >
      {view.stops.map((stopView) => (
        <section
          key={stopView.stop.id}
          id={stopElementId(stopView.stop.id)}
          data-stop-id={stopView.stop.id}
          className={cn(
            'border-b border-border/60',
            activeStopId === stopView.stop.id && 'bg-interactive-selection/5'
          )}
        >
          <StopHeader stopView={stopView} />
          {stopView.hunks.length > 0 ? (
            <HunkRuns
              hunks={stopView.hunks}
              renderSideBySide={renderSideBySide}
              wrapLines={wrapLines}
            />
          ) : (
            <p className="typography-meta px-4 pb-4 text-muted-foreground">
              {t('walkthrough.stop.noCode')}
            </p>
          )}
        </section>
      ))}

      {view.uncoveredHunks.length > 0 && (
        <section className="border-b border-border/60">
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full justify-start gap-2 px-4 py-3"
            onClick={() => setUncoveredOpen((open) => !open)}
            aria-expanded={uncoveredOpen}
          >
            <Icon name={uncoveredOpen ? 'arrow-down-s' : 'arrow-right-s'} className="size-4 shrink-0" />
            <span className="typography-ui-label text-muted-foreground">
              {t('walkthrough.uncovered.title', { count: view.uncoveredHunks.length })}
            </span>
          </Button>
          {!uncoveredOpen && (
            <p className="typography-meta px-4 pb-3 pl-10 text-muted-foreground">
              {t('walkthrough.uncovered.description')}
            </p>
          )}
          {uncoveredOpen
            && uncoveredRuns.map((run, index) => (
              <div key={`${run.path}-${index}`}>
                <FileHeader path={run.path} />
                <WalkthroughHunkRun
                  path={run.path}
                  hunks={run.hunks}
                  renderSideBySide={renderSideBySide}
                  wrapLines={wrapLines}
                />
              </div>
            ))}
        </section>
      )}
    </div>
  );
});
