import React from 'react';
import { DndContext, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type Announcements, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { SettingsCheckboxRow } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useGuestSurfaces } from '@/hooks/useGuestSurfaces';
import { sortContextSurfaces } from '@/lib/surfaces/registry';

const SortableSurfaceRow: React.FC<{
  surfaceId: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}> = ({ surfaceId, label, checked, onChange }) => {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: surfaceId });
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
        aria-label={t('contextRail.configure.reorder', { label })}
        className="shrink-0 touch-none select-none cursor-grab text-muted-foreground hover:bg-transparent active:cursor-grabbing"
      >
        <Icon name="draggable" className="size-4" />
      </Button>
      <SettingsCheckboxRow
        settingsItem={`layout.context-rail.surface.${surfaceId}`}
        checked={checked}
        onChange={onChange}
        label={label}
        ariaLabel={label}
        className="min-w-0 flex-1"
      />
    </div>
  );
};

/**
 * Which surfaces the context rail shows. Everything is on by default and the
 * choice is stored as the *hidden* set, so a surface added in a later release
 * appears for everyone rather than staying invisible to whoever had saved
 * settings before it existed. Hidden surfaces also leave the digit shortcuts
 * (the rail and the shortcut share one visibility filter).
 */
export const ContextRailSurfacesDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}> = ({ open, onOpenChange }) => {
  const { t } = useI18n();
  const contextRailOrder = useUIStore((state) => state.contextRailOrder);
  const setSurfaceOrder = useUIStore((state) => state.setContextRailOrder);
  const hidden = useUIStore((state) => state.contextRailHiddenSurfaces);
  const setSurfaceVisible = useUIStore((state) => state.setContextRailSurfaceVisible);
  const setHiddenSurfaces = useUIStore((state) => state.setContextRailHiddenSurfaces);

  // The full registry in the user's rail order — including surfaces a runtime
  // filter currently drops, so a choice made on desktop is editable anywhere.
  const guestSurfaces = useGuestSurfaces();
  const surfaces = React.useMemo(
    () => sortContextSurfaces(contextRailOrder, guestSurfaces),
    [contextRailOrder, guestSurfaces],
  );

  const allVisible = hidden.length === 0;
  const noneVisible = surfaces.every((surface) => hidden.includes(surface.id));
  const dragging = React.useRef(false);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    dragging.current = false;
    if (!over || active.id === over.id) return;
    const from = surfaces.findIndex((surface) => surface.id === active.id);
    const to = surfaces.findIndex((surface) => surface.id === over.id);
    if (from < 0 || to < 0) return;
    const next = arrayMove(surfaces, from, to).map((surface) => surface.id);
    const shown = new Set<string>(next);
    // Keep saved entries for extensions that are temporarily unavailable.
    setSurfaceOrder([...next, ...contextRailOrder.filter((id) => !shown.has(id))]);
  };
  const accessibility = React.useMemo(() => {
    const position = (activeId: string | number, overId: string | number = activeId) => {
      const surface = surfaces.find((item) => item.id === activeId);
      if (!surface) return undefined;
      return t('contextRail.configure.position', {
        label: surface.label ?? t(surface.labelKey),
        position: surfaces.findIndex((item) => item.id === overId) + 1,
        count: surfaces.length,
      });
    };
    const announcements: Announcements = {
      onDragStart: ({ active }) => position(active.id),
      onDragOver: ({ active, over }) => over ? position(active.id, over.id) : undefined,
      onDragEnd: ({ active, over }) => over ? position(active.id, over.id) : t('contextRail.configure.dragCancelled'),
      onDragCancel: () => t('contextRail.configure.dragCancelled'),
    };
    return {
      screenReaderInstructions: { draggable: t('contextRail.configure.dragInstructions') },
      announcements,
    };
  }, [surfaces, t]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen, details) => {
      if (!nextOpen && details.reason === 'escape-key' && dragging.current) {
        details.cancel();
        details.allowPropagation();
        return;
      }
      dragging.current = false;
      onOpenChange(nextOpen);
    }}>
      <DialogContent
        className="max-w-md"
        onKeyDown={(event) => {
          // Base UI stops arrow keys at the popup; dnd-kit listens on document.
          if (dragging.current && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
            event.preventBaseUIHandler();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('contextRail.configure.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('contextRail.configure.dialogDescription')}</DialogDescription>
        </DialogHeader>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={() => { dragging.current = true; }}
          onDragCancel={() => { dragging.current = false; }}
          onDragEnd={handleDragEnd}
          accessibility={accessibility}
        >
          <SortableContext items={surfaces} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col">
              {surfaces.map((surface) => (
                <SortableSurfaceRow
                  key={surface.id}
                  surfaceId={surface.id}
                  checked={!hidden.includes(surface.id)}
                  onChange={(checked) => setSurfaceVisible(surface.id, checked)}
                  label={surface.label ?? t(surface.labelKey)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>

        {!allVisible ? (
          <div className="flex items-center justify-between border-t pt-3">
            {noneVisible ? (
              <span className="text-xs text-destructive">{t('contextRail.configure.noneWarning')}</span>
            ) : <span />}
            <Button
              variant="link"
              size="xs"
              onClick={() => setHiddenSurfaces([])}
              className="normal-case text-muted-foreground hover:text-foreground"
            >
              {t('contextRail.configure.showAll')}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
