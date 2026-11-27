import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/icon/Icon';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { ChangedPathLabel } from '@/components/views/git/ChangedPathLabel';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { groupHunksByFile, summarizeHunkFiles } from '@/lib/walkthrough/model';
import type { WalkthroughStopView, WalkthroughView } from '@/lib/walkthrough/model';
import type { WalkthroughHunk, WalkthroughObservationKind, WalkthroughStopImportance } from '@/lib/walkthrough/types';
import type { DiffCommentOrigin } from '@/lib/diffCommentOrigin';
import { useWholeFileComment, WholeFileCommentButton } from '@/components/comments';
import { FileReviewedButton } from '@/components/views/FileReviewedButton';
import { cn } from '@/lib/utils';
import { WalkthroughHunkRun } from './WalkthroughHunkRun';
import { findRunKey, UNCOVERED_STOP_ID } from './walkthroughFind';
import { stopElementId } from './stopElementId';
import type { WalkthroughFindRevealRequest } from './useWalkthroughFind';
import type { DiffFindWordRequest, PierreDiffViewerHandle } from '@/components/views/PierreDiffViewer';

interface WalkthroughStreamProps {
  view: WalkthroughView;
  activeStopId: string | null;
  scrollToStopId: string | null;
  onActiveStopChange: (stopId: string) => void;
  onScrollHandled: () => void;
  renderSideBySide: boolean;
  wrapLines: boolean;
  commentOrigin?: DiffCommentOrigin;
  summary?: string;
  revealRequest?: WalkthroughFindRevealRequest | null;
  reviewedPaths?: ReadonlySet<string>;
  onToggleFileReviewed?: (path: string) => void;
  collapsedStopIds?: ReadonlySet<string>;
  onToggleStopCollapsed?: (stopId: string) => void;
  onExpandStop?: (stopId: string) => void;
  registerFindViewerRef?: (runKey: string, handle: PierreDiffViewerHandle | null) => void;
  onFindWordRequest?: (runKey: string, request: DiffFindWordRequest) => void;
}

const JUMP_SETTLE_MS = 1200;

const IMPORTANCE_CLASS: Record<WalkthroughStopImportance, string> = {
  critical: 'oc-tile-inset font-medium text-foreground',
  normal: 'oc-tile-inset text-muted-foreground',
  context: 'oc-tile-inset text-muted-foreground',
};

const OBSERVATION_LABEL_KEY = {
  decision: 'walkthrough.observation.decision',
  cost: 'walkthrough.observation.cost',
  limitation: 'walkthrough.observation.limitation',
  asymmetry: 'walkthrough.observation.asymmetry',
  unproven: 'walkthrough.observation.unproven',
} as const satisfies Record<WalkthroughObservationKind, I18nKey>;

const OBSERVATION_HINT_KEY = {
  decision: 'walkthrough.observation.decisionHint',
  cost: 'walkthrough.observation.costHint',
  limitation: 'walkthrough.observation.limitationHint',
  asymmetry: 'walkthrough.observation.asymmetryHint',
  unproven: 'walkthrough.observation.unprovenHint',
} as const satisfies Record<WalkthroughObservationKind, I18nKey>;

const StopHeader = ({
  stopView,
  isCollapsed,
  onToggleCollapse,
  fileCount,
  reviewedFileCount,
}: {
  stopView: WalkthroughStopView;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  fileCount: number;
  reviewedFileCount: number;
}) => {
  const { t } = useI18n();
  const { stop } = stopView;
  const allReviewed = fileCount > 0 && reviewedFileCount === fileCount;

  return (
    <header className={cn('flex flex-col gap-2 px-4 pt-4', isCollapsed ? 'pb-4' : 'pb-3')}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed
            ? t('walkthrough.stop.expandAria', { title: stop.title })
            : t('walkthrough.stop.collapseAria', { title: stop.title })}
          className="group/step flex min-w-0 flex-1 items-center gap-2 rounded text-start text-foreground"
        >
          <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground group-hover/step:text-foreground">
            <Icon name={isCollapsed ? 'arrow-right-s' : 'arrow-down-s'} className="size-4" />
          </span>
          <span
            className={cn(
              'typography-micro flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 tabular-nums',
              allReviewed
                ? 'bg-status-success/15 text-status-success'
                : 'oc-tile-inset text-muted-foreground',
            )}
          >
            {allReviewed ? <Icon name="check" className="size-3" /> : stopView.position}
          </span>
          <h3 className={cn('typography-ui-header min-w-0 truncate font-semibold', allReviewed ? 'text-muted-foreground' : 'text-foreground')}>
            {stop.title}
          </h3>
        </button>
        {stop.importance !== 'normal' && (
          <Tooltip>
            <TooltipTrigger
              className={cn('typography-micro flex h-5 shrink-0 items-center whitespace-nowrap rounded px-1.5 leading-none', IMPORTANCE_CLASS[stop.importance])}
            >
              {stop.importance === 'critical'
                ? t('walkthrough.importance.critical')
                : t('walkthrough.importance.context')}
            </TooltipTrigger>
            <TooltipContent className="max-w-64">
              <p className="typography-micro leading-tight">
                {stop.importance === 'critical'
                  ? t('walkthrough.importance.criticalHint')
                  : t('walkthrough.importance.contextHint')}
              </p>
            </TooltipContent>
          </Tooltip>
        )}
        {fileCount > 0 && (isCollapsed || reviewedFileCount > 0) && (
          <span className="typography-micro flex shrink-0 items-center gap-1 tabular-nums text-muted-foreground">
            <Icon
              name={reviewedFileCount > 0 ? 'checkbox-circle' : 'file-text'}
              className={cn('size-3 shrink-0', reviewedFileCount > 0 && 'text-[var(--status-success)]')}
            />
            {reviewedFileCount > 0 ? `${reviewedFileCount}/${fileCount}` : fileCount}
          </span>
        )}
      </div>
      {!isCollapsed && (
        <>
          <p className="typography-ui-label text-muted-foreground">{stop.prose}</p>
          {stop.observations && stop.observations.length > 0 && (
            <ul className="oc-tile flex flex-col gap-1.5 rounded-lg px-3 py-2">
              {stop.observations.map((observation) => (
                <li key={`${observation.kind}:${observation.note}`} className="typography-ui-label text-foreground">
                  <Tooltip>
                    <TooltipTrigger className="oc-tile-inset typography-micro me-1.5 inline-flex h-5 items-center whitespace-nowrap rounded px-1.5 align-[0.1em] leading-none text-muted-foreground">
                      {t(OBSERVATION_LABEL_KEY[observation.kind])}
                    </TooltipTrigger>
                    <TooltipContent className="max-w-64">
                      <p className="typography-micro leading-tight">{t(OBSERVATION_HINT_KEY[observation.kind])}</p>
                    </TooltipContent>
                  </Tooltip>
                  {observation.note}
                </li>
              ))}
            </ul>
          )}
          {stopView.isStale && (
            <p className="typography-meta flex items-center gap-1.5 text-status-warning">
              <Icon name="error-warning" className="size-3.5 shrink-0" />
              {stopView.hunks.length === 0
                ? t('walkthrough.stop.staleAll')
                : t('walkthrough.stop.stalePartial', { count: stopView.missingHunkIds.length })}
            </p>
          )}
        </>
      )}
    </header>
  );
};

const FileHeader = ({
  path,
  commentOrigin,
  isExpanded,
  onToggleExpanded,
  isReviewed,
  onToggleReviewed,
}: {
  path: string;
  commentOrigin?: DiffCommentOrigin;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  isReviewed: boolean;
  onToggleReviewed?: () => void;
}) => {
  const wholeFileComment = useWholeFileComment({ fileLabel: path, origin: commentOrigin });
  return (
    <>
      <div
        className={cn(
          isExpanded
            ? 'sticky top-0 z-10 border-b border-[var(--interactive-border)]/35 bg-[var(--surface-elevated)]/90 backdrop-blur-md supports-[backdrop-filter]:bg-[var(--surface-elevated)]/80'
            : 'relative border-b border-[var(--interactive-border)]/20 bg-transparent',
        )}
      >
        <div
          role="button"
          tabIndex={0}
          aria-expanded={isExpanded}
          onClick={onToggleExpanded}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onToggleExpanded();
            }
          }}
          className={cn(
            'group/file flex cursor-pointer items-center gap-1.5 px-4 py-1.5 transition-colors',
            'hover:bg-[var(--interactive-hover)]/50',
            isReviewed ? 'text-muted-foreground' : 'text-foreground',
          )}
        >
          <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground group-hover/file:text-foreground">
            <Icon name={isExpanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-4" />
          </span>
          <FileTypeIcon filePath={path} className="size-3.5 shrink-0" />
          <ChangedPathLabel
            path={path}
            className={cn('typography-meta min-w-0 flex-1 font-mono', isReviewed && 'text-muted-foreground')}
          />
          <WholeFileCommentButton
            onClick={wholeFileComment.toggle}
            active={wholeFileComment.isOpen}
          />
          {onToggleReviewed && (
            <FileReviewedButton
              reviewed={isReviewed}
              onToggle={onToggleReviewed}
            />
          )}
        </div>
        {wholeFileComment.editor}
      </div>
      {wholeFileComment.cards}
    </>
  );
};

interface FileExpansionOverride {
  path: string;
  expanded: boolean;
}

const HunkRuns = ({
  stopId,
  hunks,
  renderSideBySide,
  wrapLines,
  commentOrigin,
  reviewedPaths,
  fileExpansionOverrides,
  onToggleFileExpanded,
  onToggleFileReviewed,
  registerFindViewerRef,
  onFindWordRequest,
}: {
  stopId: string;
  hunks: WalkthroughHunk[];
  renderSideBySide: boolean;
  wrapLines: boolean;
  commentOrigin?: DiffCommentOrigin;
  reviewedPaths?: ReadonlySet<string>;
  fileExpansionOverrides: ReadonlyMap<string, FileExpansionOverride>;
  onToggleFileExpanded: (runKey: string, path: string, nextExpanded: boolean) => void;
  onToggleFileReviewed?: (path: string) => void;
  registerFindViewerRef?: (runKey: string, handle: PierreDiffViewerHandle | null) => void;
  onFindWordRequest?: (runKey: string, request: DiffFindWordRequest) => void;
}) => {
  const runs = useMemo(() => groupHunksByFile(hunks), [hunks]);

  return (
    <>
      {runs.map((run, index) => {
        const runKey = findRunKey(stopId, index, run.hunks);
        const isReviewed = reviewedPaths?.has(run.path) ?? false;
        const isExpanded = fileExpansionOverrides.get(runKey)?.expanded ?? !isReviewed;
        return (
          <div key={`${run.path}-${index}`}>
            <FileHeader
              path={run.path}
              commentOrigin={commentOrigin}
              isExpanded={isExpanded}
              onToggleExpanded={() => onToggleFileExpanded(runKey, run.path, !isExpanded)}
              isReviewed={isReviewed}
              onToggleReviewed={onToggleFileReviewed ? () => onToggleFileReviewed(run.path) : undefined}
            />
            {isExpanded && (
              <WalkthroughHunkRun
                path={run.path}
                hunks={run.hunks}
                renderSideBySide={renderSideBySide}
                wrapLines={wrapLines}
                commentOrigin={commentOrigin}
                runKey={runKey}
                registerFindViewerRef={registerFindViewerRef}
                onFindWordRequest={onFindWordRequest}
              />
            )}
          </div>
        );
      })}
    </>
  );
};

export const WalkthroughStream = memo(function WalkthroughStream({
  view,
  activeStopId,
  scrollToStopId,
  onActiveStopChange,
  onScrollHandled,
  renderSideBySide,
  wrapLines,
  commentOrigin,
  summary,
  revealRequest,
  reviewedPaths,
  onToggleFileReviewed,
  collapsedStopIds: controlledCollapsedStopIds,
  onToggleStopCollapsed,
  onExpandStop,
  registerFindViewerRef,
  onFindWordRequest,
}: WalkthroughStreamProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLElement | null>(null);
  const [uncoveredOpen, setUncoveredOpen] = useState(false);
  const [localCollapseState, setLocalCollapseState] = useState<{
    walkthrough: WalkthroughView['walkthrough'];
    stopIds: Set<string>;
    fileOverrides: Map<string, FileExpansionOverride>;
  }>(() => ({
    walkthrough: view.walkthrough,
    stopIds: new Set(),
    fileOverrides: new Map(),
  }));

  const localCollapsedStopIds = localCollapseState.walkthrough === view.walkthrough
    ? localCollapseState.stopIds
    : new Set<string>();
  const fileExpansionOverrides = localCollapseState.walkthrough === view.walkthrough
    ? localCollapseState.fileOverrides
    : new Map<string, FileExpansionOverride>();

  const collapsedStopIds = controlledCollapsedStopIds ?? localCollapsedStopIds;
  const handleToggleStopCollapsed = useCallback((stopId: string) => {
    if (onToggleStopCollapsed) {
      onToggleStopCollapsed(stopId);
      return;
    }
    setLocalCollapseState((previous) => {
      const same = previous.walkthrough === view.walkthrough;
      const nextStops = new Set(same ? previous.stopIds : undefined);
      if (nextStops.has(stopId)) nextStops.delete(stopId);
      else nextStops.add(stopId);
      return {
        walkthrough: view.walkthrough,
        stopIds: nextStops,
        fileOverrides: same ? previous.fileOverrides : new Map(),
      };
    });
  }, [onToggleStopCollapsed, view.walkthrough]);

  const handleExpandStop = useCallback((stopId: string) => {
    if (onExpandStop) {
      onExpandStop(stopId);
      return;
    }
    setLocalCollapseState((previous) => {
      const same = previous.walkthrough === view.walkthrough;
      if (!same || !previous.stopIds.has(stopId)) return previous;
      const nextStops = new Set(previous.stopIds);
      nextStops.delete(stopId);
      return { ...previous, stopIds: nextStops };
    });
  }, [onExpandStop, view.walkthrough]);

  const handleToggleFileExpanded = useCallback((runKey: string, path: string, nextExpanded: boolean) => {
    setLocalCollapseState((previous) => {
      const same = previous.walkthrough === view.walkthrough;
      const nextOverrides = new Map(same ? previous.fileOverrides : undefined);
      nextOverrides.set(runKey, { path, expanded: nextExpanded });
      return {
        walkthrough: view.walkthrough,
        stopIds: same ? previous.stopIds : new Set(),
        fileOverrides: nextOverrides,
      };
    });
  }, [view.walkthrough]);

  const handleToggleFileReviewed = useCallback((path: string) => {
    setLocalCollapseState((previous) => {
      if (previous.walkthrough !== view.walkthrough) return previous;
      let changed = false;
      const nextOverrides = new Map<string, FileExpansionOverride>();
      for (const [key, value] of previous.fileOverrides) {
        if (value.path === path) {
          changed = true;
          continue;
        }
        nextOverrides.set(key, value);
      }
      return changed ? { ...previous, fileOverrides: nextOverrides } : previous;
    });
    onToggleFileReviewed?.(path);
  }, [onToggleFileReviewed, view.walkthrough]);

  const navigatingRef = useRef<string | null>(null);
  const releaseJumpRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!revealRequest) return;
    if (revealRequest.stopId === UNCOVERED_STOP_ID) {
      setUncoveredOpen(true);
    } else {
      handleExpandStop(revealRequest.stopId);
    }
    setLocalCollapseState((previous) => {
      const same = previous.walkthrough === view.walkthrough;
      const baseOverrides = same ? previous.fileOverrides : new Map<string, FileExpansionOverride>();
      const existing = baseOverrides.get(revealRequest.runKey);
      if (existing?.expanded) return previous;
      const nextOverrides = new Map(baseOverrides);
      nextOverrides.set(revealRequest.runKey, { path: revealRequest.path, expanded: true });
      return {
        walkthrough: view.walkthrough,
        stopIds: same ? previous.stopIds : new Set(),
        fileOverrides: nextOverrides,
      };
    });
  }, [handleExpandStop, revealRequest, view.walkthrough]);

  useEffect(() => () => releaseJumpRef.current?.(), []);

  useEffect(() => {
    if (!scrollToStopId) return;
    handleExpandStop(scrollToStopId);
    const element = document.getElementById(stopElementId(scrollToStopId));
    const root = scrollRef.current;
    if (element && root) {
      releaseJumpRef.current?.();
      navigatingRef.current = scrollToStopId;
      element.scrollIntoView({ behavior: 'auto', block: 'start' });

      const hold = new ResizeObserver(() => element.scrollIntoView({ behavior: 'auto', block: 'start' }));
      for (const section of root.children) hold.observe(section);
      const userEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
      const release = () => {
        hold.disconnect();
        for (const type of userEvents) root.removeEventListener(type, release);
        window.clearTimeout(timer);
        if (navigatingRef.current === scrollToStopId) navigatingRef.current = null;
        if (releaseJumpRef.current === release) releaseJumpRef.current = null;
      };
      for (const type of userEvents) root.addEventListener(type, release, { passive: true });
      const timer = window.setTimeout(release, JUMP_SETTLE_MS);
      releaseJumpRef.current = release;
    }
    onScrollHandled();
  }, [handleExpandStop, scrollToStopId, onScrollHandled]);

  const handleIntersection = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      const stopId = visible.target.getAttribute('data-stop-id');
      if (!stopId) return;

      if (navigatingRef.current) return;

      onActiveStopChange(stopId);
    },
    [onActiveStopChange]
  );

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;

    const observer = new IntersectionObserver(handleIntersection, {
      root,
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
  const routineNotes = useMemo(
    () => new Map((view.walkthrough.routine ?? []).map((entry) => [entry.path, entry.note])),
    [view.walkthrough.routine],
  );

  return (
    <ScrollableOverlay
      ref={scrollRef}
      outerClassName="min-h-0 flex-1"
      data-diff-virtual-root
      data-diff-virtual-content
      disableHorizontal
    >
      {summary && (
        <p className="typography-ui-label px-4 pt-4 text-muted-foreground">{summary}</p>
      )}
      {view.stops.map((stopView) => {
        const isCollapsed = collapsedStopIds.has(stopView.stop.id);
        const stopFiles = summarizeHunkFiles(stopView.hunks);
        const reviewedFileCount = reviewedPaths
          ? stopFiles.reduce((count, file) => count + (reviewedPaths.has(file.path) ? 1 : 0), 0)
          : 0;
        return (
          <section
            key={stopView.stop.id}
            id={stopElementId(stopView.stop.id)}
            data-stop-id={stopView.stop.id}
            className={cn(
              'border-b border-edge',
              activeStopId === stopView.stop.id && 'bg-interactive-selection/5'
            )}
          >
            <StopHeader
              stopView={stopView}
              isCollapsed={isCollapsed}
              onToggleCollapse={() => handleToggleStopCollapsed(stopView.stop.id)}
              fileCount={stopFiles.length}
              reviewedFileCount={reviewedFileCount}
            />
            {!isCollapsed && (
              stopView.hunks.length > 0 ? (
                <HunkRuns
                  stopId={stopView.stop.id}
                  hunks={stopView.hunks}
                  renderSideBySide={renderSideBySide}
                  wrapLines={wrapLines}
                  commentOrigin={commentOrigin}
                  reviewedPaths={reviewedPaths}
                  fileExpansionOverrides={fileExpansionOverrides}
                  onToggleFileExpanded={handleToggleFileExpanded}
                  onToggleFileReviewed={onToggleFileReviewed ? handleToggleFileReviewed : undefined}
                  registerFindViewerRef={registerFindViewerRef}
                  onFindWordRequest={onFindWordRequest}
                />
              ) : (
                <p className="typography-meta px-4 pb-4 text-muted-foreground">
                  {t('walkthrough.stop.noCode')}
                </p>
              )
            )}
          </section>
        );
      })}

      {view.uncoveredHunks.length > 0 && (
        <section className="border-b border-edge">
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
            <p className="typography-meta px-4 pb-3 ps-10 text-muted-foreground">
              {t('walkthrough.uncovered.description')}
            </p>
          )}
          {uncoveredOpen
            && uncoveredRuns.map((run, index) => {
              const runKey = findRunKey(UNCOVERED_STOP_ID, index, run.hunks);
              const isReviewed = reviewedPaths?.has(run.path) ?? false;
              const isExpanded = fileExpansionOverrides.get(runKey)?.expanded ?? !isReviewed;
              return (
                <div key={`${run.path}-${index}`}>
                  <FileHeader
                    path={run.path}
                    commentOrigin={commentOrigin}
                    isExpanded={isExpanded}
                    onToggleExpanded={() => handleToggleFileExpanded(runKey, run.path, !isExpanded)}
                    isReviewed={isReviewed}
                    onToggleReviewed={onToggleFileReviewed ? () => handleToggleFileReviewed(run.path) : undefined}
                  />
                  {isExpanded && (
                    <>
                      {routineNotes.has(run.path) && uncoveredRuns.findIndex((other) => other.path === run.path) === index && (
                        <p className="typography-meta px-4 py-1.5 text-muted-foreground">{routineNotes.get(run.path)}</p>
                      )}
                      <WalkthroughHunkRun
                        path={run.path}
                        hunks={run.hunks}
                        renderSideBySide={renderSideBySide}
                        wrapLines={wrapLines}
                        commentOrigin={commentOrigin}
                        runKey={runKey}
                        registerFindViewerRef={registerFindViewerRef}
                        onFindWordRequest={onFindWordRequest}
                      />
                    </>
                  )}
                </div>
              );
            })}
        </section>
      )}
    </ScrollableOverlay>
  );
});
