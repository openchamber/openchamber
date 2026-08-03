import React from 'react';
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { Icon } from '@/components/icon/Icon';
import { DiffViewIcon } from '@/components/icons/DiffIcon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useDeviceInfo } from '@/lib/device';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import {
  sortContextSurfaces,
  type ContextSurfaceDescriptor,
} from '@/lib/surfaces/registry';
import { cn } from '@/lib/utils';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useGitStatus } from '@/stores/useGitStore';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';

const RAIL_TOOLTIP_DELAY_MS = 150;
// Tablet width and up: below this the walkthrough cannot show a stop and its
// code side by side, which is the whole point of the surface.
const WALKTHROUGH_MIN_WIDTH = 768;
const EMPTY_TABS: never[] = [];

type RailItemProps = {
  surface: ContextSurfaceDescriptor;
  isActive: boolean;
  showActivityDot: boolean;
  label: string;
  description: string;
  onSelect: (surface: ContextSurfaceDescriptor) => void;
};

const ContextPanelRailItem: React.FC<RailItemProps> = ({
  surface,
  isActive,
  showActivityDot,
  label,
  description,
  onSelect,
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: surface.id,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('relative', isDragging && 'z-10 opacity-70')}
    >
      <Tooltip delayDuration={RAIL_TOOLTIP_DELAY_MS}>
        <TooltipTrigger asChild>
          <button
            type="button"
            {...attributes}
            {...listeners}
            onClick={() => onSelect(surface)}
            aria-label={label}
            aria-pressed={isActive}
            className={cn(
              'flex h-9 w-9 touch-none select-none items-center justify-center rounded-md transition-colors',
              isActive
                ? 'text-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {surface.id === 'diff' ? (
              <DiffViewIcon />
            ) : (
              <Icon name={surface.icon} className="h-[18px] w-[18px]" />
            )}
            {showActivityDot ? (
              <span
                aria-hidden="true"
                className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--status-info)]"
              />
            ) : null}
          </button>
        </TooltipTrigger>
        <TooltipContent side="left" sideOffset={8}>
          <div className="flex flex-col gap-0.5">
            <span>{label}</span>
            <span className="typography-micro text-muted-foreground">{description}</span>
          </div>
        </TooltipContent>
      </Tooltip>
    </div>
  );
};

export const ContextPanelRail: React.FC = () => {
  const { t } = useI18n();
  const effectiveDirectory = useEffectiveDirectory();
  const directoryKey = effectiveDirectory ? normalizeContextPanelDirectoryKey(effectiveDirectory) : '';

  const panelState = useUIStore((state) => (directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined));
  const contextRailOrder = useUIStore((state) => state.contextRailOrder);
  const setContextRailOrder = useUIStore((state) => state.setContextRailOrder);
  const openContextSurface = useUIStore((state) => state.openContextSurface);
  const planModeEnabled = useFeatureFlagsStore((state) => state.planModeEnabled);
  const { screenWidth } = useDeviceInfo();
  const gitStatus = useGitStatus(directoryKey || null);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );

  const tabs = panelState?.tabs ?? EMPTY_TABS;
  const activeTab = tabs.find((tab) => tab.id === panelState?.activeTabId) ?? null;
  const activeMode = panelState?.isOpen ? activeTab?.mode ?? null : null;
  const changedFilesCount = gitStatus?.files.length ?? 0;

  // Content-driven surfaces are hidden (not disabled) until content exists;
  // an existing tab keeps them visible even if the content source went away.
  const surfaces = React.useMemo(() => {
    return sortContextSurfaces(contextRailOrder).filter((surface) => {
      if (surface.id === 'plan' && !planModeEnabled) {
        return false;
      }
      // The walkthrough needs room for a stop list beside real code, and its
      // diffs come from OpenChamber's Git routes, which VS Code does not serve.
      if (surface.id === 'walkthrough' && (isVSCodeRuntime() || screenWidth < WALKTHROUGH_MIN_WIDTH)) {
        return false;
      }
      if (surface.availability === 'has-content') {
        return tabs.some((tab) => tab.mode === surface.mode);
      }
      return true;
    });
  }, [contextRailOrder, planModeEnabled, screenWidth, tabs]);

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    const orderedIds = sortContextSurfaces(useUIStore.getState().contextRailOrder).map((surface) => surface.id);
    const fromIndex = orderedIds.indexOf(active.id as (typeof orderedIds)[number]);
    const toIndex = orderedIds.indexOf(over.id as (typeof orderedIds)[number]);
    if (fromIndex === -1 || toIndex === -1) {
      return;
    }

    setContextRailOrder(arrayMove(orderedIds, fromIndex, toIndex));
  }, [setContextRailOrder]);

  if (!directoryKey) {
    return null;
  }

  return (
    <nav
      aria-label={t('contextRail.aria.rail')}
      className="flex h-full w-11 flex-shrink-0 flex-col items-center gap-1 bg-background py-2"
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={surfaces.map((surface) => surface.id)} strategy={verticalListSortingStrategy}>
          {surfaces.map((surface) => (
            <ContextPanelRailItem
              key={surface.id}
              surface={surface}
              isActive={activeMode === surface.mode}
              showActivityDot={surface.id === 'git' && changedFilesCount > 0}
              label={t(surface.labelKey)}
              description={t(surface.descriptionKey)}
              onSelect={(selected) => openContextSurface(directoryKey, selected.mode)}
            />
          ))}
        </SortableContext>
      </DndContext>
    </nav>
  );
};
