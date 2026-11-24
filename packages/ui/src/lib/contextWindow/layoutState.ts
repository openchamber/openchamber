import { z } from 'zod';
import { BUILT_IN_CONTEXT_PANEL_MODES, isContextPanelMode, type ContextPanelMode } from '@/lib/surfaces/modes';
import {
  CLOSED_ZONE_VIEW,
  CONTEXT_ZONES,
  getZoneView,
  resolveZoneActiveTab,
  settleZones,
  withZoneView,
  zoneOfMode,
  type ContextZone,
  type ContextZonePlacement,
} from '@/lib/workspace/zones';
import { sanitizeContextPanelByDirectory } from '@/stores/ui/contextPanelState';
import type { ContextPanelDirectoryState } from '@/stores/ui/types';

export const CONTEXT_WINDOW_STATE_KEY = 'openchamber.context-window.v1';

const MAX_PANELS = 8;

type ContextPanels = Record<string, ContextPanelDirectoryState>;

export type ContextWindowPlacement = Partial<Record<ContextPanelMode, ContextZone>>;

export type ContextWindowSizes = Partial<Record<ContextZone, number>>;

export type ContextWindowPanelEntry = {
  byDirectory: ContextPanels;
  placement: ContextWindowPlacement;
  touchedAt: number;
};

export type ContextWindowRecord = {
  placement: ContextWindowPlacement;
  sizes: ContextWindowSizes;
  panels: Record<string, ContextWindowPanelEntry>;
};

export const EMPTY_CONTEXT_WINDOW_RECORD: ContextWindowRecord = { placement: {}, sizes: {}, panels: {} };

const zoneSchema = z.enum(['left', 'right', 'bottom']);

const entriesSchema = z.record(z.string(), z.unknown()).catch({});

const placementSchema = entriesSchema.transform((entries) => {
  const placement: ContextWindowPlacement = {};
  for (const [mode, zone] of Object.entries(entries)) {
    const parsed = zoneSchema.safeParse(zone);
    if (isContextPanelMode(mode) && parsed.success) placement[mode] = parsed.data;
  }
  return placement;
});

export const sizesSchema = entriesSchema.transform((entries) => {
  const sizes: ContextWindowSizes = {};
  for (const [zone, pixels] of Object.entries(entries)) {
    const parsedZone = zoneSchema.safeParse(zone);
    const parsedPixels = z.number().finite().positive().safeParse(pixels);
    if (parsedZone.success && parsedPixels.success) sizes[parsedZone.data] = parsedPixels.data;
  }
  return sizes;
});

export const contextPanelsSchema = z.unknown().transform((value) => sanitizeContextPanelByDirectory(value));

const panelEntrySchema = z.object({
  byDirectory: contextPanelsSchema,
  placement: placementSchema,
  touchedAt: z.number().finite().catch(0),
});

const panelsSchema = entriesSchema.transform((entries) => {
  const panels: ContextWindowRecord['panels'] = {};
  for (const [ownerId, entry] of Object.entries(entries)) {
    const parsed = panelEntrySchema.safeParse(entry);
    if (parsed.success) panels[ownerId] = parsed.data;
  }
  return panels;
});

export const contextWindowRecordSchema = z.object({
  placement: placementSchema,
  sizes: sizesSchema,
  panels: panelsSchema,
}).catch(EMPTY_CONTEXT_WINDOW_RECORD);

export const panelWindowPlacement = (explicit: ContextWindowPlacement): ContextZonePlacement => {
  const placement: ContextZonePlacement = {};
  const modes = new Set<ContextPanelMode>([...BUILT_IN_CONTEXT_PANEL_MODES, ...Object.keys(explicit).filter(isContextPanelMode)]);
  for (const mode of modes) {
    const zone = explicit[mode] ?? 'bottom';
    if (zone !== 'right') placement[mode] = zone;
  }
  return placement;
};

export const explicitPanelWindowPlacement = (
  placement: ContextZonePlacement,
  previous: ContextWindowPlacement,
) => {
  const modes = new Set<ContextPanelMode>([
    ...BUILT_IN_CONTEXT_PANEL_MODES,
    ...Object.keys(previous).filter(isContextPanelMode),
    ...Object.keys(placement).filter(isContextPanelMode),
  ]);
  return Object.fromEntries([...modes].map((mode) => [mode, zoneOfMode(placement, mode)])) satisfies ContextWindowPlacement;
};

export const carryShownSurfaces = (byDirectory: ContextPanels, from: ContextZonePlacement, to: ContextZonePlacement): ContextPanels => (
  Object.fromEntries(Object.entries(byDirectory).map(([directory, panel]) => {
    const shown = CONTEXT_ZONES.flatMap((zone) => {
      if (!getZoneView(panel, zone).isOpen) return [];
      const tab = resolveZoneActiveTab(panel, from, zone);
      return tab ? [tab] : [];
    });
    let next: ContextPanelDirectoryState = {
      ...panel,
      isOpen: false,
      expanded: false,
      activeTabId: null,
      zones: { left: CLOSED_ZONE_VIEW, bottom: CLOSED_ZONE_VIEW },
    };
    const filled = new Set<ContextZone>();
    for (const tab of shown) {
      const zone = zoneOfMode(to, tab.mode);
      if (filled.has(zone)) continue;
      filled.add(zone);
      next = withZoneView(next, zone, { isOpen: true, expanded: false, activeTabId: tab.id });
    }
    return [directory, settleZones(next, to)];
  }))
);

export const closeEveryZone = (byDirectory: ContextPanels): ContextPanels => Object.fromEntries(
  Object.entries(byDirectory).map(([directory, panel]) => [directory, {
    ...panel,
    isOpen: false,
    expanded: false,
    zones: {
      left: { ...panel.zones.left, isOpen: false, expanded: false },
      bottom: { ...panel.zones.bottom, isOpen: false, expanded: false },
    },
  }]),
);

export const withPanelEntry = (record: ContextWindowRecord, ownerId: string, entry: ContextWindowPanelEntry): ContextWindowRecord => {
  const panels = Object.entries({ ...record.panels, [ownerId]: entry })
    .sort((left, right) => right[1].touchedAt - left[1].touchedAt)
    .slice(0, MAX_PANELS);
  return { ...record, panels: Object.fromEntries(panels) };
};

export const withoutPanelEntry = (record: ContextWindowRecord, ownerId: string): ContextWindowRecord => ({
  ...record,
  panels: Object.fromEntries(Object.entries(record.panels).filter(([id]) => id !== ownerId)),
});

export const latestPanelOwner = (record: ContextWindowRecord, among: ReadonlySet<string>): string | null => (
  Object.entries(record.panels).filter(([ownerId]) => among.has(ownerId)).reduce<[string, number] | null>(
    (latest, [ownerId, entry]) => (!latest || entry.touchedAt > latest[1] ? [ownerId, entry.touchedAt] : latest),
    null,
  )?.[0] ?? null
);
