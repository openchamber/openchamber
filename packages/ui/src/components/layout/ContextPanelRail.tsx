import React from 'react';
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
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
import { DiffViewIcon } from '@/components/icons/DiffIcon';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useDraftSpaceTarget } from '@/lib/spaces/useDraftSpaceTarget';
import { panelContentDirectory } from '@/lib/spaces/space-creation-requests';
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
import { isPluginContextPanelMode, pluginIdFromMode } from '@/lib/surfaces/modes';
import { shownContextModes, zoneOfMode } from '@/lib/workspace/zones';
import { ContextRailSurfacesDialog } from './ContextRailSurfacesDialog';
import { ContextRailTooltipDetails, ContextUsageRingIcon } from './ContextRailUsage';
import { ZoneMoveMenuItems } from './ZoneMoveMenuItems';
import { startZoneDragGesture, type ZoneDragGesture } from './zoneDrag';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';

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
  /** Numeric badge (e.g. the Git changed-files count); takes precedence over the activity dot. */
  badgeCount?: number | null;
  /** Accessible label that includes the badge count; falls back to `label`. */
  badgeAriaLabel?: string | null;
  /** Extra tooltip line describing the badge; rendered under the description. */
  badgeDescription?: string | null;
  orderNumber?: number | null;
  showOrderNumber?: boolean;
  onSelect: (surface: ContextSurfaceDescriptor) => void;
};

// The badge corner is 16px tall; cap large counts so the pill stays compact
// on the 36px rail button (matching the order-number badge's footprint).
const formatRailBadgeCount = (count: number): string => (count > 99 ? '99+' : String(count));

const ContextPanelRailItem: React.FC<RailItemProps> = ({
  surface,
  isActive,
  showActivityDot,
  label,
  description,
  badgeCount,
  badgeAriaLabel,
  badgeDescription,
  orderNumber,
  showOrderNumber,
  onSelect,
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: surface.id,
  });

  const displayBadgeCount = badgeCount != null && badgeCount > 0 ? formatRailBadgeCount(badgeCount) : null;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('relative', isDragging && 'z-10 opacity-70')}
    >
    {/* Right-click moves the surface to another zone around the chat. */}
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
                ? 'text-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {surface.id === 'diff' ? (
              <DiffViewIcon className="h-[18px] w-[18px]" />
            ) : surface.id === 'context' ? (
              <ContextUsageRingIcon className="h-[18px] w-[18px]" />
            ) : (
              <GuestIcon
                icon={surface.icon}
                iconSrc={surface.iconSrc}
                className="h-[18px] w-[18px]"
              />
            )}
            {showOrderNumber && orderNumber != null ? (
              <span
                aria-hidden="true"
                className="absolute inset-e-0 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-surface-muted px-1 text-[0.625rem] font-medium leading-none text-muted-foreground"
              >
                {orderNumber === 10 ? '0' : orderNumber}
              </span>
            ) : displayBadgeCount ? (
              <span
                aria-hidden="true"
                // Muted digits on the muted surface sat at almost the same
                // luminance as the glyph they overlap. The count is a live
                // signal, so it takes the info tone on its own opaque chip.
                className="absolute -inset-e-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.625rem] font-semibold leading-none"
                style={{
                  backgroundColor: 'var(--status-info-background)',
                  color: 'var(--status-info)',
                }}
              >
                {displayBadgeCount}
              </span>
            ) : showActivityDot ? (
              <span
                aria-hidden="true"
                className="absolute inset-e-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--status-info)]"
              />
            ) : null}
          </button>
        </TooltipTrigger>
        {/* Descriptions run long, and extensions bring their own: cap the
            width so they wrap instead of stretching across the chat. */}
        <TooltipContent side="left" sideOffset={8} className="max-w-72 break-words">
          <div className="flex flex-col gap-0.5">
            <span>{label}</span>
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

// The Tracker wears the project's host: its provider's sprite icon, else the
// mark it serves as an icon URL. With no host it holds tracker items and the like.
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
  // Whether any provider's default instance (github.com, gitlab.com) has answered an auth check.
  const defaultInstanceAuthChecked = useSourceControlAuthStore((state) => providers.some((descriptor) => (
    descriptor.instances.defaultInstance !== null
    && state.entries[getSourceControlAuthKey({ provider: descriptor.id, instance: descriptor.instances.defaultInstance })]?.hasChecked === true
  )));
  // Change requests come from GitHub or GitLab, whichever the project lives on,
  // so the surface is there when either kind of account is connected.
  const sourceControlConnected = useSourceControlAuthStore((state) => Object.values(state.entries)
    .some((entry) => entry.status?.status === 'connected'));
  const repositoryProvider = useRepositoryHostProvider(directoryKey || null);
  // Until the project's host is known the rail reads as the first provider, as it did before hosts were read.
  const trackerDescriptor = useSourceControlProvider(repositoryProvider === 'none' ? null : repositoryProvider ?? providers[0]?.id);
  const changeRequestTerm = repositoryProvider === 'none' ? 'pullRequest' : trackerDescriptor.terminology.changeRequest;
  const { screenWidth } = useDeviceInfo();
  // The Git badge counts what the Git panel shows: for a draft waiting for a new space, the space's changes;
  // for a folder holding repositories, the repository picked in the panel. Same root as GitView, so the
  // nested selection it stored is found under the same key.
  const gitRoot = panelContentDirectory(useDraftSpaceTarget(), effectiveDirectory ?? null);
  const gitDirectory = useEffectiveGitDirectory(gitRoot);
  const gitStatus = useGitStatus(gitDirectory);
  const { git } = useRuntimeAPIs();
  const ensureGitStatus = useGitStore((state) => state.ensureStatus);
  const fetchGitStatus = useGitStore((state) => state.fetchStatus);
  // The chat keeps the root's status warm and fresh; a remembered nested repository has nobody
  // reading it until its panel opens, so the badge reads it itself: once, and again on each
  // refresh hint. Hints from agent tools carry the session directory, which is the root here.
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

  const guestSurfaces = useGuestSurfaces();
  const guestBadges = useGuestBadgeStore((state) => state.countByGuest);
  const clearGuestBadge = useGuestBadgeStore((state) => state.clearBadge);
  const tabs = panelState?.tabs ?? EMPTY_TABS;
  // One surface per open zone is on screen; each lights its rail icon.
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
      extras: guestSurfaces,
    }).map((surface) => (surface.id === 'pr' ? { ...surface, ...trackerRailIcon(repositoryProvider === 'none' ? null : trackerDescriptor) } : surface));
  }, [contextRailHiddenSurfaces, contextRailOrder, guestSurfaces, repositoryProvider, screenWidth, sourceControlConnected, tabs, trackerDescriptor]);

  // A surface whose integration disconnected closes rather than lingering as
  // an active panel with no rail icon.
  const hasTrackerItems = tabs.some((tab) => tab.mode === 'pr' && tab.targetPath);
  React.useEffect(() => {
    if (!directoryKey || !defaultInstanceAuthChecked || sourceControlConnected || hasTrackerItems || !shownModes.has('pr')) {
      return;
    }
    closeContextZone(directoryKey, zoneOfMode(contextSurfaceZones, 'pr'));
  }, [closeContextZone, contextSurfaceZones, directoryKey, defaultInstanceAuthChecked, hasTrackerItems, shownModes, sourceControlConnected]);

  const [isSurfacesDialogOpen, setIsSurfacesDialogOpen] = React.useState(false);

  // An icon dragged out of the rail toward the workspace moves its surface
  // to a zone instead of reordering the rail (zoneDrag.ts).
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

    const orderedIds = sortContextSurfaces(useUIStore.getState().contextRailOrder, guestSurfaces).map((surface) => surface.id);
    const fromIndex = orderedIds.indexOf(active.id as (typeof orderedIds)[number]);
    const toIndex = orderedIds.indexOf(over.id as (typeof orderedIds)[number]);
    if (fromIndex === -1 || toIndex === -1) {
      return;
    }

    setContextRailOrder(arrayMove(orderedIds, fromIndex, toIndex));
  }, [directoryKey, guestSurfaces, setContextRailOrder]);

  if (!directoryKey) {
    return null;
  }

  return (
    <nav
      ref={railRef}
      aria-label={t('contextRail.aria.rail')}
      className="flex h-full w-11 flex-shrink-0 flex-col items-center gap-2 bg-background py-2"
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragCancel={handleDragCancel} onDragEnd={handleDragEnd}>
        <SortableContext items={surfaces.map((surface) => surface.id)} strategy={verticalListSortingStrategy}>
          {surfaces.map((surface, index) => {
            const label = surface.label ?? t(changeRequestCopy(surface.labelKey, changeRequestTerm));
            // Git shows a numeric badge instead of the old activity dot.
            // Other surfaces never inherit git's changed-files signal.
            // The work-status panel reports the same count in words a few
            // pixels away; two live counts for one fact is one too many.
            const gitChangedCount = surface.id === 'git' && !workStatusPanelVisible ? changedFilesCount : 0;
            // A guest sets its own count through `host.setBadge`; opening
            // that panel clears it, so the active surface never shows one.
            const guestBadgeCount = isPluginContextPanelMode(surface.mode) && !shownModes.has(surface.mode)
              ? guestBadges[pluginIdFromMode(surface.mode)] ?? 0
              : 0;
            const badgeCount = gitChangedCount > 0 ? gitChangedCount : guestBadgeCount > 0 ? guestBadgeCount : null;
            const isGuestBadge = badgeCount !== null && gitChangedCount === 0;
            return (
              <ContextPanelRailItem
                key={surface.id}
                surface={surface}
                isActive={shownModes.has(surface.mode)}
                showActivityDot={false}
                label={label}
                description={t(changeRequestCopy(surface.descriptionKey, changeRequestTerm))}
                badgeCount={badgeCount}
                badgeAriaLabel={badgeCount !== null
                  ? t(
                      isGuestBadge
                        ? (badgeCount === 1 ? 'contextRail.surface.plugin.badgeAriaSingle' : 'contextRail.surface.plugin.badgeAriaPlural')
                        : (badgeCount === 1 ? 'contextRail.surface.git.changesCountAriaSingle' : 'contextRail.surface.git.changesCountAriaPlural'),
                      { label, count: badgeCount },
                    )
                  : null}
                badgeDescription={badgeCount !== null
                  ? t(
                      isGuestBadge
                        ? (badgeCount === 1 ? 'contextRail.surface.plugin.badgeTooltipSingle' : 'contextRail.surface.plugin.badgeTooltipPlural')
                        : (badgeCount === 1 ? 'contextRail.surface.git.changesCountTooltipSingle' : 'contextRail.surface.git.changesCountTooltipPlural'),
                      { count: badgeCount },
                    )
                  : null}
                orderNumber={index + 1}
                showOrderNumber={revealNumbers}
                onSelect={(selected) => {
                  if (isPluginContextPanelMode(selected.mode)) clearGuestBadge(pluginIdFromMode(selected.mode));
                  openContextSurface(directoryKey, selected.mode);
                }}
              />
            );
          })}
        </SortableContext>
      </DndContext>
      {/* Outside the sortable list on purpose: this button takes no digit,
          cannot be dragged, and configures the rail rather than living on it. */}
      <Tooltip delayDuration={RAIL_TOOLTIP_DELAY_MS}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t('contextRail.configure.open')}
            onClick={() => setIsSurfacesDialogOpen(true)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            <Icon name="equalizer-2" className="h-[18px] w-[18px]" />
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
