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
import {
  WORK_STATUS_SECTION_LABEL_KEYS,
  areAllWorkStatusSectionsHidden,
  isWorkStatusSectionVisible,
  sanitizeWorkStatusSectionOrder,
  type WorkStatusSectionId,
} from './sections';

const SortableSectionRow: React.FC<{
  sectionId: WorkStatusSectionId;
  checked: boolean;
  onChange: (checked: boolean) => void;
}> = ({ sectionId, checked, onChange }) => {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: sectionId });
  const label = t(WORK_STATUS_SECTION_LABEL_KEYS[sectionId]);
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
        aria-label={t('chat.workStatus.sections.reorder', { label })}
        className="shrink-0 touch-none select-none cursor-grab text-muted-foreground hover:bg-transparent active:cursor-grabbing"
      >
        <Icon name="draggable" className="size-4" />
      </Button>
      <SettingsCheckboxRow
        settingsItem={`chat.work-status.section.${sectionId}`}
        checked={checked}
        onChange={onChange}
        label={label}
        ariaLabel={label}
        className="min-w-0 flex-1"
      />
    </div>
  );
};

/** Visibility and display order share stable section ids. */
export const WorkStatusSectionsDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}> = ({ open, onOpenChange }) => {
  const { t } = useI18n();
  const hidden = useUIStore((state) => state.workStatusHiddenSections);
  const setSectionVisible = useUIStore((state) => state.setWorkStatusSectionVisible);
  const setHiddenSections = useUIStore((state) => state.setWorkStatusHiddenSections);
  const storedOrder = useUIStore((state) => state.workStatusSectionOrder);
  const setSectionOrder = useUIStore((state) => state.setWorkStatusSectionOrder);
  const sectionOrder = React.useMemo(() => sanitizeWorkStatusSectionOrder(storedOrder), [storedOrder]);
  const dragging = React.useRef(false);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    dragging.current = false;
    if (!over || active.id === over.id) return;
    const from = sectionOrder.findIndex((id) => id === active.id);
    const to = sectionOrder.findIndex((id) => id === over.id);
    if (from < 0 || to < 0) return;
    setSectionOrder(arrayMove(sectionOrder, from, to));
  };
  const accessibility = React.useMemo(() => {
    const position = (activeId: string | number, overId: string | number = activeId) => {
      const section = sectionOrder.find((id) => id === activeId);
      if (!section) return undefined;
      return t('chat.workStatus.sections.position', {
        label: t(WORK_STATUS_SECTION_LABEL_KEYS[section]),
        position: sectionOrder.findIndex((id) => id === overId) + 1,
        count: sectionOrder.length,
      });
    };
    const announcements: Announcements = {
      onDragStart: ({ active }) => position(active.id),
      onDragOver: ({ active, over }) => over ? position(active.id, over.id) : undefined,
      onDragEnd: ({ active, over }) => over ? position(active.id, over.id) : t('chat.workStatus.sections.dragCancelled'),
      onDragCancel: () => t('chat.workStatus.sections.dragCancelled'),
    };
    return {
      screenReaderInstructions: { draggable: t('chat.workStatus.sections.dragInstructions') },
      announcements,
    };
  }, [sectionOrder, t]);

  const allVisible = hidden.length === 0;
  const noneVisible = areAllWorkStatusSectionsHidden(hidden);

  const handleShowAll = () => setHiddenSections([]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen, details) => {
      if (!nextOpen && details.reason === 'escape-key' && dragging.current) {
        details.cancel();
        return;
      }
      dragging.current = false;
      onOpenChange(nextOpen);
    }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('chat.workStatus.sections.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('chat.workStatus.sections.dialogDescription')}</DialogDescription>
        </DialogHeader>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={() => { dragging.current = true; }}
          onDragCancel={() => { dragging.current = false; }}
          onDragEnd={handleDragEnd}
          accessibility={accessibility}
        >
          <SortableContext items={sectionOrder} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col">
              {sectionOrder.map((sectionId) => (
                <SortableSectionRow
                  key={sectionId}
                  sectionId={sectionId}
                  checked={isWorkStatusSectionVisible(hidden, sectionId)}
                  onChange={(checked) => setSectionVisible(sectionId, checked)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>

        {!allVisible ? (
          <div className="flex items-center justify-between border-t pt-3">
            {noneVisible ? (
              <span className="text-xs text-destructive">{t('chat.workStatus.sections.noneWarning')}</span>
            ) : <span />}
            <Button
              variant="link"
              size="xs"
              onClick={handleShowAll}
              className="normal-case text-muted-foreground hover:text-foreground"
            >
              {t('chat.workStatus.sections.showAll')}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
