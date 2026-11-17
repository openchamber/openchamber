import React from 'react';
import { ScrollShadow, ScrollShadowBands } from '@/components/ui/ScrollShadow';
import { hasReceivedPages, useReceivedPages } from '@/components/chat/sharePages/received/receivedPagesStore';
import { TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useDraftSpaceTarget } from '@/lib/spaces/useDraftSpaceTarget';
import { panelContentDirectory } from '@/lib/spaces/space-creation-requests';
import { useDeviceInfo } from '@/lib/device';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import {
  contextSurfaceGroup,
  getVisibleContextRailSurfaces,
  sortContextSurfaces,
  type ContextSurfaceDescriptor,
} from '@/lib/surfaces/registry';
import {
  formatShortcutForDisplay,
  getEffectiveShortcutCombo,
  getEffectiveShortcutPrefix,
  isShortcutPrefixHeld,
  UNASSIGNED_SHORTCUT,
} from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { useEffectiveGitDirectory, useGitStatus, useGitStore } from '@/stores/useGitStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { normalizePath } from '@/lib/pathNormalization';
import { sessionEvents } from '@/lib/sessionEvents';
import { getSourceControlAuthKey, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { useSourceControlProvider, useSourceControlProviders } from '@/lib/source-control/providers/registry';
import type { SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';
import { PROVIDER_FALLBACK_ICON, providerIconSrc, providerSpriteName } from '@/components/sourceControl/providerIconSprite';
import { useRepositoryHostProvider } from '@/components/references/referenceSources';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { useGuestSurfaces } from '@/hooks/useGuestSurfaces';
import { useGuestBadgeStore } from '@/lib/guests/badge-store';
import { useGuestListeningStore } from '@/lib/guests/microphone';
import { isPluginContextPanelMode, pluginIdFromMode } from '@/lib/surfaces/modes';
import { shownContextModes, zoneOfMode } from '@/lib/workspace/zones';
import { ContextRailSurfacesDialog } from './ContextRailSurfacesDialog';
import { ContextRailTooltipDetails } from './ContextRailUsage';
import { ZoneMoveMenuItems } from './ZoneMoveMenuItems';
import { startZoneDragGesture, type ZoneDragGesture } from './zoneDrag';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { useWorkflowsSurfaceShown } from '@/lib/workflows/panel';

const RAIL_TOOLTIP_DELAY_MS = 150;
const RAIL_SCROLL_FADE_PX = 24;
const RAIL_NUMBER_HOLD_DELAY_MS = 500;
const EMPTY_TABS: never[] = [];

type RailItemProps = {
  surface: ContextSurfaceDescriptor;
  isActive: boolean;
  showActivityDot: boolean;
  label: string;
  description: string;
  badgeCount?: number | null;
  badgeAriaLabel?: string | null;
  badgeDescription?: string | null;
  listening?: boolean;
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
  badgeCount,
  badgeAriaLabel,
  badgeDescription,
  listening = false,
  orderNumber,
  showOrderNumber,
  onSelect,
}) => {
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const surfacePrefix = getEffectiveShortcutPrefix('switch_context_surface', shortcutOverrides);
  const surfaceShortcut = surfacePrefix && surfacePrefix !== UNASSIGNED_SHORTCUT && orderNumber != null && orderNumber <= 10
    ? formatShortcutForDisplay(`${surfacePrefix}+${orderNumber === 10 ? '0' : orderNumber}`)
    : undefined;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: surface.id,
  });

  const hasBadge = badgeCount != null && badgeCount > 0;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('relative', isDragging && 'z-10 opacity-70')}
    >
    <ContextMenu>
    <ContextMenuTrigger render={<div />}>
      <Tooltip delayDuration={RAIL_TOOLTIP_DELAY_MS}>
        <TooltipTrigger asChild>
          <button
            type="button"
            {...attributes}
            {...listeners}
            onClick={() => onSelect(surface)}
            aria-label={badgeAriaLabel ?? label}
            aria-pressed={isActive}
            data-context-surface={surface.id}
            className={cn(
              'flex h-7 w-7 touch-none select-none items-center justify-center rounded-md transition-colors',
              isActive
                ? 'oc-selected text-interactive-selection-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <GuestIcon
              icon={surface.icon}
              iconSrc={surface.iconSrc}
              className="h-[17px] w-[17px]"
            />
            {showOrderNumber && orderNumber != null ? (
              <span
                aria-hidden="true"
                className="absolute inset-e-0 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-surface-muted px-1 text-[0.625rem] font-medium leading-none text-muted-foreground"
              >
                {orderNumber === 10 ? '0' : orderNumber}
              </span>
            ) : listening ? (
              <span
                aria-hidden="true"
                className="absolute inset-e-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--status-error)]"
              />
            ) : hasBadge ? (
              <span
                aria-hidden="true"
                className="absolute inset-e-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--status-info)]"
              />
            ) : showActivityDot ? (
              <span
                aria-hidden="true"
                className="absolute inset-e-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--status-info)]"
              />
            ) : null}
          </button>
        </TooltipTrigger>
        <TooltipContent side="left" sideOffset={8} className="max-w-72 break-words">
          <div className="flex flex-col gap-0.5">
            <TooltipLabelWithShortcut label={label} shortcut={surface.id === 'terminal' ? formatShortcutForDisplay(getEffectiveShortcutCombo('toggle_terminal', shortcutOverrides), '') : surfaceShortcut} />
            <span className="typography-micro text-muted-foreground">{description}</span>
            {badgeDescription ? (
              <span className="typography-micro text-muted-foreground">{badgeDescription}</span>
            ) : null}
            {surface.id === 'context' ? <ContextRailTooltipDetails /> : null}
          </div>
        </TooltipContent>
      </Tooltip>
    </ContextMenuTrigger>
    <ContextMenuContent>
      <ZoneMoveMenuItems mode={surface.mode} />
    </ContextMenuContent>
    </ContextMenu>
    </div>
  );
};

type RailIcon = { icon: IconName; iconSrc?: string };

const trackerRailIcon = (descriptor: SourceControlProviderDescriptor | null): RailIcon => {
  if (!descriptor) return { icon: 'ticket-2' };
  const sprite = providerSpriteName(descriptor, 'line');
  return sprite ? { icon: sprite } : { icon: PROVIDER_FALLBACK_ICON, iconSrc: providerIconSrc(descriptor) };
};

export const ContextPanelRail: React.FC = () => {
  const { t } = useI18n();
  const effectiveDirectory = useEffectiveDirectory();
  const directoryKey = effectiveDirectory ? normalizeContextPanelDirectoryKey(effectiveDirectory) : '';

  const panelState = useUIStore((state) => (directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined));
  const workStatusPanelVisible = useUIStore((state) => state.workStatusPanelVisible);
  const contextRailOrder = useUIStore((state) => state.contextRailOrder);
  const contextRailHiddenSurfaces = useUIStore((state) => state.contextRailHiddenSurfaces);
  const setContextRailOrder = useUIStore((state) => state.setContextRailOrder);
  const openContextSurface = useUIStore((state) => state.openContextSurface);
  const closeContextZone = useUIStore((state) => state.closeContextZone);
  const contextSurfaceZones = useUIStore((state) => state.contextSurfaceZones);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const providers = useSourceControlProviders();
  const defaultInstanceAuthChecked = useSourceControlAuthStore((state) => providers.some((descriptor) => (
    descriptor.instances.defaultInstance !== null
    && state.entries[getSourceControlAuthKey({ provider: descriptor.id, instance: descriptor.instances.defaultInstance })]?.hasChecked === true
  )));
  const sourceControlConnected = useSourceControlAuthStore((state) => Object.values(state.entries)
    .some((entry) => entry.status?.status === 'connected'));
  const repositoryProvider = useRepositoryHostProvider(directoryKey || null);
  const trackerDescriptor = useSourceControlProvider(repositoryProvider === 'none' ? null : repositoryProvider ?? providers[0]?.id);
  const changeRequestTerm = repositoryProvider === 'none' ? 'pullRequest' : trackerDescriptor.terminology.changeRequest;
  const { screenWidth } = useDeviceInfo();
  const gitRoot = panelContentDirectory(useDraftSpaceTarget(), effectiveDirectory ?? null);
  const gitDirectory = useEffectiveGitDirectory(gitRoot);
  const gitStatus = useGitStatus(gitDirectory);
  const { git } = useRuntimeAPIs();
  const ensureGitStatus = useGitStore((state) => state.ensureStatus);
  const fetchGitStatus = useGitStore((state) => state.fetchStatus);
  React.useEffect(() => {
    if (!git || !gitRoot || !gitDirectory || gitDirectory === gitRoot) return;
    void runBackgroundNetworkTask(() => ensureGitStatus(gitDirectory, git));
    const root = normalizePath(gitRoot);
    const repository = normalizePath(gitDirectory);
    return sessionEvents.onGitRefreshHint((hint) => {
      const hinted = normalizePath(hint.directory);
      if (hinted !== root && hinted !== repository) return;
      void runBackgroundNetworkTask(() => fetchGitStatus(gitDirectory, git, { silent: true }));
    });
  }, [ensureGitStatus, fetchGitStatus, git, gitDirectory, gitRoot]);

  const surfaceSwitchPrefix = React.useMemo(
    () => getEffectiveShortcutPrefix('switch_context_surface', shortcutOverrides),
    [shortcutOverrides],
  );
  const [revealNumbers, setRevealNumbers] = React.useState(false);

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

  const guestSurfaces = useGuestSurfaces();
  const guestBadges = useGuestBadgeStore((state) => state.countByGuest);
  const guestListening = useGuestListeningStore((state) => state.captureCountByGuest);
  const clearGuestBadge = useGuestBadgeStore((state) => state.clearBadge);
  const tabs = panelState?.tabs ?? EMPTY_TABS;
  const workflowsShown = useWorkflowsSurfaceShown(tabs, effectiveDirectory || null);
  const receivedPagesShown = hasReceivedPages(useReceivedPages());
  const shownModes = React.useMemo(
    () => shownContextModes(panelState, contextSurfaceZones),
    [contextSurfaceZones, panelState],
  );
  const changedFilesCount = gitStatus?.files.length ?? 0;

  const surfaces = React.useMemo(() => {
    return getVisibleContextRailSurfaces({
      railOrder: contextRailOrder,
      hiddenSurfaces: contextRailHiddenSurfaces,
      isVSCode: isVSCodeRuntime(),
      screenWidth,
      tabs,
      sourceControlConnected,
      workflowsShown,
      receivedPagesShown,
      extras: guestSurfaces,
    }).map((surface) => (surface.id === 'pr' ? { ...surface, ...trackerRailIcon(repositoryProvider === 'none' ? null : trackerDescriptor) } : surface));
  }, [contextRailHiddenSurfaces, contextRailOrder, guestSurfaces, receivedPagesShown, repositoryProvider, screenWidth, sourceControlConnected, tabs, trackerDescriptor, workflowsShown]);

  const hasTrackerItems = tabs.some((tab) => tab.mode === 'pr' && tab.targetPath);
  React.useEffect(() => {
    if (!directoryKey || !defaultInstanceAuthChecked || sourceControlConnected || hasTrackerItems || !shownModes.has('pr')) {
      return;
    }
    closeContextZone(directoryKey, zoneOfMode(contextSurfaceZones, 'pr'));
  }, [closeContextZone, contextSurfaceZones, directoryKey, defaultInstanceAuthChecked, hasTrackerItems, shownModes, sourceControlConnected]);

  const [isSurfacesDialogOpen, setIsSurfacesDialogOpen] = React.useState(false);

  const railRef = React.useRef<HTMLElement | null>(null);
  const zoneGestureRef = React.useRef<ZoneDragGesture | null>(null);
  const handleDragStart = React.useCallback((event: DragStartEvent) => {
    const surface = surfaces.find((entry) => entry.id === event.active.id);
    const railLeft = railRef.current?.getBoundingClientRect().left;
    if (!surface || railLeft === undefined) return;
    zoneGestureRef.current?.cancel();
    zoneGestureRef.current = startZoneDragGesture({
      mode: surface.mode,
      label: surface.label ?? t(changeRequestCopy(surface.labelKey, changeRequestTerm)),
      from: zoneOfMode(useUIStore.getState().contextSurfaceZones, surface.mode),
    }, (point) => point.x < railLeft - 16);
  }, [changeRequestTerm, surfaces, t]);
  const handleDragCancel = React.useCallback(() => {
    zoneGestureRef.current?.cancel();
    zoneGestureRef.current = null;
  }, []);
  React.useEffect(() => () => zoneGestureRef.current?.cancel(), []);

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    const gesture = zoneGestureRef.current;
    zoneGestureRef.current = null;
    if (gesture?.finish(directoryKey)) {
      return;
    }

    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    const ordered = sortContextSurfaces(useUIStore.getState().contextRailOrder, guestSurfaces);
    const groupOf = (id: string | number) => {
      const surface = ordered.find((entry) => entry.id === id);
      return surface ? contextSurfaceGroup(surface) : null;
    };
    if (groupOf(active.id) !== groupOf(over.id)) {
      return;
    }
    const orderedIds = ordered.map((surface) => surface.id);
    const fromIndex = orderedIds.indexOf(active.id as (typeof orderedIds)[number]);
    const toIndex = orderedIds.indexOf(over.id as (typeof orderedIds)[number]);
    if (fromIndex === -1 || toIndex === -1) {
      return;
    }

    setContextRailOrder(arrayMove(orderedIds, fromIndex, toIndex));
  }, [directoryKey, guestSurfaces, setContextRailOrder]);

  const groups = React.useMemo(() => {
    const runs: ContextSurfaceDescriptor[][] = [];
    for (const surface of surfaces) {
      const last = runs.at(-1);
      if (last && contextSurfaceGroup(last[0]) === contextSurfaceGroup(surface)) last.push(surface);
      else runs.push([surface]);
    }
    return runs;
  }, [surfaces]);
  const collisionDetection = React.useCallback<CollisionDetection>((args) => {
    const activeSurface = surfaces.find((surface) => surface.id === args.active.id);
    if (!activeSurface) return closestCenter(args);
    const activeGroup = contextSurfaceGroup(activeSurface);
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter((container) => {
        const surface = surfaces.find((entry) => entry.id === container.id);
        return surface !== undefined && contextSurfaceGroup(surface) === activeGroup;
      }),
    });
  }, [surfaces]);

  if (!directoryKey) {
    return null;
  }

  let orderNumber = 0;

  return (
    <nav
      ref={railRef}
      aria-label={t('contextRail.aria.rail')}
      className="flex h-full w-11 flex-shrink-0 flex-col items-center gap-2 bg-background pb-2"
    >
      <div className="relative flex min-h-0 w-full flex-1 flex-col">
      <ScrollShadow
        surface="var(--background)"
        size={RAIL_SCROLL_FADE_PX}
        className="scrollbar-none flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto overflow-x-hidden pt-2"
      >
      <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragStart={handleDragStart} onDragCancel={handleDragCancel} onDragEnd={handleDragEnd}>
        {groups.map((group, groupIndex) => (
          <React.Fragment key={contextSurfaceGroup(group[0])}>
          {groupIndex > 0 ? <div aria-hidden="true" className="h-1.5 shrink-0" /> : null}
          <SortableContext items={group.map((surface) => surface.id)} strategy={verticalListSortingStrategy}>
          {group.map((surface) => {
            orderNumber += 1;
            const label = surface.label ?? t(changeRequestCopy(surface.labelKey, changeRequestTerm));
            const gitChangedCount = surface.id === 'git' && !workStatusPanelVisible ? changedFilesCount : 0;
            const guestBadgeCount = isPluginContextPanelMode(surface.mode) && !shownModes.has(surface.mode)
              ? guestBadges[pluginIdFromMode(surface.mode)] ?? 0
              : 0;
            const badgeCount = gitChangedCount > 0 ? gitChangedCount : guestBadgeCount > 0 ? guestBadgeCount : null;
            const isGuestBadge = badgeCount !== null && gitChangedCount === 0;
            const listening = isPluginContextPanelMode(surface.mode) && (guestListening[pluginIdFromMode(surface.mode)] ?? 0) > 0;
            return (
              <ContextPanelRailItem
                key={surface.id}
                surface={surface}
                isActive={shownModes.has(surface.mode)}
                showActivityDot={false}
                label={label}
                description={t(changeRequestCopy(surface.descriptionKey, changeRequestTerm))}
                badgeCount={badgeCount}
                listening={listening}
                badgeAriaLabel={listening
                  ? t('contextRail.surface.plugin.listeningAria', { label })
                  : badgeCount !== null
                  ? t(
                      isGuestBadge
                        ? (badgeCount === 1 ? 'contextRail.surface.plugin.badgeAriaSingle' : 'contextRail.surface.plugin.badgeAriaPlural')
                        : (badgeCount === 1 ? 'contextRail.surface.git.changesCountAriaSingle' : 'contextRail.surface.git.changesCountAriaPlural'),
                      { label, count: badgeCount },
                    )
                  : null}
                badgeDescription={listening
                  ? t('contextRail.surface.plugin.listeningTooltip')
                  : badgeCount !== null
                  ? t(
                      isGuestBadge
                        ? (badgeCount === 1 ? 'contextRail.surface.plugin.badgeTooltipSingle' : 'contextRail.surface.plugin.badgeTooltipPlural')
                        : (badgeCount === 1 ? 'contextRail.surface.git.changesCountTooltipSingle' : 'contextRail.surface.git.changesCountTooltipPlural'),
                      { count: badgeCount },
                    )
                  : null}
                orderNumber={orderNumber}
                showOrderNumber={revealNumbers}
                onSelect={(selected) => {
                  if (isPluginContextPanelMode(selected.mode)) clearGuestBadge(pluginIdFromMode(selected.mode));
                  openContextSurface(directoryKey, selected.mode);
                }}
              />
            );
          })}
          </SortableContext>
          </React.Fragment>
        ))}
      </DndContext>
      </ScrollShadow>
      <ScrollShadowBands surface="var(--background)" size={RAIL_SCROLL_FADE_PX} />
      </div>
      <Tooltip delayDuration={RAIL_TOOLTIP_DELAY_MS}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t('contextRail.configure.open')}
            onClick={() => setIsSurfacesDialogOpen(true)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
          >
            <Icon name="list-settings" className="h-[17px] w-[17px]" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="left" sideOffset={8}>
          {t('contextRail.configure.open')}
        </TooltipContent>
      </Tooltip>
      <ContextRailSurfacesDialog open={isSurfacesDialogOpen} onOpenChange={setIsSurfacesDialogOpen} />
    </nav>
  );
};
