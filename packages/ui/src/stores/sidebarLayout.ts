import { z } from 'zod';

/**
 * How the desktop and web sessions sidebar arranges its sections: their
 * order, which sessions the live attention sections pull out of Pinned, In
 * work and the rest of the list, what the open session does while it changes
 * state, and how the List view lays out chats and projects.
 *
 * One value, stored per surface kind with the other sidebar toggles
 * (`sidebarLayout`). VS Code keeps the classic layout; the phone sheet draws
 * the same value as the desktop and web sidebar, keeping its own order.
 */

/** Live states a top-level session can be in, as the attention sections see it. */
export type SessionAttentionState = 'approval' | 'question' | 'running' | 'error' | 'stopped' | 'idle';

/**
 * How the sessions of Pinned and In work that need the user are pulled out:
 * not at all, one section per kind, approvals and questions together as
 * Blocked, all four kinds together, or everything that is not running.
 */
export type AttentionGrouping = 'off' | 'separate' | 'blocked' | 'combined' | 'pending';
const ATTENTION_GROUPINGS = ['off', 'separate', 'blocked', 'combined', 'pending'] as const satisfies readonly AttentionGrouping[];

/**
 * Whether sessions outside Pinned and In work take part: not at all, in the
 * same sections, or in sections of their own.
 */
export type OtherAttentionScope = 'off' | 'shared' | 'separate';
const OTHER_ATTENTION_SCOPES = ['off', 'shared', 'separate'] as const satisfies readonly OtherAttentionScope[];

export type OtherAttentionGrouping = 'separate' | 'blocked' | 'combined';
const OTHER_ATTENTION_GROUPINGS = ['separate', 'blocked', 'combined'] as const satisfies readonly OtherAttentionGrouping[];

/**
 * What happens when the open session is marked done or archived: its row
 * stays put until another session opens, it moves at once, it moves and the
 * list scrolls to where it went, or another session opens (the top one
 * needing attention, the next one down or up, the next one down unless it was
 * last, the reverse, or the one open before). An archived session always
 * closes; the first three choices open nothing in its place.
 */
export type OpenSessionLeave = 'hold' | 'stay' | 'reveal' | 'attention' | 'down' | 'up' | 'down-up' | 'up-down' | 'previous';
const OPEN_SESSION_LEAVE_OPTIONS = ['hold', 'stay', 'reveal', 'attention', 'down', 'up', 'down-up', 'up-down', 'previous'] as const satisfies readonly OpenSessionLeave[];

/** Chats in the List view: one more group among the projects, or their own section. */
export type TimelineChatsPlacement = 'group' | 'section';
const TIMELINE_CHATS_PLACEMENTS = ['group', 'section'] as const satisfies readonly TimelineChatsPlacement[];

/**
 * Every section the sidebar can show, in the default order: the attention
 * zones, Pinned, In work, the zones of other sessions, then Chats and the
 * project list. `projects` is the whole project list (with Chats among the
 * List view's projects, under one heading); every other key is a zone with
 * its own header. Every section can be moved.
 */
export const SIDEBAR_SECTION_KEYS = [
  'approvals',
  'questions',
  'blocked',
  'attention',
  'pending',
  'errors',
  'stopped',
  'pinned',
  'work',
  'other-approvals',
  'other-questions',
  'other-blocked',
  'other-attention',
  'other-errors',
  'other-stopped',
  'other-active',
  'chats',
  'projects',
] as const;

export type SidebarSectionKey = typeof SIDEBAR_SECTION_KEYS[number];

/** Sections drawn as a zone with its own header. */
export type SidebarZoneKey = Exclude<SidebarSectionKey, 'projects'>;

/** Zones that only ever hold sessions pulled out by their live state. */
export type SidebarAttentionZoneKey = Exclude<SidebarZoneKey, 'chats' | 'pinned' | 'work'>;

const SECTION_KEY_SET: ReadonlySet<string> = new Set(SIDEBAR_SECTION_KEYS);

export const isSidebarSectionKey = (value: string): value is SidebarSectionKey => SECTION_KEY_SET.has(value);

export const isSidebarAttentionZoneKey = (key: SidebarSectionKey): key is SidebarAttentionZoneKey => (
  key !== 'chats' && key !== 'pinned' && key !== 'work' && key !== 'projects'
);

export type SidebarLayout = {
  sectionOrder: readonly SidebarSectionKey[];
  attention: AttentionGrouping;
  otherAttention: OtherAttentionScope;
  otherAttentionGrouping: OtherAttentionGrouping;
  /** Sessions outside Pinned and In work that run, or finished unseen, get a section of their own. */
  otherActive: boolean;
  /** The open session keeps its row where it is until another session opens. */
  holdOpenSession: boolean;
  afterLeave: OpenSessionLeave;
  timelineChats: TimelineChatsPlacement;
  /** List view: sessions under one header per project; off, one combined list. */
  timelineProjectGroups: boolean;
  /** Folded into `sessionRowDisplay.listLines` (display store v13); kept so stored layouts still parse. */
  timelineCompactRows: boolean;
  /** List view with Chats as a group: its place among the projects. */
  chatsGroupIndex: number;
};

export const DEFAULT_SIDEBAR_LAYOUT: SidebarLayout = Object.freeze({
  sectionOrder: Object.freeze([...SIDEBAR_SECTION_KEYS]),
  attention: 'separate',
  otherAttention: 'off',
  otherAttentionGrouping: 'separate',
  otherActive: false,
  holdOpenSession: true,
  afterLeave: 'hold',
  timelineChats: 'group',
  timelineProjectGroups: true,
  timelineCompactRows: false,
  chatsGroupIndex: 0,
});

const CLASSIC_SECTION_ORDER: readonly SidebarSectionKey[] = Object.freeze(['chats', ...SIDEBAR_SECTION_KEYS.filter((key) => key !== 'chats')]);

/** The sidebar as it was before these options: no attention sections, nothing held, Chats on top. */
export const CLASSIC_SIDEBAR_LAYOUT: SidebarLayout = Object.freeze({
  sectionOrder: CLASSIC_SECTION_ORDER,
  attention: 'off',
  otherAttention: 'off',
  otherAttentionGrouping: 'separate',
  otherActive: false,
  holdOpenSession: false,
  afterLeave: 'stay',
  timelineChats: 'section',
  timelineProjectGroups: true,
  timelineCompactRows: false,
  chatsGroupIndex: 0,
});

const MAX_CHATS_GROUP_INDEX = 10_000;

/**
 * A stored order completed with every known section: unknown and repeated
 * keys are dropped, and a section the stored order lacks (one added by a
 * later version) goes right after the section that precedes it by default.
 */
export const normalizeSectionOrder = (order: readonly string[]): SidebarSectionKey[] => {
  const result: SidebarSectionKey[] = [];
  for (const key of order) {
    if (isSidebarSectionKey(key) && !result.includes(key)) result.push(key);
  }
  SIDEBAR_SECTION_KEYS.forEach((key, defaultIndex) => {
    if (result.includes(key)) return;
    let insertAt = 0;
    for (let index = defaultIndex - 1; index >= 0; index -= 1) {
      const previous = SIDEBAR_SECTION_KEYS[index];
      const position = previous ? result.indexOf(previous) : -1;
      if (position >= 0) {
        insertAt = position + 1;
        break;
      }
    }
    result.splice(insertAt, 0, key);
  });
  return result;
};

/**
 * Moves `key` one place up or down among the sections that are shown, so a
 * click always visibly moves it. Hidden sections keep their places.
 */
export const moveSectionAmongShown = (
  order: readonly SidebarSectionKey[],
  shown: readonly SidebarSectionKey[],
  key: SidebarSectionKey,
  direction: 'up' | 'down',
): SidebarSectionKey[] => {
  const shownInOrder = order.filter((entry) => shown.includes(entry));
  const shownIndex = shownInOrder.indexOf(key);
  const neighbour = shownInOrder[direction === 'up' ? shownIndex - 1 : shownIndex + 1];
  if (shownIndex < 0 || !neighbour) return [...order];
  return placeSection(order, key, neighbour, direction === 'up' ? 'before' : 'after');
};

/** Puts `key` right before or after `anchor`. */
export const placeSection = (
  order: readonly SidebarSectionKey[],
  key: SidebarSectionKey,
  anchor: SidebarSectionKey,
  side: 'before' | 'after',
): SidebarSectionKey[] => {
  if (key === anchor) return [...order];
  const without = order.filter((entry) => entry !== key);
  const anchorIndex = without.indexOf(anchor);
  if (anchorIndex < 0) return [...order];
  without.splice(side === 'before' ? anchorIndex : anchorIndex + 1, 0, key);
  return without;
};

/**
 * A stored layout, completed with the defaults: a field that is missing or
 * holds a value this version does not know falls back to its default, so a
 * layout saved by a newer version still applies what this one understands.
 * Anything that is not an object fails to parse.
 */
export const sidebarLayoutSchema = z.object({
  sectionOrder: z.array(z.string()).max(64).optional().catch(undefined),
  attention: z.enum(ATTENTION_GROUPINGS).optional().catch(undefined),
  otherAttention: z.enum(OTHER_ATTENTION_SCOPES).optional().catch(undefined),
  otherAttentionGrouping: z.enum(OTHER_ATTENTION_GROUPINGS).optional().catch(undefined),
  otherActive: z.boolean().optional().catch(undefined),
  holdOpenSession: z.boolean().optional().catch(undefined),
  afterLeave: z.enum(OPEN_SESSION_LEAVE_OPTIONS).optional().catch(undefined),
  timelineChats: z.enum(TIMELINE_CHATS_PLACEMENTS).optional().catch(undefined),
  timelineProjectGroups: z.boolean().optional().catch(undefined),
  timelineCompactRows: z.boolean().optional().catch(undefined),
  chatsGroupIndex: z.number().int().min(0).max(MAX_CHATS_GROUP_INDEX).optional().catch(undefined),
}).transform((stored): SidebarLayout => ({
  sectionOrder: normalizeSectionOrder(stored.sectionOrder ?? DEFAULT_SIDEBAR_LAYOUT.sectionOrder),
  attention: stored.attention ?? DEFAULT_SIDEBAR_LAYOUT.attention,
  otherAttention: stored.otherAttention ?? DEFAULT_SIDEBAR_LAYOUT.otherAttention,
  otherAttentionGrouping: stored.otherAttentionGrouping ?? DEFAULT_SIDEBAR_LAYOUT.otherAttentionGrouping,
  otherActive: stored.otherActive ?? DEFAULT_SIDEBAR_LAYOUT.otherActive,
  holdOpenSession: stored.holdOpenSession ?? DEFAULT_SIDEBAR_LAYOUT.holdOpenSession,
  afterLeave: stored.afterLeave ?? DEFAULT_SIDEBAR_LAYOUT.afterLeave,
  timelineChats: stored.timelineChats ?? DEFAULT_SIDEBAR_LAYOUT.timelineChats,
  timelineProjectGroups: stored.timelineProjectGroups ?? DEFAULT_SIDEBAR_LAYOUT.timelineProjectGroups,
  timelineCompactRows: stored.timelineCompactRows ?? DEFAULT_SIDEBAR_LAYOUT.timelineCompactRows,
  chatsGroupIndex: stored.chatsGroupIndex ?? DEFAULT_SIDEBAR_LAYOUT.chatsGroupIndex,
}));

type ZoneByState = Partial<Record<SessionAttentionState, SidebarAttentionZoneKey>>;

const TRACKED_ZONES = {
  off: {},
  separate: { approval: 'approvals', question: 'questions', error: 'errors', stopped: 'stopped' },
  blocked: { approval: 'blocked', question: 'blocked', error: 'errors', stopped: 'stopped' },
  combined: { approval: 'attention', question: 'attention', error: 'attention', stopped: 'attention' },
  pending: { approval: 'pending', question: 'pending', error: 'pending', stopped: 'pending', idle: 'pending' },
} satisfies Record<AttentionGrouping, ZoneByState>;

const OTHER_ZONES = {
  separate: { approval: 'other-approvals', question: 'other-questions', error: 'other-errors', stopped: 'other-stopped' },
  blocked: { approval: 'other-blocked', question: 'other-blocked', error: 'other-errors', stopped: 'other-stopped' },
  combined: { approval: 'other-attention', question: 'other-attention', error: 'other-attention', stopped: 'other-attention' },
} satisfies Record<OtherAttentionGrouping, ZoneByState>;

const trackedZones = (grouping: AttentionGrouping): ZoneByState => TRACKED_ZONES[grouping];
const otherZones = (grouping: OtherAttentionGrouping): ZoneByState => OTHER_ZONES[grouping];

/** The attention zone a pinned or in-work session in `state` moves to, if any. */
export const trackedAttentionZone = (layout: SidebarLayout, state: SessionAttentionState): SidebarAttentionZoneKey | null => (
  trackedZones(layout.attention)[state] ?? null
);

/**
 * The attention zone a session outside Pinned and In work moves to, if any.
 * Sharing the sections never pulls idle sessions: "everything not running"
 * would be the whole list.
 */
export const otherAttentionZone = (layout: SidebarLayout, state: SessionAttentionState): SidebarAttentionZoneKey | null => {
  if (state === 'idle' || state === 'running') return null;
  if (layout.otherAttention === 'shared') return trackedZones(layout.attention)[state] ?? null;
  if (layout.otherAttention === 'separate') return otherZones(layout.otherAttentionGrouping)[state] ?? null;
  return null;
};

/** The attention zones a layout can fill, in no particular order. */
export const attentionZonesInUse = (layout: SidebarLayout): ReadonlySet<SidebarAttentionZoneKey> => {
  const zones = new Set<SidebarAttentionZoneKey>(Object.values(trackedZones(layout.attention)));
  if (layout.otherAttention === 'separate') {
    for (const zone of Object.values(otherZones(layout.otherAttentionGrouping))) zones.add(zone);
  }
  if (layout.otherActive) zones.add('other-active');
  return zones;
};

/** Whether the layout needs the live state of sessions outside Pinned and In work. */
export const watchesOtherSessions = (layout: SidebarLayout): boolean => (
  layout.otherActive || layout.otherAttention === 'separate' || (layout.otherAttention === 'shared' && layout.attention !== 'off')
);
