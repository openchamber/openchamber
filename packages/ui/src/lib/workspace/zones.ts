import { z } from 'zod';
import { isContextPanelMode, type ContextPanelMode } from '@/lib/surfaces/modes';

/**
 * Where a context surface opens around the chat. The chat is always the
 * centre and takes the remaining space; every other surface lives in one of
 * three zones. `right` is the context panel everyone has today, so it is the
 * default and is never stored.
 */
export type ContextZone = 'left' | 'right' | 'bottom';
type MovedContextZone = Exclude<ContextZone, 'right'>;

export const CONTEXT_ZONES: readonly ContextZone[] = ['left', 'right', 'bottom'];

/** Surface mode -> zone, for surfaces moved off the right. Per device. */
export type ContextZonePlacement = Partial<Record<ContextPanelMode, MovedContextZone>>;

/** What one zone shows: open or not, expanded over the chat, and its tab. */
export type ContextZoneView = {
  isOpen: boolean;
  expanded: boolean;
  activeTabId: string | null;
};

export const CLOSED_ZONE_VIEW: ContextZoneView = { isOpen: false, expanded: false, activeTabId: null };

/** The left and bottom zones of one project's panel. */
export type MovedZoneViews = { left: ContextZoneView; bottom: ContextZoneView };

type ZonedTab = { id: string; mode: ContextPanelMode; touchedAt: number };

/**
 * The right zone keeps the panel's original top-level fields, so state an
 * older build wrote, and every reader that predates zones, stays the right
 * panel. The left and bottom zones live under `zones`.
 */
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

/**
 * The zone's tab: the one it names when that tab is still open and placed in
 * this zone, else the zone's last tab. A tab id that points at a surface since
 * moved elsewhere never shows here.
 */
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

/** The zone is on screen: open, with a tab of its own to show. */
export const isZoneShown = (panel: ZonedPanel | undefined, placement: ContextZonePlacement, zone: ContextZone): boolean => (
  Boolean(panel && getZoneView(panel, zone).isOpen && resolveZoneActiveTab(panel, placement, zone))
);

/** Every surface on screen right now, one per shown zone. */
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

/**
 * Re-resolves every zone against the tabs and the placement: each zone names
 * one of its own tabs, and a zone left without tabs closes.
 */
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

/**
 * Moves a surface's on-screen state with it. When the surface is what `from`
 * shows, `to` opens on it (giving up whatever `to` showed) and `from` closes,
 * rather than jumping to another surface the user did not ask for. The
 * placement passed in is the one after the move.
 */
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

/**
 * Stored placement: known surfaces placed in a moved zone. `right` is the
 * default and is dropped, as is anything malformed.
 */
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

/** Stored left/bottom views; anything missing or malformed loads closed. */
export const zoneViewsSchema = z.object({
  left: zoneViewSchema.default(CLOSED_ZONE_VIEW),
  bottom: zoneViewSchema.default(CLOSED_ZONE_VIEW),
}).catch({ left: CLOSED_ZONE_VIEW, bottom: CLOSED_ZONE_VIEW });

/** A view only stays open on a tab that still exists. */
export const keepZoneViewsOnTabs = (views: MovedZoneViews, tabIds: ReadonlySet<string>): MovedZoneViews => {
  const keep = (view: ContextZoneView): ContextZoneView => {
    const activeTabId = view.activeTabId && tabIds.has(view.activeTabId) ? view.activeTabId : null;
    return { isOpen: view.isOpen && activeTabId !== null, expanded: view.expanded && view.isOpen && activeTabId !== null, activeTabId };
  };
  return { left: keep(views.left), bottom: keep(views.bottom) };
};
