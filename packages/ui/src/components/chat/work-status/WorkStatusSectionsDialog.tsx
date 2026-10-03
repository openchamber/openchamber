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
  isExtensionSectionId,
  isWorkStatusSectionVisible,
  resolveWorkStatusSectionOrder,
  type WorkStatusPanelSectionId,
} from './sections';
import { useWorkStatusExtensionSections, type WorkStatusExtensionSections } from './useWorkStatusExtensionSections';

/** Built-in sections are named by the host; an extension's by its own title. */
const useSectionLabel = (extensions: WorkStatusExtensionSections) => {
  const { t } = useI18n();
  return React.useCallback((sectionId: WorkStatusPanelSectionId): string => {
    if (!isExtensionSectionId(sectionId)) return t(WORK_STATUS_SECTION_LABEL_KEYS[sectionId]);
    const guest = extensions.byId.get(sectionId);
    return guest ? guest.statusTitle ?? guest.name : sectionId;
  }, [extensions, t]);
};

const SortableSectionRow: React.FC<{
  sectionId: WorkStatusPanelSectionId;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}> = ({ sectionId, label, checked, onChange }) => {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: sectionId });
  const extension = isExtensionSectionId(sectionId);
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
        // Extension rows are dynamic entities, so they carry no search anchor.
        settingsItem={extension ? undefined : `chat.work-status.section.${sectionId}`}
        checked={checked}
        onChange={onChange}
        label={label}
        ariaLabel={label}
        className="min-w-0 flex-1"
      />
      {extension ? (
        <span className="shrink-0 text-xs text-muted-foreground">{t('chat.workStatus.sections.extensionBadge')}</span>
      ) : null}
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
  const extensionSections = useWorkStatusExtensionSections();
  const sectionLabel = useSectionLabel(extensionSections);
  const sectionOrder = React.useMemo(
    () => resolveWorkStatusSectionOrder(storedOrder, extensionSections.ids),
    [extensionSections.ids, storedOrder],
  );
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
    // Sections of extensions that are paused or not loaded right now keep
    // their saved slot at the end instead of being forgotten.
    const next = arrayMove(sectionOrder, from, to);
    const shown = new Set<string>(next);
    setSectionOrder([...next, ...storedOrder.filter((id) => !shown.has(id))]);
  };
  const accessibility = React.useMemo(() => {
    const position = (activeId: string | number, overId: string | number = activeId) => {
      const section = sectionOrder.find((id) => id === activeId);
      if (!section) return undefined;
      return t('chat.workStatus.sections.position', {
        label: sectionLabel(section),
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
  }, [sectionLabel, sectionOrder, t]);

  // Measured against what the dialog lists: a hidden id of an extension that
  // is not available here must not offer a "Show all" with nothing to show.
  const allVisible = sectionOrder.every((id) => isWorkStatusSectionVisible(hidden, id));
  const noneVisible = areAllWorkStatusSectionsHidden(hidden, extensionSections.ids);

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
                  label={sectionLabel(sectionId)}
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
