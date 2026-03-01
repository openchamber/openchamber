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

import { cn } from '@/lib/utils';

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
  className,
}) => {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = React.useState<{ left: boolean; right: boolean }>({ left: false, right: false });
  const itemIDs = React.useMemo(() => items.map((item) => item.id), [items]);
  const isScrollable = layoutMode === 'scrollable';
  const reorderEnabled = typeof onReorder === 'function';
  const Wrapper = reorderEnabled ? SortableTabWrapper : StaticTabWrapper;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

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
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-background to-transparent" />
      ) : null}
      {isScrollable && overflow.right ? (
        <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-background to-transparent" />
      ) : null}
      <div
        ref={scrollRef}
        className={cn(
          'flex h-full min-w-0 flex-1 items-stretch',
          isScrollable
            ? 'overflow-x-auto scrollbar-none'
            : 'overflow-x-hidden',
        )}
        style={isScrollable ? { scrollbarWidth: 'none', msOverflowStyle: 'none' } : undefined}
        role="tablist"
        aria-label="Tabs"
      >
        {items.map((item) => {
          const isActive = item.id === activeId;
          const closable = item.closable !== false && Boolean(onClose);
          const wrapperClassName = isScrollable ? undefined : 'min-w-0 flex-1 basis-0';
          return (
            <Wrapper key={item.id} id={item.id} className={wrapperClassName}>
              <div
                className={cn(
                  'group flex h-full items-center border-r border-border/40',
                  isScrollable ? 'shrink-0' : 'w-full min-w-0',
                  isActive
                    ? 'bg-interactive-selection/55 text-interactive-selection-foreground'
                    : 'bg-interactive-selection/12 text-muted-foreground hover:bg-interactive-selection/28 hover:text-foreground'
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => onSelect(item.id)}
                  className={cn(
                    'flex h-full min-w-0 items-center typography-micro',
                    isScrollable ? 'max-w-56 justify-start truncate pl-3 pr-2 text-left' : 'w-full justify-center truncate px-2.5 text-center'
                  )}
                  title={item.title ?? item.label}
                >
                  <span className={cn('flex min-w-0 items-center gap-1.5', !isScrollable && 'justify-center')}>
                    {item.icon ? <span className="flex shrink-0 items-center justify-center">{item.icon}</span> : null}
                    <span className="truncate leading-[1.2]">{item.label}</span>
                  </span>
                </button>
                {closable ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onClose?.(item.id);
                    }}
                    className={cn(
                      'mr-1 inline-flex aspect-square h-[65%] min-h-4 max-h-5 items-center justify-center rounded-sm transition-opacity',
                      isActive
                        ? 'text-muted-foreground hover:bg-interactive-hover/60 hover:text-foreground'
                        : 'text-muted-foreground opacity-0 hover:bg-interactive-hover/80 hover:text-foreground group-hover:opacity-100'
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
