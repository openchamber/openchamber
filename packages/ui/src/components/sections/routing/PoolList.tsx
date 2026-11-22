import React from 'react';
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type { ModelRoute } from '@/lib/routing/modelRoutesApi';
import { MODEL_ROUTE_PROVIDER_ID } from '@/lib/sessionErrorRecovery';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';

const PoolRow: React.FC<{
  id: string;
  route: ModelRoute;
  sortable: boolean;
  onOpen: () => void;
}> = ({ id, route, sortable, onOpen }) => {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !sortable });
  const hidden = useUIStore((state) => state.hiddenModels.some((entry) => entry.providerID === MODEL_ROUTE_PROVIDER_ID && entry.modelID === id));
  const toggleHiddenModel = useUIStore((state) => state.toggleHiddenModel);
  const name = route.name || id;
  const count = (route.targets ?? []).length;
  const summary = [count === 1 ? t('settings.pools.targetCount.one') : t('settings.pools.targetCount', { count }), route.description].filter(Boolean).join(' · ');

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('flex items-center gap-1 py-1', isDragging && 'opacity-60')}
    >
      {sortable ? (
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={t('settings.pools.order.handle', { name })}
          className="flex size-6 shrink-0 cursor-grab touch-none select-none items-center justify-center rounded text-muted-foreground hover:text-foreground"
        >
          <Icon name="draggable" className="size-3.5" />
        </button>
      ) : <span className="size-6 shrink-0" />}
      <button
        type="button"
        onClick={onOpen}
        aria-label={t('settings.pools.openPool', { name })}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1.5 text-start hover:bg-interactive-hover/50"
      >
        <span className={cn('typography-ui-label truncate font-medium', hidden ? 'text-muted-foreground' : 'text-foreground')}>{name}</span>
        <span className="typography-meta min-w-0 truncate text-muted-foreground" title={route.description}>{summary}</span>
        <Icon name="arrow-right-s" className="ms-auto size-4 shrink-0 text-muted-foreground" />
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-pressed={hidden}
        aria-label={hidden ? t('settings.pools.show', { name }) : t('settings.pools.hide', { name })}
        title={hidden ? t('settings.pools.show', { name }) : t('settings.pools.hide', { name })}
        onClick={() => toggleHiddenModel(MODEL_ROUTE_PROVIDER_ID, id)}
      >
        <Icon name={hidden ? 'eye-off' : 'eye'} className="size-3.5" />
      </Button>
    </div>
  );
};

/**
 * Every pool in the order OpenCode and the model picker list them. Drag a
 * row to move it; the new order is saved as the order of the pools in the
 * config. A new pool that has no model yet stays at the end until it is saved.
 */
export const PoolList: React.FC<{
  routes: Record<string, ModelRoute>;
  drafts: Record<string, ModelRoute>;
  onOpen: (id: string) => void;
  onReorder: (orderedIds: string[]) => void;
}> = ({ routes, drafts, onOpen, onReorder }) => {
  const { t } = useI18n();
  const ids = Object.keys(routes);
  const nameOf = (id: string | number) => routes[String(id)]?.name || String(id);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const position = (id: string | number) => t('settings.pools.order.position', {
    name: nameOf(id),
    position: ids.indexOf(String(id)) + 1,
    count: ids.length,
  });
  const announcements: Announcements = {
    onDragStart: ({ active }) => position(active.id),
    onDragOver: ({ over }) => (over ? position(over.id) : undefined),
    onDragEnd: ({ over }) => (over ? position(over.id) : undefined),
    onDragCancel: () => t('settings.pools.order.cancelled'),
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from >= 0 && to >= 0) onReorder(arrayMove(ids, from, to));
  };

  return (
    <div className="divide-y divide-border/40 border-y border-border/40" data-settings-item="routing.pools-targets">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} accessibility={{ announcements }}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {ids.map((id) => <PoolRow key={id} id={id} route={routes[id]} sortable onOpen={() => onOpen(id)} />)}
        </SortableContext>
        {Object.entries(drafts).map(([id, route]) => (
          <PoolRow key={id} id={id} route={route} sortable={false} onOpen={() => onOpen(id)} />
        ))}
      </DndContext>
    </div>
  );
};
