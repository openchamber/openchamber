import React from 'react';
import { DndContext, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type Announcements, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { SettingsCheckboxRow } from './SettingsSection';

interface SortableVisibilityItem {
  id: string;
  label: string;
  visible: boolean;
  /** Its checkbox cannot change, such as the last item that must stay shown. */
  locked?: boolean;
}

const SortableVisibilityRow: React.FC<{
  item: SortableVisibilityItem;
  settingsItem: string;
  onVisibleChange: (visible: boolean) => void;
}> = ({ item, settingsItem, onVisibleChange }) => {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('relative flex items-center gap-2', isDragging && 'z-10 opacity-60')}
    >
      <Button
        ref={setActivatorNodeRef}
        variant="ghost"
        size="icon"
        {...attributes}
        {...listeners}
        aria-label={t('contextRail.configure.reorder', { label: item.label })}
        className="shrink-0 touch-none select-none cursor-grab text-muted-foreground hover:bg-transparent active:cursor-grabbing"
      >
        <Icon name="draggable" className="size-4" />
      </Button>
      <SettingsCheckboxRow
        settingsItem={settingsItem}
        checked={item.visible}
        onChange={onVisibleChange}
        disabled={item.locked}
        label={item.label}
        ariaLabel={item.label}
        className="min-w-0 flex-1"
      />
    </div>
  );
};

/**
 * A list the user orders by dragging and filters with checkboxes: the rail's
 * panels on desktop, the workspace tabs on a phone. Mouse drags after a small
 * move, touch after a long press (a swipe still scrolls the page), and the
 * keyboard picks a row up with Space.
 */
export const SettingsSortableVisibilityList: React.FC<{
  items: SortableVisibilityItem[];
  onVisibleChange: (id: string, visible: boolean) => void;
  /** The new order of every listed id, after a drop that moved something. */
  onReorder: (ids: string[]) => void;
  /** Each row's `data-settings-item` is this prefix plus the item id. */
  settingsItemPrefix: string;
  /** What a screen reader hears about picking a row up with the keyboard. */
  dragInstructions: string;
  /** For a host that must not close or steal arrow keys mid-drag, such as a dialog. */
  onDraggingChange?: (dragging: boolean) => void;
}> = ({ items, onVisibleChange, onReorder, settingsItemPrefix, dragInstructions, onDraggingChange }) => {
  const { t } = useI18n();
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    onDraggingChange?.(false);
    if (!over || active.id === over.id) return;
    const from = items.findIndex((item) => item.id === active.id);
    const to = items.findIndex((item) => item.id === over.id);
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(items, from, to).map((item) => item.id));
  };
  const accessibility = React.useMemo(() => {
    const position = (activeId: string | number, overId: string | number = activeId) => {
      const item = items.find((entry) => entry.id === activeId);
      if (!item) return undefined;
      return t('contextRail.configure.position', {
        label: item.label,
        position: items.findIndex((entry) => entry.id === overId) + 1,
        count: items.length,
      });
    };
    const announcements: Announcements = {
      onDragStart: ({ active }) => position(active.id),
      onDragOver: ({ active, over }) => over ? position(active.id, over.id) : undefined,
      onDragEnd: ({ active, over }) => over ? position(active.id, over.id) : t('contextRail.configure.dragCancelled'),
      onDragCancel: () => t('contextRail.configure.dragCancelled'),
    };
    return { screenReaderInstructions: { draggable: dragInstructions }, announcements };
  }, [dragInstructions, items, t]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={() => onDraggingChange?.(true)}
      onDragCancel={() => onDraggingChange?.(false)}
      onDragEnd={handleDragEnd}
      accessibility={accessibility}
    >
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col">
          {items.map((item) => (
            <SortableVisibilityRow
              key={item.id}
              item={item}
              settingsItem={`${settingsItemPrefix}${item.id}`}
              onVisibleChange={(visible) => onVisibleChange(item.id, visible)}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
};
