import {
  CONTEXT_SURFACES,
  type ContextSurfaceDescriptor,
  type ContextSurfaceId,
} from '@/lib/surfaces/registry';
import { isPluginContextPanelMode, type ContextPanelMode } from '@/lib/surfaces/modes';
import { z } from 'zod';

/**
 * Modular Workspace V1: four fixed docking zones, no nested splits and no
 * floating windows. A zone holds an ordered list of context surfaces that
 * behave as tabs; different zones are visible at the same time.
 */
export type WorkspaceZone = 'left' | 'center' | 'right' | 'bottom';

export const WORKSPACE_ZONES: readonly WorkspaceZone[] = ['left', 'center', 'right', 'bottom'];

/** Zones the user can collapse. `center` always keeps the remaining space. */
const AUXILIARY_WORKSPACE_ZONES: readonly WorkspaceZone[] = ['left', 'right', 'bottom'];

export type WorkspaceLayout = {
  left: ContextSurfaceId[];
  center: ContextSurfaceId[];
  right: ContextSurfaceId[];
  bottom: ContextSurfaceId[];
};

export const isWorkspaceZone = (value: string): value is WorkspaceZone =>
  WORKSPACE_ZONES.some((zone) => zone === value);

/**
 * Shape of a stored layout, as read back from persistence.
 *
 * Each zone falls back to an empty list rather than failing the whole parse:
 * one corrupt entry must not throw away the other three, and
 * `sanitizeWorkspaceLayout` refills whatever is missing from the registry.
 */
const storedWorkspaceLayoutSchema = z.object({
  left: z.array(z.string()).catch([]),
  center: z.array(z.string()).catch([]),
  right: z.array(z.string()).catch([]),
  bottom: z.array(z.string()).catch([]),
}).catch({ left: [], center: [], right: [], bottom: [] });

/** A stored layout as it arrives from persistence, before placement rules run. */
type StoredWorkspaceLayout = z.infer<typeof storedWorkspaceLayoutSchema>;

/**
 * Minimum usable sizes. Aligned with the context panel's existing
 * `CONTEXT_PANEL_MIN_WIDTH` (320) for the right zone and the docked file
 * tree's width (240) for the left one, so a moved surface keeps the size
 * floor it already had.
 */
export const WORKSPACE_ZONE_MIN_SIZE = {
  left: 240,
  right: 320,
  bottom: 160,
} as const;

export const WORKSPACE_ZONE_DEFAULT_SIZE = {
  left: 280,
  right: 420,
  bottom: 260,
} as const;

/** The center column never shrinks below this while an auxiliary zone resizes. */
export const WORKSPACE_CENTER_MIN_WIDTH = 400;
export const WORKSPACE_CENTER_MIN_HEIGHT = 200;

export type AuxiliaryWorkspaceZone = keyof typeof WORKSPACE_ZONE_MIN_SIZE;

export type WorkspaceZoneSizes = {
  left: number;
  right: number;
  bottom: number;
};

/**
 * Stored pixel sizes. Each zone is optional and independently recoverable, so
 * one unreadable number falls back to that zone's default instead of resetting
 * the other two.
 */
const storedWorkspaceZoneSizesSchema = z.object({
  left: z.number().finite().optional().catch(undefined),
  right: z.number().finite().optional().catch(undefined),
  bottom: z.number().finite().optional().catch(undefined),
}).catch({});

/** Zone ids read back from persistence; unknown entries are dropped. */
const storedOpenZonesSchema = z.array(z.string()).catch([]);

export const isAuxiliaryWorkspaceZone = (zone: WorkspaceZone): zone is AuxiliaryWorkspaceZone =>
  zone !== 'center';

export const clampWorkspaceZoneSize = (zone: AuxiliaryWorkspaceZone, size: number): number => {
  if (!Number.isFinite(size)) return WORKSPACE_ZONE_DEFAULT_SIZE[zone];
  return Math.max(WORKSPACE_ZONE_MIN_SIZE[zone], Math.round(size));
};

export const parseStoredWorkspaceZoneSizes = (
  value: Parameters<typeof storedWorkspaceZoneSizesSchema.parse>[0],
): WorkspaceZoneSizes => {
  const stored = storedWorkspaceZoneSizesSchema.parse(value);
  const sizes: WorkspaceZoneSizes = { ...WORKSPACE_ZONE_DEFAULT_SIZE };
  for (const zone of AUXILIARY_WORKSPACE_ZONES) {
    if (!isAuxiliaryWorkspaceZone(zone)) continue;
    const size = stored[zone];
    if (size !== undefined) sizes[zone] = clampWorkspaceZoneSize(zone, size);
  }
  return sizes;
};

/**
 * Zones a directory had open, read back from persistence. Duplicates and ids
 * that are not zones are dropped rather than failing the whole list.
 */
export const parseStoredOpenZones = (
  value: Parameters<typeof storedOpenZonesSchema.parse>[0],
): WorkspaceZone[] => {
  const seen = new Set<WorkspaceZone>();
  for (const entry of storedOpenZonesSchema.parse(value)) {
    if (isWorkspaceZone(entry)) seen.add(entry);
  }
  return [...seen];
};

/** Where a surface with no explicit placement lands, plugin surfaces included. */
const FALLBACK_WORKSPACE_ZONE: WorkspaceZone = 'right';

/**
 * Tab id standing for the session conversation.
 *
 * The chat is not a context panel tab — it has no entry in
 * `contextPanelByDirectory` and no lifecycle of its own to store — but its
 * zone still needs to record "the conversation is what is showing here". It
 * lives only in the per-zone selection (`activeTabIdByZone`), never in the
 * global `activeTabId`, so nothing that expects a real tab id ever sees it.
 */
export const MAIN_CHAT_TAB_ID = 'workspace:main-chat';

/**
 * Tab ids selected per zone, read back from persistence. Unknown zones and
 * non-string ids are dropped rather than failing the whole record.
 */
const storedActiveTabIdByZoneSchema = z.object({
  left: z.string().optional().catch(undefined),
  center: z.string().optional().catch(undefined),
  right: z.string().optional().catch(undefined),
  bottom: z.string().optional().catch(undefined),
}).catch({});

export type ActiveTabIdByZone = z.infer<typeof storedActiveTabIdByZoneSchema>;

export const parseStoredActiveTabIdByZone = (
  value: Parameters<typeof storedActiveTabIdByZoneSchema.parse>[0],
): ActiveTabIdByZone => {
  const parsed = storedActiveTabIdByZoneSchema.parse(value);
  const result: ActiveTabIdByZone = {};
  for (const zone of WORKSPACE_ZONES) {
    const id = parsed[zone];
    if (id) result[zone] = id;
  }
  return result;
};

const cloneLayout = (layout: WorkspaceLayout): WorkspaceLayout => ({
  left: [...layout.left],
  center: [...layout.center],
  right: [...layout.right],
  bottom: [...layout.bottom],
});

const descriptorById = new Map<string, ContextSurfaceDescriptor>(
  CONTEXT_SURFACES.map((surface) => [surface.id, surface]),
);

const defaultZoneForSurface = (id: string): WorkspaceZone => {
  const descriptor = descriptorById.get(id);
  if (descriptor?.defaultZone) return descriptor.defaultZone;
  return FALLBACK_WORKSPACE_ZONE;
};

/**
 * Zones a surface may be placed in. Unknown ids — plugin surfaces above all —
 * are unconstrained rather than rejected: a third-party panel must keep
 * working without knowing this system exists.
 */
export const allowedZonesForSurface = (id: string): readonly WorkspaceZone[] => {
  const descriptor = descriptorById.get(id);
  return descriptor?.allowedZones ?? WORKSPACE_ZONES;
};

export const canPlaceSurfaceInZone = (id: string, zone: WorkspaceZone): boolean =>
  allowedZonesForSurface(id).includes(zone);

/**
 * Rebuilds a layout from persisted (or hand-edited) data.
 *
 * Every known surface ends up in exactly one zone: duplicates keep their first
 * placement, ids that no longer exist are dropped, a surface placed in a zone
 * it does not allow falls back to its default zone, and surfaces the stored
 * layout never mentioned — a newly shipped one, or a freshly installed plugin
 * panel — are appended to their default zone. A layout that is missing,
 * malformed, or not an object is replaced wholesale by the default.
 */
export const sanitizeWorkspaceLayout = (
  stored: StoredWorkspaceLayout,
  extras: readonly ContextSurfaceDescriptor[] = [],
): WorkspaceLayout => {
  const known = new Map<string, ContextSurfaceDescriptor>(descriptorById);
  for (const extra of extras) known.set(extra.id, extra);

  const layout: WorkspaceLayout = { left: [], center: [], right: [], bottom: [] };
  const placed = new Set<string>();

  for (const zone of WORKSPACE_ZONES) {
    for (const id of stored[zone]) {
      if (placed.has(id)) continue;
      // Drop ids that no longer resolve to a surface. A plugin id is kept even
      // when its guest is not loaded right now: the catalog arrives after
      // hydration, and dropping the id here would forget where the user
      // docked that panel.
      const surfaceId = known.get(id)?.id ?? (isPluginContextPanelMode(id) ? id : null);
      if (!surfaceId) continue;
      const target = canPlaceSurfaceInZone(id, zone) ? zone : defaultZoneForSurface(id);
      placed.add(id);
      layout[target].push(surfaceId);
    }
  }

  for (const surface of known.values()) {
    if (placed.has(surface.id)) continue;
    placed.add(surface.id);
    layout[defaultZoneForSurface(surface.id)].push(surface.id);
  }

  return layout;
};

/**
 * The layout every install starts from, and the target of Reset Layout. It is
 * derived from the registry's `defaultZone` metadata rather than written out
 * here, so a new surface gets its placement from its own descriptor.
 *
 * It reproduces the pre-workspace app exactly: the session conversation owns
 * the main area and every other surface opens in the right panel. Existing
 * installs migrate onto this same shape (see the v21 -> v22 store migration),
 * so upgrading rearranges nothing.
 */
export const createDefaultWorkspaceLayout = (): WorkspaceLayout =>
  sanitizeWorkspaceLayout({ left: [], center: [], right: [], bottom: [] });

/**
 * Reads a layout back from persistence. The schema absorbs anything it cannot
 * recognise, and `sanitizeWorkspaceLayout` then fills the result out from the
 * registry, so a corrupt or outdated value degrades to the default rather than
 * leaving surfaces unreachable.
 */
export const parseStoredWorkspaceLayout = (value: Parameters<typeof storedWorkspaceLayoutSchema.parse>[0]): WorkspaceLayout =>
  sanitizeWorkspaceLayout(storedWorkspaceLayoutSchema.parse(value));

/**
 * The workspace layout another window just saved, read from the raw
 * `ui-store` value of a storage event. Stricter than loading at startup: the
 * value is adopted only when it carries a complete layout, so a window running
 * an older build, or a write that lacks the layout, can never reset this
 * window's placements to the defaults. Null when there is nothing to adopt.
 */
const persistedWorkspaceSchema = z.object({
  state: z.object({
    workspaceLayout: z.object({
      left: z.array(z.string()),
      center: z.array(z.string()),
      right: z.array(z.string()),
      bottom: z.array(z.string()),
    }),
    workspaceZoneSizes: z.object({
      left: z.number().finite().optional(),
      right: z.number().finite().optional(),
      bottom: z.number().finite().optional(),
    }).optional(),
  }),
});

export const readPersistedWorkspace = (raw: string | null): { layout: WorkspaceLayout; sizes: WorkspaceZoneSizes | null } | null => {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = persistedWorkspaceSchema.safeParse(value);
  if (!parsed.success) return null;
  const { workspaceLayout, workspaceZoneSizes } = parsed.data.state;
  return {
    layout: sanitizeWorkspaceLayout(workspaceLayout),
    sizes: workspaceZoneSizes ? parseStoredWorkspaceZoneSizes(workspaceZoneSizes) : null,
  };
};

export const zoneOfSurface = (layout: WorkspaceLayout, id: string): WorkspaceZone | null => {
  for (const zone of WORKSPACE_ZONES) {
    if (layout[zone].some((entry) => entry === id)) return zone;
  }
  return null;
};

/** Where the session conversation (the `chat` surface) is docked. */
export const mainChatZone = (layout: WorkspaceLayout): WorkspaceZone =>
  zoneOfSurface(layout, 'chat') ?? 'center';

/**
 * Where split-session chats open: beside the conversation, never on top of it.
 * They exist to show a second session next to the first, so they take the
 * right zone while the conversation holds the center, and the center when the
 * conversation has been docked elsewhere.
 */
export const sessionChatZone = (layout: WorkspaceLayout): WorkspaceZone =>
  (mainChatZone(layout) === 'center' ? 'right' : 'center');

/**
 * Where a panel tab belongs. Plugin modes share one placement per guest, so a
 * guest panel follows wherever the user put it and otherwise lands right.
 * `chat` tabs are split sessions and go beside the conversation; ask
 * `mainChatZone` for the conversation itself.
 */
export const zoneOfMode = (
  layout: WorkspaceLayout,
  mode: ContextPanelMode,
  surfaces: readonly ContextSurfaceDescriptor[] = CONTEXT_SURFACES,
): WorkspaceZone => {
  if (mode === 'chat') return sessionChatZone(layout);
  if (isPluginContextPanelMode(mode)) {
    return zoneOfSurface(layout, mode) ?? FALLBACK_WORKSPACE_ZONE;
  }
  const descriptor = surfaces.find((surface) => surface.mode === mode);
  if (!descriptor) return FALLBACK_WORKSPACE_ZONE;
  return zoneOfSurface(layout, descriptor.id) ?? FALLBACK_WORKSPACE_ZONE;
};

/**
 * Moves a surface into `zone`, appending it unless `index` places it earlier.
 * A move the surface does not allow is rejected by returning the layout
 * unchanged, so a caller cannot strand the editor somewhere it cannot render.
 */
export const moveSurfaceToZone = (
  layout: WorkspaceLayout,
  id: string,
  zone: WorkspaceZone,
  index?: number,
): WorkspaceLayout => {
  if (!canPlaceSurfaceInZone(id, zone)) return layout;
  const current = zoneOfSurface(layout, id);
  const next = cloneLayout(layout);
  let placed: ContextSurfaceId;
  if (current === null) {
    // A plugin panel the user has never moved has no stored placement yet
    // (it sits in the fallback zone implicitly); give it one now.
    if (!isPluginContextPanelMode(id)) return layout;
    placed = id;
  } else {
    const found = layout[current].find((entry) => entry === id);
    if (found === undefined) return layout;
    placed = found;
    next[current] = next[current].filter((entry) => entry !== id);
  }
  const target = next[zone];
  const at = index === undefined ? target.length : Math.max(0, Math.min(index, target.length));
  target.splice(at, 0, placed);
  return next;
};

export type WorkspacePresetId = 'default' | 'developer' | 'code-agent';

/**
 * Starting points, not modes: a preset writes a layout once and the user keeps
 * editing from there. Only surfaces the preset names are moved; everything
 * else keeps its current zone, so a preset never silently relocates a plugin
 * panel the user placed by hand.
 */
export const WORKSPACE_PRESET_IDS: readonly WorkspacePresetId[] = ['default', 'developer', 'code-agent'];

/** `default` is Reset Layout, so it is rebuilt from the registry, not listed here. */
const WORKSPACE_PRESET_PLACEMENTS = {
  developer: [['editor', 'left'], ['chat', 'center'], ['terminal', 'bottom'], ['git', 'bottom']],
  'code-agent': [['editor', 'center'], ['chat', 'right'], ['terminal', 'bottom']],
} satisfies Record<Exclude<WorkspacePresetId, 'default'>, ReadonlyArray<readonly [ContextSurfaceId, WorkspaceZone]>>;

export const applyWorkspacePreset = (layout: WorkspaceLayout, preset: WorkspacePresetId): WorkspaceLayout => {
  if (preset === 'default') return createDefaultWorkspaceLayout();

  let next = layout;
  for (const [id, zone] of WORKSPACE_PRESET_PLACEMENTS[preset]) {
    next = moveSurfaceToZone(next, id, zone);
  }
  return next;
};
