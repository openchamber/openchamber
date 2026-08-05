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
  getVisibleContextRailSurfaces,
  sortContextSurfaces,
  type ContextSurfaceDescriptor,
} from '@/lib/surfaces/registry';
import {
  getEffectiveShortcutPrefix,
  isShortcutPrefixHeld,
} from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useGitStatus } from '@/stores/useGitStore';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';

const RAIL_TOOLTIP_DELAY_MS = 150;
// Hold the surface-switch modifier for this long before revealing the order
// number badges on the rail icons.
const RAIL_NUMBER_HOLD_DELAY_MS = 500;
const EMPTY_TABS: never[] = [];

type RailItemProps = {
  surface: ContextSurfaceDescriptor;
  isActive: boolean;
  showActivityDot: boolean;
  label: string;
  description: string;
  orderNumber?: number | null;
  showOrderNumber?: boolean;
  onSelect: (surface: ContextSurfaceDescriptor) => void;
};

const ContextPanelRailItem: React.FC<RailItemProps> = ({
  surface,
  isActive,
  showActivityDot,
  label,
  description,
  orderNumber,
  showOrderNumber,
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
            {showActivityDot && !showOrderNumber ? (
              <span
                aria-hidden="true"
                className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--status-info)]"
              />
            ) : null}
            {showOrderNumber && orderNumber != null ? (
              <span
                aria-hidden="true"
                className="absolute right-0 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-surface-muted px-1 text-[0.625rem] font-medium leading-none text-muted-foreground"
              >
                {orderNumber === 10 ? '0' : orderNumber}
              </span>
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
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const planModeEnabled = useFeatureFlagsStore((state) => state.planModeEnabled);
  const { screenWidth } = useDeviceInfo();
  const gitStatus = useGitStatus(directoryKey || null);

  const surfaceSwitchPrefix = React.useMemo(
    () => getEffectiveShortcutPrefix('switch_context_surface', shortcutOverrides),
    [shortcutOverrides],
  );
  const [revealNumbers, setRevealNumbers] = React.useState(false);

  // While the surface-switch modifier is held for RAIL_NUMBER_HOLD_DELAY_MS,
  // reveal the order number badges so users can see which digit maps to which
  // rail icon. Releasing (or losing focus) dismisses them, and pressing a
  // number key while the chord is armed consumes them for this hold — they
  // only come back on the next press-and-hold.
  React.useEffect(() => {
    const held = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let consumedWhileHeld = false;

    const isDigitKey = (key: string) => key.length === 1 && key >= '0' && key <= '9';

    const update = () => {
      const armed = isShortcutPrefixHeld(surfaceSwitchPrefix, held);
      if (armed) {
        if (!consumedWhileHeld && timer === null) {
          timer = setTimeout(() => setRevealNumbers(true), RAIL_NUMBER_HOLD_DELAY_MS);
        }
      } else {
        consumedWhileHeld = false;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        setRevealNumbers(false);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      held.add(e.key.toLowerCase());
      if (isDigitKey(e.key) && isShortcutPrefixHeld(surfaceSwitchPrefix, held)) {
        consumedWhileHeld = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        setRevealNumbers(false);
        return;
      }
      update();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      held.delete(e.key.toLowerCase());
      update();
    };
    const onWindowBlur = () => {
      held.clear();
      consumedWhileHeld = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      setRevealNumbers(false);
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onWindowBlur);

    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onWindowBlur);
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [surfaceSwitchPrefix]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );

  const tabs = panelState?.tabs ?? EMPTY_TABS;
  const activeTab = tabs.find((tab) => tab.id === panelState?.activeTabId) ?? null;
  const activeMode = panelState?.isOpen ? activeTab?.mode ?? null : null;
  const changedFilesCount = gitStatus?.files.length ?? 0;

  const surfaces = React.useMemo(() => {
    return getVisibleContextRailSurfaces({
      railOrder: contextRailOrder,
      planModeEnabled,
      isVSCode: isVSCodeRuntime(),
      screenWidth,
      tabs,
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
          {surfaces.map((surface, index) => (
            <ContextPanelRailItem
              key={surface.id}
              surface={surface}
              isActive={activeMode === surface.mode}
              showActivityDot={surface.id === 'git' && changedFilesCount > 0}
              label={t(surface.labelKey)}
              description={t(surface.descriptionKey)}
              orderNumber={index + 1}
              showOrderNumber={revealNumbers}
              onSelect={(selected) => openContextSurface(directoryKey, selected.mode)}
            />
          ))}
        </SortableContext>
      </DndContext>
    </nav>
  );
};
