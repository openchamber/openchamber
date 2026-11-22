import { z } from 'zod';
import { isContextPanelMode, type ContextPanelMode } from '@/lib/surfaces/modes';

export type ContextZone = 'left' | 'right' | 'bottom';
type MovedContextZone = Exclude<ContextZone, 'right'>;

export const CONTEXT_ZONES: readonly ContextZone[] = ['left', 'right', 'bottom'];

export const CONTEXT_ZONE_DEFAULT_WIDTH = 640;

export type ContextZonePlacement = Partial<Record<ContextPanelMode, MovedContextZone>>;

export type ContextZoneView = {
  isOpen: boolean;
  expanded: boolean;
  activeTabId: string | null;
};

export const CLOSED_ZONE_VIEW: ContextZoneView = { isOpen: false, expanded: false, activeTabId: null };

export type MovedZoneViews = { left: ContextZoneView; bottom: ContextZoneView };

type ZonedTab = { id: string; mode: ContextPanelMode; touchedAt: number };

export type ZonedPanel<T extends ZonedTab = ZonedTab> = ContextZoneView & {
  tabs: readonly T[];
  zones: MovedZoneViews;
};

export const zoneOfMode = (placement: ContextZonePlacement, mode: ContextPanelMode): ContextZone =>
  placement[mode] ?? 'right';

export const getZoneView = (panel: ZonedPanel, zone: ContextZone): ContextZoneView => (
  zone === 'right'
    ? { isOpen: panel.isOpen, expanded: panel.expanded, activeTabId: panel.activeTabId }
    : panel.zones[zone]
);

export const withZoneView = <P extends ZonedPanel>(panel: P, zone: ContextZone, patch: Partial<ContextZoneView>): P => (
  zone === 'right'
    ? { ...panel, ...patch }
    : { ...panel, zones: { ...panel.zones, [zone]: { ...panel.zones[zone], ...patch } } }
);

const tabsInZone = <T extends ZonedTab>(tabs: readonly T[], placement: ContextZonePlacement, zone: ContextZone): T[] =>
  tabs.filter((tab) => zoneOfMode(placement, tab.mode) === zone);

export const resolveZoneActiveTabId = (
  tabs: readonly ZonedTab[],
  placement: ContextZonePlacement,
  zone: ContextZone,
  activeTabId: string | null,
): string | null => {
  const zoneTabs = tabsInZone(tabs, placement, zone);
  if (activeTabId && zoneTabs.some((tab) => tab.id === activeTabId)) return activeTabId;
  return zoneTabs.at(-1)?.id ?? null;
};

export const resolveZoneActiveTab = <T extends ZonedTab>(
  panel: ZonedPanel<T>,
  placement: ContextZonePlacement,
  zone: ContextZone,
): T | null => {
  const id = resolveZoneActiveTabId(panel.tabs, placement, zone, getZoneView(panel, zone).activeTabId);
  return id ? panel.tabs.find((tab) => tab.id === id) ?? null : null;
};

export const isZoneShown = (panel: ZonedPanel | undefined, placement: ContextZonePlacement, zone: ContextZone): boolean => (
  Boolean(panel && getZoneView(panel, zone).isOpen && resolveZoneActiveTab(panel, placement, zone))
);

export const canZoneExpand = (
  panel: ZonedPanel<ZonedTab & { targetPath?: string | null }> | undefined,
  view: { contextSurfaceZones: ContextZonePlacement; contextEditorVisible: boolean; contextEditorTreeVisible: boolean },
  zone: ContextZone,
): boolean => {
  const tab = panel && isZoneShown(panel, view.contextSurfaceZones, zone)
    ? resolveZoneActiveTab(panel, view.contextSurfaceZones, zone)
    : null;
  if (!panel || !tab) return false;
  if (zone === 'bottom' || tab.mode !== 'file') return true;
  return panel.tabs.some((entry) => entry.mode === 'file' && entry.targetPath)
    && (view.contextEditorVisible || !view.contextEditorTreeVisible);
};

type SideZoneSizing = {
  contextZoneSizes: Partial<Record<ContextZone, number>>;
  contextEditorVisible: boolean;
  contextEditorTreeVisible: boolean;
  contextEditorTreeWidth: number;
};

type SizedTab = ZonedTab & { targetPath?: string | null };

export const showsFileTreeOnly = (panel: ZonedPanel<SizedTab>, tab: SizedTab, sizing: SideZoneSizing): boolean => {
  if (tab.mode !== 'file') return false;
  const editorShown = panel.tabs.some((entry) => entry.mode === 'file' && entry.targetPath)
    && (sizing.contextEditorVisible || !sizing.contextEditorTreeVisible);
  return !editorShown;
};

export const sideZoneWidth = (
  panel: ZonedPanel<SizedTab>,
  tab: SizedTab,
  side: Exclude<ContextZone, 'bottom'>,
  sizing: SideZoneSizing,
): number => (
  showsFileTreeOnly(panel, tab, sizing)
    ? sizing.contextEditorTreeWidth
    : sizing.contextZoneSizes[side] ?? CONTEXT_ZONE_DEFAULT_WIDTH
);

export const shownContextModes = (panel: ZonedPanel | undefined, placement: ContextZonePlacement): Set<ContextPanelMode> => {
  const modes = new Set<ContextPanelMode>();
  if (!panel) return modes;
  for (const zone of CONTEXT_ZONES) {
    if (!getZoneView(panel, zone).isOpen) continue;
    const tab = resolveZoneActiveTab(panel, placement, zone);
    if (tab) modes.add(tab.mode);
  }
  return modes;
};

export const settleZones = <P extends ZonedPanel>(panel: P, placement: ContextZonePlacement): P => {
  let next = panel;
  for (const zone of CONTEXT_ZONES) {
    const view = getZoneView(next, zone);
    const activeTabId = resolveZoneActiveTabId(next.tabs, placement, zone, view.activeTabId);
    const isOpen = view.isOpen && activeTabId !== null;
    const expanded = view.expanded && isOpen;
    if (activeTabId !== view.activeTabId || isOpen !== view.isOpen || expanded !== view.expanded) {
      next = withZoneView(next, zone, { activeTabId, isOpen, expanded });
    }
  }
  return next;
};

export const carrySurfaceToZone = <P extends ZonedPanel>(
  panel: P,
  mode: ContextPanelMode,
  from: ContextZone,
  to: ContextZone,
  placementAfter: ContextZonePlacement,
): P => {
  if (from === to) return panel;
  const source = getZoneView(panel, from);
  const sourceTab = source.activeTabId ? panel.tabs.find((tab) => tab.id === source.activeTabId) : undefined;
  const surfaceWasShown = source.isOpen && sourceTab?.mode === mode;
  let next = panel;
  if (surfaceWasShown && sourceTab) {
    next = withZoneView(next, from, { isOpen: false, expanded: false });
    next = withZoneView(next, to, { isOpen: true, expanded: false, activeTabId: sourceTab.id });
  }
  return settleZones(next, placementAfter);
};

const movedZoneSchema = z.enum(['left', 'bottom']);

export const zonePlacementSchema = z.record(z.string(), z.unknown()).catch({}).transform((record) => (
  Object.fromEntries(Object.entries(record).flatMap(([mode, zone]) => {
    const parsed = movedZoneSchema.safeParse(zone);
    return isContextPanelMode(mode) && parsed.success ? [[mode, parsed.data]] : [];
  }))
));

const zoneViewSchema = z.object({
  isOpen: z.boolean().catch(false),
  expanded: z.boolean().catch(false),
  activeTabId: z.string().nullable().catch(null),
}).catch(CLOSED_ZONE_VIEW);

export const zoneViewsSchema = z.object({
  left: zoneViewSchema.default(CLOSED_ZONE_VIEW),
  bottom: zoneViewSchema.default(CLOSED_ZONE_VIEW),
}).catch({ left: CLOSED_ZONE_VIEW, bottom: CLOSED_ZONE_VIEW });

export const keepZoneViewsOnTabs = (views: MovedZoneViews, tabIds: ReadonlySet<string>): MovedZoneViews => {
  const keep = (view: ContextZoneView): ContextZoneView => {
    const activeTabId = view.activeTabId && tabIds.has(view.activeTabId) ? view.activeTabId : null;
    return { isOpen: view.isOpen && activeTabId !== null, expanded: view.expanded && view.isOpen && activeTabId !== null, activeTabId };
  };
  return { left: keep(views.left), bottom: keep(views.bottom) };
};
