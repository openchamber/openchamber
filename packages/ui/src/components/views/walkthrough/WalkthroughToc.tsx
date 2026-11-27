import { memo, useEffect, useRef } from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useI18n } from '@/lib/i18n';
import { summarizeHunkFiles } from '@/lib/walkthrough/model';
import { changedPathName } from '@/components/views/git/changesTree';
import type { WalkthroughStopView, WalkthroughView } from '@/lib/walkthrough/model';
import type { WalkthroughChapterIcon } from '@/lib/walkthrough/types';
import { cn } from '@/lib/utils';

interface WalkthroughTocProps {
  view: WalkthroughView;
  activeStopId: string | null;
  visitedStopIds: ReadonlySet<string>;
  reviewedPaths?: ReadonlySet<string>;
  totalFileCount?: number;
  onSelectStop: (stopId: string) => void;
  width?: number;
}

const CHAPTER_ICONS: Record<WalkthroughChapterIcon, IconName> = {
  bug: 'bug',
  wrench: 'tools',
  path: 'compass-3',
  flask: 'flask',
  doc: 'file-text',
  gear: 'settings-3',
};

const TocStop = ({
  stopView,
  isActive,
  isVisited,
  reviewedPaths,
  onSelect,
  activeRef,
  page,
}: {
  stopView: WalkthroughStopView;
  isActive: boolean;
  isVisited: boolean;
  reviewedPaths?: ReadonlySet<string>;
  onSelect: () => void;
  activeRef: React.Ref<HTMLButtonElement>;
  page: boolean;
}) => {
  const { t } = useI18n();
  const files = summarizeHunkFiles(stopView.hunks);
  const allReviewed = files.length > 0 && Boolean(reviewedPaths) && files.every((file) => reviewedPaths?.has(file.path));
  const done = allReviewed || isVisited;

  return (
    <li>
      <button
        ref={isActive ? activeRef : undefined}
        type="button"
        onClick={onSelect}
        aria-current={isActive ? 'step' : undefined}
        className={cn(
          'flex w-full flex-col gap-1 rounded px-2 text-start transition-colors',
          page ? 'min-h-11 justify-center py-2' : 'py-1.5',
          'hover:bg-interactive-hover',
          isActive && 'bg-interactive-selection text-interactive-selection-foreground'
        )}
      >
        <span className="flex items-center gap-2">
          <span
            className={cn(
              'typography-micro flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 tabular-nums',
              isActive
                ? 'bg-interactive-selection-foreground/20'
                : done
                  ? 'bg-status-success/15 text-status-success'
                  : 'oc-tile-inset text-muted-foreground'
            )}
          >
            {done && !isActive ? <Icon name="check" className="size-2.5" /> : stopView.position}
          </span>
          <span className={cn('truncate font-medium', page ? 'typography-ui-label' : 'typography-meta', allReviewed && !isActive && 'text-muted-foreground')}>
            {stopView.stop.title}
          </span>
          {stopView.isStale && (
            <Icon
              name="error-warning"
              className="size-3 shrink-0 text-status-warning"
              aria-label={t('walkthrough.stop.staleShort')}
            />
          )}
        </span>
        {files.length > 0 && (
          <span
            className={cn('flex min-w-0 items-baseline gap-1.5 ps-6 text-muted-foreground', page ? 'typography-meta' : 'typography-micro')}
            title={files.map((file) => file.path).join('\n')}
          >
            <span dir="ltr" className="min-w-0 truncate font-mono">{changedPathName(files[0].path)}</span>
            {files.length > 1 && (
              <span className="shrink-0"><span aria-hidden>· </span>{t('walkthrough.toc.moreFiles', { count: files.length - 1 })}</span>
            )}
          </span>
        )}
      </button>
    </li>
  );
};

export const WalkthroughToc = memo(function WalkthroughToc({
  view,
  activeStopId,
  visitedStopIds,
  reviewedPaths,
  totalFileCount = 0,
  onSelectStop,
  width,
}: WalkthroughTocProps) {
  const { t } = useI18n();
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const page = width === undefined;
  const reviewedCount = reviewedPaths?.size ?? 0;

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeStopId]);

  const contents = (
    <ScrollableOverlay
      as="nav"
      outerClassName="min-h-0 flex-1"
      className={cn('flex flex-col', page ? 'px-3 py-3' : 'p-2')}
      disableHorizontal
    >
      {view.walkthrough.focus && (
        <p className={cn('px-2 pb-3 pt-1 text-muted-foreground', page ? 'typography-ui-label' : 'typography-meta')}>{view.walkthrough.focus}</p>
      )}
      {reviewedCount > 0 && totalFileCount > 0 && (
        <p className="typography-micro flex items-center gap-1.5 px-2 pb-2.5 tabular-nums text-muted-foreground">
          <Icon name="checkbox-circle" className="size-3.5 shrink-0 text-[var(--status-success)]" />
          <span>{t('diffView.reviewed.progress', { reviewed: reviewedCount, total: totalFileCount })}</span>
        </p>
      )}
      {view.chapters.map(({ chapter, stops }) => (
        <section key={chapter.id} className="pb-3">
          <h4 className="typography-micro flex items-center gap-1.5 px-2 py-1 font-semibold uppercase tracking-wide text-muted-foreground">
            <Icon name={CHAPTER_ICONS[chapter.icon] ?? 'file-text'} className="size-3 shrink-0" />
            <span className="truncate">{chapter.title}</span>
          </h4>
          <ul className="flex flex-col gap-0.5">
            {stops.map((stopView) => (
              <TocStop
                key={stopView.stop.id}
                stopView={stopView}
                isActive={activeStopId === stopView.stop.id}
                isVisited={visitedStopIds.has(stopView.stop.id)}
                reviewedPaths={reviewedPaths}
                onSelect={() => onSelectStop(stopView.stop.id)}
                activeRef={activeRef}
                page={page}
              />
            ))}
          </ul>
        </section>
      ))}
      {view.uncoveredHunks.length > 0 && (
        <p className="typography-micro mt-auto px-2 pt-3 text-muted-foreground">
          {t('walkthrough.toc.uncovered', { count: view.uncoveredHunks.length })}
        </p>
      )}
    </ScrollableOverlay>
  );

  if (page) return contents;
  return (
    <div className="flex shrink-0 flex-col border-e border-edge" style={{ width }}>
      {contents}
    </div>
  );
});
