import React from 'react';
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type Modifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useDeviceInfo } from '@/lib/device';
import { Icon } from "@/components/icon/Icon";
import { TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { scrollTabsWithWheel } from './tab-strip-wheel';

export type SortableTabsStripItem = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  title?: string;
  closable?: boolean;
  closeLabel?: string;
  closeShortcut?: string;
  preview?: boolean;
  labelFolder?: string;
  accessory?: React.ReactNode;
};

const TabLabelText: React.FC<{ item: SortableTabsStripItem }> = ({ item }) => (
  item.labelFolder ? (
    <span dir="ltr">
      <span className="text-muted-foreground opacity-70">{item.labelFolder}/</span>{item.label}
    </span>
  ) : <>{item.label}</>
);

type SortableTabsStripProps = {
  items: SortableTabsStripItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void;
  onReorder?: (activeId: string, overId: string) => void;
  onDoubleClickTab?: (id: string) => void;
  layoutMode?: 'scrollable' | 'fit';
  scrollWithWheel?: boolean;
  variant?: 'default' | 'active-pill' | 'animated';
  activePillInsetClassName?: string;
  activePillButtonClassName?: string;
  pillSize?: 'toolbar' | 'form';
  inactiveTabsIconOnly?: boolean;
  iconOnly?: boolean;
  animateActivePill?: boolean;
  nonCompositedIndicator?: boolean;
  intrinsicWidth?: boolean;
  tabContextMenu?: (args: {
    id: string;
    index: number;
    isActive: boolean;
    allIds: string[];
    close: () => void;
  }) => React.ReactNode;
  className?: string;
  onTabDragOut?: (id: string, isOutside: (point: { x: number; y: number }) => boolean) => {
    finish: () => boolean;
    cancel: () => void;
  } | null;
};

const DRAG_OUT_SLACK_PX = 16;

const PILL_SWITCH_ANIMATION_MS = 280;
const PILL_NUDGE_PX = 4;
const EDGE_FADE_PILL_PX = 32;
const EDGE_FADE_PX = 24;

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
        transform: DndCSS.Translate.toString(transform),
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
  onDoubleClickTab,
  layoutMode = 'scrollable',
  scrollWithWheel = false,
  variant = 'default',
  activePillInsetClassName,
  activePillButtonClassName,
  pillSize = 'toolbar',
  inactiveTabsIconOnly = false,
  animateActivePill,
  nonCompositedIndicator = false,
  intrinsicWidth = false,
  iconOnly = false,
  tabContextMenu,
  className,
  onTabDragOut,
}) => {
  const { t, direction } = useI18n();
  const isRtl = direction === 'rtl';
  const isMobile = useUIStore((state) => state.isMobile);
  const { isTablet } = useDeviceInfo();
  const alwaysShowCloseControls = isMobile || isTablet;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = React.useState<{ start: boolean; end: boolean }>({ start: false, end: false });
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
  const shouldAnimateActivePill = animateActivePill ?? usesActivePillIndicator;
  const reorderEnabled = typeof onReorder === 'function';
  const Wrapper = reorderEnabled ? SortableTabWrapper : StaticTabWrapper;
  const tabRefs = React.useRef<Map<string, HTMLElement>>(new Map());
  const [pillRect, setPillRect] = React.useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [pillTransitionEnabled, setPillTransitionEnabled] = React.useState(false);
  const [pressedId, setPressedId] = React.useState<string | null>(null);
  const pillTransitionReadyRef = React.useRef(false);
  const lastSwitchAtRef = React.useRef(0);
  const previousActiveIdRef = React.useRef<string | null>(activeId);
  const previousOrderKeyRef = React.useRef<string | null>(null);

  const pillNudge = React.useMemo(() => {
    if (!usesIndicator || !pressedId || !activeId || pressedId === activeId) {
      return 0;
    }
    const pressedIndex = items.findIndex((item) => item.id === pressedId);
    const activeIndex = items.findIndex((item) => item.id === activeId);
    if (pressedIndex < 0 || activeIndex < 0) {
      return 0;
    }
    const towardLater = isRtl ? -PILL_NUDGE_PX : PILL_NUDGE_PX;
    return pressedIndex > activeIndex ? towardLater : -towardLater;
  }, [activeId, isRtl, items, pressedId, usesIndicator]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
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
    const element = isScrollable ? scrollRef.current : null;
    const fromStart = element ? Math.abs(element.scrollLeft) : 0;
    const start = element ? fromStart > 2 : false;
    const end = element ? fromStart + element.clientWidth < element.scrollWidth - 2 : false;
    setOverflow((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, [isScrollable]);

  React.useEffect(() => {
    if (!isScrollable) {
      updateOverflow();
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

    const observer = new ResizeObserver(() => {
      if (performance.now() - lastSwitchAtRef.current > PILL_SWITCH_ANIMATION_MS) {
        setPillTransitionEnabled(false);
      }
      updateActivePillRect();
    });
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

  const itemOrderKey = itemIDs.join('\u0000');

  React.useLayoutEffect(() => {
    if (!usesIndicator) {
      pillTransitionReadyRef.current = false;
      setPillTransitionEnabled(false);
      return;
    }

    const orderChanged = previousOrderKeyRef.current !== itemOrderKey;
    previousOrderKeyRef.current = itemOrderKey;

    if (!pillTransitionReadyRef.current) {
      pillTransitionReadyRef.current = true;
      previousActiveIdRef.current = activeId;
      return;
    }

    const switched = previousActiveIdRef.current !== activeId;
    previousActiveIdRef.current = activeId;

    if (!switched || orderChanged) {
      setPillTransitionEnabled(false);
      return;
    }

    lastSwitchAtRef.current = performance.now();
    setPillTransitionEnabled(true);
  }, [activeId, itemOrderKey, usesIndicator]);

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

      const fade = usesActivePillIndicator ? EDGE_FADE_PILL_PX : EDGE_FADE_PX;
      const strip = element.getBoundingClientRect();
      const tab = target.getBoundingClientRect();
      if (tab.width > strip.width - 2 * fade) {
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        updateOverflow();
        return;
      }
      const overStart = tab.left - (strip.left + fade);
      const overEnd = tab.right - (strip.right - fade);
      const delta = overStart < 0 ? overStart : overEnd > 0 ? overEnd : 0;
      const tabs = element.querySelectorAll('[data-sortable-tab-id]');
      const outermost = target === tabs[0] || target === tabs[tabs.length - 1];
      if (delta !== 0) element.scrollBy({ left: outermost ? Math.sign(delta) * element.scrollWidth : delta });
      updateOverflow();
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeId, isScrollable, items.length, updateOverflow, usesActivePillIndicator]);

  const dragOutRef = React.useRef<ReturnType<NonNullable<typeof onTabDragOut>> | null>(null);
  const handleDragStart = React.useCallback((event: DragStartEvent) => {
    dragOutRef.current?.cancel();
    dragOutRef.current = null;
    const strip = scrollRef.current;
    if (!onTabDragOut || !strip) return;
    const rect = strip.getBoundingClientRect();
    dragOutRef.current = onTabDragOut(String(event.active.id), (point) => (
      point.x < rect.left || point.x > rect.right
      || point.y < rect.top - DRAG_OUT_SLACK_PX || point.y > rect.bottom + DRAG_OUT_SLACK_PX
    ));
  }, [onTabDragOut]);
  const handleDragCancel = React.useCallback(() => {
    dragOutRef.current?.cancel();
    dragOutRef.current = null;
  }, []);
  React.useEffect(() => () => dragOutRef.current?.cancel(), []);

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    const dragOut = dragOutRef.current;
    dragOutRef.current = null;
    if (dragOut?.finish()) {
      return;
    }
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
      {isScrollable && overflow.start ? (
        <div
          className={cn(
            'pointer-events-none absolute inset-y-0 inset-s-0 z-20 bg-gradient-to-r rtl:bg-gradient-to-l to-transparent',
            usesActivePillIndicator
              ? 'w-8 from-[var(--surface-background)]'
              : 'w-6 from-background'
          )}
        />
      ) : null}
      {isScrollable && overflow.end ? (
        <div
          className={cn(
            'pointer-events-none absolute inset-y-0 inset-e-0 z-20 bg-gradient-to-l rtl:bg-gradient-to-r to-transparent',
            usesActivePillIndicator
              ? 'w-8 from-[var(--surface-background)]'
              : 'w-6 from-background'
          )}
        />
      ) : null}
      <div
        ref={scrollRef}
        onWheel={isScrollable && scrollWithWheel ? scrollTabsWithWheel : undefined}
        className={cn(
          'relative flex h-full min-w-0 flex-1',
          usesActivePillIndicator ? 'items-center overflow-x-hidden overflow-y-hidden' : 'items-stretch',
          usesActivePillIndicator && !intrinsicWidth && '@container/pill-tabs',
          usesActivePillIndicator && 'pill-tabs__track',
          usesActivePillIndicator && (activePillInsetClassName ?? 'gap-0.5 py-0.5'),
          useUnderlineIndicator && 'items-center overflow-y-hidden',
          showPillTrackBackground && 'oc-recessed rounded-lg bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] p-0.5 gap-0.5',
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
              // oxlint-disable-next-line openchamber/no-physical-sides -- positioned from offsetLeft, which is physical in either direction
              'oc-raised pointer-events-none absolute left-0 top-0 z-0 rounded-md bg-[var(--surface-background)] dark:bg-[var(--surface-elevated)]',
              shouldAnimateActivePill && pillTransitionEnabled
                && (nonCompositedIndicator ? 'pill-tabs__indicator--is-animated-layout' : 'pill-tabs__indicator--is-animated')
            )}
            style={nonCompositedIndicator
              ? {
                  left: `${pillRect.left + pillNudge}px`,
                  top: `${pillRect.top}px`,
                  width: `${pillRect.width}px`,
                  height: `${pillRect.height}px`,
                }
              : {
                  transform: `translate3d(${pillRect.left + pillNudge}px, ${pillRect.top}px, 0)`,
                  width: `${pillRect.width}px`,
                  height: `${pillRect.height}px`,
                }}
          />
        ) : null}
        {useUnderlineIndicator && pillRect ? (
          <div
            className={cn(
              // oxlint-disable-next-line openchamber/no-physical-sides -- positioned from offsetLeft, which is physical in either direction
              'pointer-events-none absolute left-0 -bottom-px z-10 h-[3px] rounded-t-[2px] bg-foreground',
              pillTransitionEnabled && 'underline-tabs__indicator--is-animated'
            )}
            style={{
              transform: `translate3d(${pillRect.left + pillNudge}px, 0, 0)`,
              width: `${pillRect.width}px`,
            }}
            aria-hidden
          />
        ) : null}
        {items.map((item, index) => {
          const isActive = item.id === activeId;
          const showInactiveIconOnly = (iconOnly || (inactiveTabsIconOnly && !isActive)) && usesActivePillIndicator && Boolean(item.icon);
          const shouldShowLabel = !showInactiveIconOnly;
          const shouldShowIcon = Boolean(item.icon);
          const useIntrinsicActiveTab = inactiveTabsIconOnly && usesActivePillIndicator && isActive && !isScrollable && !useIntrinsicPillSizing;
          const closable = item.closable !== false && Boolean(onClose);
          const closeReplacesIcon = closable && Boolean(item.icon);
          const closeLabel = item.closeLabel ?? t('contextPanel.tab.closeTabAria', { label: item.label });
          const withCloseTooltip = (control: React.ReactElement) => (
            <Tooltip>
              <TooltipTrigger asChild>{control}</TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}><TooltipLabelWithShortcut label={closeLabel} shortcut={item.closeShortcut} /></TooltipContent>
            </Tooltip>
          );
          const closeInsideTab = withCloseTooltip(
            <span
              role="button"
              tabIndex={-1}
              className={cn('absolute inset-0 z-20 flex !min-h-0 !min-w-0 items-center justify-center rounded-sm text-muted-foreground transition-opacity hover:text-foreground', alwaysShowCloseControls ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.stopPropagation();
                onClose?.(item.id);
              }}
              aria-label={closeLabel}
              title=""
            >
              <Icon name="close" className="h-3.5 w-3.5" />
            </span>,
          );
          const wrapperClassName = (isScrollable || useIntrinsicPillSizing)
            ? (useIntrinsicPillSizing ? 'shrink-0' : undefined)
            : usesActivePillIndicator
              ? (useIntrinsicActiveTab
                ? 'flex-none basis-auto'
                : (isMobile ? 'flex-1 basis-0 min-w-0' : 'flex-1 basis-0 min-w-fit'))
              : 'min-w-0 flex-1 basis-0';
          const handleAuxClick = closable
            ? (event: React.MouseEvent<HTMLDivElement>) => {
                if (event.button !== 1) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                onClose?.(item.id);
              }
            : undefined;
          const handleMouseDown = closable
            ? (event: React.MouseEvent<HTMLDivElement>) => {
                if (event.button === 1) {
                  event.preventDefault();
                }
              }
            : undefined;
          const tabMenuItems = !isMobile && tabContextMenu
            ? tabContextMenu({
              id: item.id,
              index,
              isActive,
              allIds: itemIDs,
              close: () => onClose?.(item.id),
            })
            : null;

          const tabElement = (
            <div
                ref={(element) => setTabRef(item.id, element)}
                onAuxClick={handleAuxClick}
                onMouseDown={handleMouseDown}
                className={cn(
                  'group flex h-full min-w-0 flex-nowrap items-center',
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
                  onDoubleClick={onDoubleClickTab ? () => onDoubleClickTab(item.id) : undefined}
                  onPointerDown={usesIndicator ? () => {
                    setPillTransitionEnabled(true);
                    setPressedId(item.id);
                  } : undefined}
                  onPointerUp={usesIndicator ? () => setPressedId(null) : undefined}
                  onPointerLeave={usesIndicator ? () => setPressedId(null) : undefined}
                  onPointerCancel={usesIndicator ? () => setPressedId(null) : undefined}
                  className={cn(
                    usesActivePillIndicator
                      ? 'animated-tabs__button pill-tabs__button relative z-10 flex flex-1 min-w-0 flex-nowrap items-center justify-center rounded-md text-sm font-medium transition-colors duration-150 !min-h-0'
                      : 'flex h-full min-w-0 flex-nowrap items-center typography-micro',
                    usesActivePillIndicator && (showInactiveIconOnly ? 'gap-0' : 'gap-1.5'),
                    usesActivePillIndicator
                      ? useIntrinsicPillSizing
                        ? 'shrink-0 whitespace-nowrap px-3 text-center'
                        : isScrollable
                          ? cn(!item.labelFolder && 'max-w-56', 'shrink-0 px-3 text-center')
                          : (showInactiveIconOnly
                            ? 'px-2 !min-w-0 text-center'
                            : useIntrinsicActiveTab
                              ? 'shrink-0 whitespace-nowrap px-3 text-center'
                              : 'px-3 text-center')
                      : isScrollable
                        ? cn(!item.labelFolder && 'max-w-56', 'justify-start truncate px-3 text-start')
                        : 'w-full justify-center truncate px-3 text-center',
                    usesActivePillIndicator
                      ? cn(isActivePillVariant ? (isMobile ? 'h-[38px]' : pillSize === 'form' ? 'h-7' : 'h-6') : 'h-7', activePillButtonClassName)
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
                      {shouldShowIcon ? (
                        <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
                          <span className={cn('flex items-center justify-center transition-opacity', closeReplacesIcon && (alwaysShowCloseControls ? 'opacity-0' : 'group-hover:opacity-0'))}>{item.icon}</span>
                          {closeReplacesIcon ? closeInsideTab : null}
                        </span>
                      ) : null}
                      {shouldShowLabel ? <span className={cn('animated-tabs__label truncate', item.preview && 'italic')}><TabLabelText item={item} /></span> : null}
                      {shouldShowLabel ? item.accessory : null}
                    </>
                  ) : (
                    <span className={cn('flex min-w-0 flex-nowrap items-center gap-1.5', !isScrollable && 'justify-center')}>
                      {shouldShowIcon ? (
                        <span
                          className={cn(
                            'relative flex h-4 w-4 shrink-0 items-center justify-center transition-colors duration-200 ease-out',
                            isActive ? 'text-foreground' : 'text-muted-foreground'
                          )}
                        >
                          <span className={cn('flex items-center justify-center transition-opacity', closeReplacesIcon && (alwaysShowCloseControls ? 'opacity-0' : 'group-hover:opacity-0'))}>{item.icon}</span>
                          {closeReplacesIcon ? closeInsideTab : null}
                        </span>
                      ) : null}
                      <span className={cn('truncate leading-[1.2]', item.preview && 'italic')}><TabLabelText item={item} /></span>
                      {item.accessory}
                    </span>
                  )}
                </button>
                {closable && !closeReplacesIcon ? withCloseTooltip(
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
                        ? '-ms-2.5 me-1 h-[88%] w-5 self-center !aspect-auto rounded-md'
                        : 'aspect-square h-[65%] min-h-4 max-h-5 rounded-sm me-1',
                      usesActivePillIndicator
                        ? (isActive
                          ? 'text-muted-foreground hover:bg-transparent hover:text-foreground'
                          : 'text-muted-foreground opacity-0 hover:bg-transparent hover:text-foreground group-hover:opacity-100')
                        : (isActive
                          ? 'text-muted-foreground hover:bg-interactive-hover/60 hover:text-foreground'
                          : 'text-muted-foreground opacity-0 hover:bg-interactive-hover/80 hover:text-foreground group-hover:opacity-100')
                    )}
                    aria-label={closeLabel}
                  >
                    <Icon name="close" className="h-3 w-3" />
                  </button>
                ) : null}
              </div>
          );

          return (
            <Wrapper key={item.id} id={item.id} className={wrapperClassName}>
              {tabMenuItems ? (
                <ContextMenu>
                  <ContextMenuTrigger
                    render={(triggerProps) => (
                      <div {...triggerProps} className={cn('flex h-full min-w-0', triggerProps.className)}>
                        {tabElement}
                      </div>
                    )}
                  />
                  <ContextMenuContent className="w-52">{tabMenuItems}</ContextMenuContent>
                </ContextMenu>
              ) : (
                tabElement
              )}
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
      onDragStart={handleDragStart}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
      modifiers={[restrictToXAxis]}
    >
      <SortableContext items={itemIDs} strategy={isRtl ? rectSortingStrategy : horizontalListSortingStrategy}>
        {list}
      </SortableContext>
      <DragOverlay dropAnimation={null} />
    </DndContext>
  );
};
