import { memo, useEffect, useRef } from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
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
  onSelectStop: (stopId: string) => void;
  /** Column beside the stream at this width; omitted, the contents are a page of their own (the phone). */
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
  onSelect,
  activeRef,
  page,
}: {
  stopView: WalkthroughStopView;
  isActive: boolean;
  isVisited: boolean;
  onSelect: () => void;
  activeRef: React.Ref<HTMLButtonElement>;
  page: boolean;
}) => {
  const { t } = useI18n();
  const files = summarizeHunkFiles(stopView.hunks);

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
              // A pill rather than a fixed circle: two-digit steps were cramped
              // and visibly off-centre in a square.
              'typography-micro flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 tabular-nums',
              isActive
                ? 'bg-interactive-selection-foreground/20'
                : isVisited
                  ? 'bg-status-success/15 text-status-success'
                  : 'oc-tile-inset text-muted-foreground'
            )}
          >
            {isVisited && !isActive ? <Icon name="check" className="size-2.5" /> : stopView.position}
          </span>
          <span className={cn('truncate font-medium', page ? 'typography-ui-label' : 'typography-meta')}>{stopView.stop.title}</span>
          {stopView.isStale && (
            <Icon
              name="error-warning"
              className="size-3 shrink-0 text-status-warning"
              aria-label={t('walkthrough.stop.staleShort')}
            />
          )}
        </span>
        {/* One line: the first file's name says where the step lives, and a
            full path cut from its end showed only the shared folders. */}
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
  onSelectStop,
  width,
}: WalkthroughTocProps) {
  const { t } = useI18n();
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const page = width === undefined;

  // Scrolling the stream moves the active step, and past a certain point the
  // highlighted row leaves the contents column entirely — the reader loses
  // their place in the very thing meant to hold it. `nearest` keeps the move
  // minimal, so clicking a row that is already visible does not jolt the list.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeStopId]);

  return (
    <nav
      className={cn('flex flex-col overflow-y-auto', page ? 'min-h-0 flex-1 px-3 py-3' : 'shrink-0 border-e border-border/60 p-2')}
      style={page ? undefined : { width }}
    >
      {view.walkthrough.focus && (
        <p className={cn('px-2 pb-3 pt-1 text-muted-foreground', page ? 'typography-ui-label' : 'typography-meta')}>{view.walkthrough.focus}</p>
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
    </nav>
  );
});
