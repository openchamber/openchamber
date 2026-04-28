import React from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import { RiCloseLine } from '@remixicon/react';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';

export type SortableTabsStripItem = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  title?: string;
  closable?: boolean;
  closeLabel?: string;
};

type SortableTabsStripProps = {
  items: SortableTabsStripItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void;
  onReorder?: (activeId: string, overId: string) => void;
  layoutMode?: 'scrollable' | 'fit';
  variant?: 'default' | 'active-pill' | 'animated';
  activePillInsetClassName?: string;
  activePillButtonClassName?: string;
  inactiveTabsIconOnly?: boolean;
  animateActivePill?: boolean;
  activePillLowercase?: boolean;
  className?: string;
};

const restrictToXAxis: Modifier = ({ transform }) => ({
  ...transform,
  y: 0,
});

const SortableTabWrapper: React.FC<{ id: string; children: React.ReactNode; className?: string }> = ({ id, children, className }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  return (
    <div
      ref={setNodeRef}
      data-sortable-tab-id={id}
      style={{
        transform: DndCSS.Transform.toString(transform),
        transition,
      }}
      className={cn('h-full rounded-md', className, isDragging && 'opacity-50')}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
};

const StaticTabWrapper: React.FC<{ id: string; children: React.ReactNode; className?: string }> = ({ id, children, className }) => (
  <div className={cn('h-full', className)} data-sortable-tab-id={id}>{children}</div>
);

export const SortableTabsStrip: React.FC<SortableTabsStripProps> = ({
  items,
  activeId,
  onSelect,
  onClose,
  onReorder,
  layoutMode = 'scrollable',
  variant = 'default',
  activePillInsetClassName,
  activePillButtonClassName,
  inactiveTabsIconOnly = false,
  animateActivePill,
  activePillLowercase = true,
  className,
}) => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = React.useState<{ left: boolean; right: boolean }>({ left: false, right: false });
  const itemIDs = React.useMemo(() => items.map((item) => item.id), [items]);
  const isScrollable = layoutMode === 'scrollable';
  const isDefaultVariant = variant === 'default';
  const isActivePillVariant = variant === 'active-pill';
  const isAnimatedVariant = variant === 'animated';
  const usesActivePillIndicator = isActivePillVariant || isAnimatedVariant;
  const useUnderlineIndicator = isDefaultVariant;
  const usesIndicator = usesActivePillIndicator || useUnderlineIndicator;
  const useIntrinsicPillSizing = isActivePillVariant && isScrollable;
  const showPillTrackBackground = usesActivePillIndicator;
  const shouldAnimateActivePill = animateActivePill ?? isAnimatedVariant;
  const reorderEnabled = typeof onReorder === 'function';
  const Wrapper = reorderEnabled ? SortableTabWrapper : StaticTabWrapper;
  const tabRefs = React.useRef<Map<string, HTMLElement>>(new Map());
  const [pillRect, setPillRect] = React.useState<{ left: number; top: number; width: number; height: number } | null>(null);


  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const isSamePillRect = React.useCallback((
    a: { left: number; top: number; width: number; height: number } | null,
    b: { left: number; top: number; width: number; height: number } | null,
  ) => {
    if (!a || !b) {
      return a === b;
    }
    return Math.abs(a.left - b.left) < 0.5
      && Math.abs(a.top - b.top) < 0.5
      && Math.abs(a.width - b.width) < 0.5
      && Math.abs(a.height - b.height) < 0.5;
  }, []);

  const setTabRef = React.useCallback((id: string, element: HTMLElement | null) => {
    if (element) {
      tabRefs.current.set(id, element);
      return;
    }
    tabRefs.current.delete(id);
  }, []);

  const updateActivePillRect = React.useCallback(() => {
    if (!usesIndicator || !activeId) {
      setPillRect((prev) => (prev === null ? prev : null));
      return;
    }

    const container = scrollRef.current;
    const activeTab = tabRefs.current.get(activeId);
    if (!container || !activeTab) {
      setPillRect((prev) => (prev === null ? prev : null));
      return;
    }

    // Walk offsetParent chain to compute position relative to the scroll container.
    // Unlike getBoundingClientRect, offsetLeft/offsetTop are unaffected by CSS
    // transforms (e.g. dropdown entry scale animation), preventing pill mis-positioning
    // on first render.
    let left = 0;
    let top = 0;
    let el: HTMLElement | null = activeTab;
    while (el && el !== container) {
      left += el.offsetLeft;
      top += el.offsetTop;
      el = el.offsetParent as HTMLElement | null;
    }

    const nextRect = {
      left,
      top,
      width: activeTab.offsetWidth,
      height: activeTab.offsetHeight,
    };

    setPillRect((prev) => (isSamePillRect(prev, nextRect) ? prev : nextRect));
  }, [activeId, isSamePillRect, usesIndicator]);

  const updateOverflow = React.useCallback(() => {
    if (!isScrollable) {
      setOverflow({ left: false, right: false });
      return;
    }

    const element = scrollRef.current;
    if (!element) {
      setOverflow({ left: false, right: false });
      return;
    }

    setOverflow({
      left: element.scrollLeft > 2,
      right: element.scrollLeft + element.clientWidth < element.scrollWidth - 2,
    });
  }, [isScrollable]);

  React.useEffect(() => {
    if (!isScrollable) {
      setOverflow({ left: false, right: false });
      return;
    }

    const element = scrollRef.current;
    if (!element) {
      return;
    }

    updateOverflow();
    element.addEventListener('scroll', updateOverflow, { passive: true });
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(element);

    return () => {
      element.removeEventListener('scroll', updateOverflow);
      observer.disconnect();
    };
  }, [isScrollable, items.length, updateOverflow]);

  React.useEffect(() => {
    if (!usesIndicator) {
      setPillRect(null);
      return;
    }

    updateActivePillRect();

    const element = scrollRef.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver(updateActivePillRect);
    observer.observe(element);

    if (activeId) {
      const activeTab = tabRefs.current.get(activeId);
      if (activeTab) {
        observer.observe(activeTab);
      }
    }

    return () => {
      observer.disconnect();
    };
  }, [activeId, items.length, updateActivePillRect, usesIndicator]);

  React.useLayoutEffect(() => {
    updateActivePillRect();
  });



  React.useEffect(() => {
    if (!isScrollable || !activeId) {
      return;
    }

    const element = scrollRef.current;
    if (!element) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const escapedID = typeof window.CSS?.escape === 'function'
        ? window.CSS.escape(activeId)
        : activeId.replace(/"/g, '\\"');
      const target = element.querySelector<HTMLElement>(`[data-sortable-tab-id="${escapedID}"]`);
      if (!target) {
        return;
      }

      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      updateOverflow();
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeId, isScrollable, items.length, updateOverflow]);

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    if (!onReorder) {
      return;
    }

    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    onReorder(String(active.id), String(over.id));
  }, [onReorder]);

  const list = (
    <div className={cn('relative flex h-full min-w-0 flex-1', className)}>
      {isScrollable && overflow.left ? (
        <div
          className={cn(
            'pointer-events-none absolute inset-y-0 left-0 z-20 bg-gradient-to-r to-transparent',
            usesActivePillIndicator
              ? 'w-8 from-[var(--surface-background)]'
              : 'w-6 from-background'
          )}
        />
      ) : null}
      {isScrollable && overflow.right ? (
        <div
          className={cn(
            'pointer-events-none absolute inset-y-0 right-0 z-20 bg-gradient-to-l to-transparent',
            usesActivePillIndicator
              ? 'w-8 from-[var(--surface-background)]'
              : 'w-6 from-background'
          )}
        />
      ) : null}
      <div
        ref={scrollRef}
        className={cn(
          'relative flex h-full min-w-0 flex-1',
          usesActivePillIndicator ? 'items-center overflow-x-hidden overflow-y-hidden' : 'items-stretch',
          usesActivePillIndicator && '@container/pill-tabs',
          usesActivePillIndicator && 'pill-tabs__track',
          usesActivePillIndicator && (activePillInsetClassName ?? 'gap-0.5 py-0.5'),
          useUnderlineIndicator && 'items-center overflow-y-hidden',
          showPillTrackBackground && 'rounded-[10px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px] bg-[color-mix(in_srgb,var(--foreground)_2%,transparent)] p-0.5 gap-0.5',
          isScrollable
            ? 'overflow-x-auto scrollbar-none'
            : 'overflow-x-hidden',
        )}
        style={isScrollable ? { scrollbarWidth: 'none', msOverflowStyle: 'none' } : undefined}
        role="tablist"
        aria-label={t('sortableTabsStrip.aria.tabs')}
      >
        {usesActivePillIndicator && pillRect ? (
          <div
            className={cn(
              'pointer-events-none absolute left-0 top-0 z-0 rounded-[9px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px] bg-[var(--surface-elevated)]',
              'border border-border/60'
            )}
            style={{
              transform: `translate3d(${pillRect.left}px, ${pillRect.top}px, 0)`,
              width: `${pillRect.width}px`,
              height: `${pillRect.height}px`,
              transition: shouldAnimateActivePill
                ? 'transform 300ms cubic-bezier(0.65, 0, 0.35, 1), width 300ms cubic-bezier(0.65, 0, 0.35, 1), height 300ms cubic-bezier(0.65, 0, 0.35, 1)'
                : undefined,
            }}
          />
        ) : null}
        {useUnderlineIndicator && pillRect ? (
          <div
            className="pointer-events-none absolute left-0 -bottom-px z-10 h-[3px] rounded-t-[2px] bg-[var(--primary-base)]"
            style={{
              transform: `translate3d(${pillRect.left}px, 0, 0)`,
              width: `${pillRect.width}px`,
            }}
            aria-hidden
          />
        ) : null}
        {items.map((item) => {
          const isActive = item.id === activeId;
          const showInactiveIconOnly = inactiveTabsIconOnly && usesActivePillIndicator && !isActive && Boolean(item.icon);
          const shouldShowLabel = !showInactiveIconOnly;
          const useIntrinsicActiveTab = inactiveTabsIconOnly && usesActivePillIndicator && isActive && !isScrollable && !useIntrinsicPillSizing;
          const closable = item.closable !== false && Boolean(onClose);
          const closeReplacesIcon = closable && Boolean(item.icon);
          const wrapperClassName = (isScrollable || useIntrinsicPillSizing)
            ? undefined
            : usesActivePillIndicator
              ? (useIntrinsicActiveTab
                ? 'flex-none basis-auto'
                : (isMobile ? 'flex-1 basis-0 min-w-0' : 'flex-1 basis-0 min-w-fit'))
              : 'min-w-0 flex-1 basis-0';
          return (
            <Wrapper key={item.id} id={item.id} className={wrapperClassName}>
              <div
                ref={(element) => setTabRef(item.id, element)}
                className={cn(
                  'group flex h-full items-center',
                  (isScrollable || useIntrinsicPillSizing)
                    ? 'shrink-0'
                    : usesActivePillIndicator
                      ? 'w-full'
                      : 'w-full min-w-0',
                  usesActivePillIndicator
                    ? 'relative z-10 bg-transparent'
                    : isActive
                      ? 'relative z-10 bg-transparent text-foreground'
                      : 'relative z-10 bg-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-label={showInactiveIconOnly ? (item.title ?? item.label) : undefined}
                  onClick={() => onSelect(item.id)}
                  className={cn(
                    usesActivePillIndicator
                      ? 'animated-tabs__button pill-tabs__button relative z-10 flex flex-1 items-center justify-center rounded-[9px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px] text-sm font-medium transition-colors duration-150 !min-h-0'
                      : 'flex h-full min-w-0 items-center typography-micro',
                    usesActivePillIndicator && activePillLowercase ? 'lowercase' : null,
                    usesActivePillIndicator && (showInactiveIconOnly ? 'gap-0' : 'gap-1.5'),
                    usesActivePillIndicator
                      ? useIntrinsicPillSizing
                        ? 'shrink-0 whitespace-nowrap px-3 text-center'
                        : isScrollable
                          ? 'max-w-56 shrink-0 px-3 text-center'
                          : (showInactiveIconOnly
                            ? 'px-2 !min-w-0 text-center'
                            : useIntrinsicActiveTab
                              ? 'shrink-0 whitespace-nowrap px-3 text-center'
                              : 'px-3 text-center')
                      : isScrollable
                        ? 'max-w-56 justify-start truncate px-3 text-left'
                        : 'w-full justify-center truncate px-3 text-center',
                    usesActivePillIndicator
                      ? (activePillButtonClassName ?? (isActivePillVariant ? (isMobile ? 'h-[38px]' : 'h-[31px]') : 'h-7'))
                      : null,
                    usesActivePillIndicator
                      ? isActive
                        ? 'text-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                      : null,
                    usesActivePillIndicator
                      ? 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-background'
                      : null
                  )}
                  title={item.title ?? item.label}
                >
                  {usesActivePillIndicator ? (
                    <>
                      {item.icon ? (
                        <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
                          <span className={cn('flex items-center justify-center transition-opacity', closeReplacesIcon && 'group-hover:opacity-0')}>{item.icon}</span>
                          {closeReplacesIcon ? (
                            <span
                              role="button"
                              tabIndex={-1}
                              className="absolute inset-0 z-20 flex items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                              onPointerDown={(event) => {
                                event.stopPropagation();
                              }}
                              onClick={(event) => {
                                event.stopPropagation();
                                onClose?.(item.id);
                              }}
                              aria-label={item.closeLabel ?? `Close ${item.label} tab`}
                              title={item.closeLabel ?? `Close ${item.label} tab`}
                            >
                              <RiCloseLine className="h-3.5 w-3.5" />
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                      {shouldShowLabel ? <span className="animated-tabs__label truncate">{item.label}</span> : null}
                    </>
                  ) : (
                    <span className={cn('flex min-w-0 items-center gap-1.5', !isScrollable && 'justify-center')}>
                      {item.icon ? (
                        <span
                          className={cn(
                            'relative flex h-4 w-4 shrink-0 items-center justify-center transition-colors duration-200 ease-out',
                            isActive ? 'text-[var(--primary-base)]' : 'text-muted-foreground'
                          )}
                        >
                          <span className={cn('flex items-center justify-center transition-opacity', closeReplacesIcon && 'group-hover:opacity-0')}>{item.icon}</span>
                          {closeReplacesIcon ? (
                            <span
                              role="button"
                              tabIndex={-1}
                              className="absolute inset-0 z-20 flex items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                              onPointerDown={(event) => {
                                event.stopPropagation();
                              }}
                              onClick={(event) => {
                                event.stopPropagation();
                                onClose?.(item.id);
                              }}
                              aria-label={item.closeLabel ?? `Close ${item.label} tab`}
                              title={item.closeLabel ?? `Close ${item.label} tab`}
                            >
                              <RiCloseLine className="h-3.5 w-3.5" />
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                      <span className="truncate leading-[1.2]">{item.label}</span>
                    </span>
                  )}
                </button>
                {closable && !closeReplacesIcon ? (
                  <button
                    type="button"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      onClose?.(item.id);
                    }}
                    className={cn(
                      'relative z-20 inline-flex !min-h-0 !min-w-0 items-center justify-center transition-opacity',
                      usesActivePillIndicator
                        ? '-ml-2.5 mr-1 h-[88%] w-5 self-center !aspect-auto rounded-md'
                        : 'aspect-square h-[65%] min-h-4 max-h-5 rounded-sm mr-1',
                      usesActivePillIndicator
                        ? (isActive
                          ? 'text-muted-foreground hover:bg-transparent hover:text-foreground'
                          : 'text-muted-foreground opacity-0 hover:bg-transparent hover:text-foreground group-hover:opacity-100')
                        : (isActive
                          ? 'text-muted-foreground hover:bg-interactive-hover/60 hover:text-foreground'
                          : 'text-muted-foreground opacity-0 hover:bg-interactive-hover/80 hover:text-foreground group-hover:opacity-100')
                    )}
                    aria-label={item.closeLabel ?? `Close ${item.label} tab`}
                    title={item.closeLabel ?? `Close ${item.label} tab`}
                  >
                    <RiCloseLine className="h-3 w-3" />
                  </button>
                ) : null}
              </div>
            </Wrapper>
          );
        })}
      </div>
    </div>
  );

  if (!reorderEnabled) {
    return list;
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
      modifiers={[restrictToXAxis]}
    >
      <SortableContext items={itemIDs} strategy={horizontalListSortingStrategy}>
        {list}
      </SortableContext>
      <DragOverlay dropAnimation={null} />
    </DndContext>
  );
};
