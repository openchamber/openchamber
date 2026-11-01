import { z } from 'zod';
import { matchesRankQuery, SIDEBAR_SEARCH } from '@/lib/search/fuzzySearch';

/**
 * The sidebar's sections: an ordered list the user arranges, shared by every
 * client of the server (`sidebarSections`). Four are built in (Chats, Pinned,
 * In work, Projects); the rest are the user's own, each a filter over the
 * works the sidebar lists. Which sections a surface shows is its own choice
 * (`sidebarHiddenSections` for the user's, the existing show toggles for the
 * built-in ones), so the phone can hide what the desktop shows.
 *
 * Sections take works from the top down: a section that claims its works
 * hides them from every section below it and from their projects; one that
 * does not claim them shows them and lets them through.
 */

const BUILTIN_SIDEBAR_SECTION_IDS = ['chats', 'pinned', 'work', 'projects'] as const;
export type BuiltinSidebarSectionId = typeof BUILTIN_SIDEBAR_SECTION_IDS[number];

export const SIDEBAR_SECTION_STATES = ['running', 'needs-answer', 'unread', 'failed', 'looks-done'] as const;
export type SidebarSectionState = typeof SIDEBAR_SECTION_STATES[number];
export const SIDEBAR_SECTION_WORK_STATES = ['in-work', 'done'] as const;
export type SidebarSectionWorkState = typeof SIDEBAR_SECTION_WORK_STATES[number];
export const SIDEBAR_SECTION_KINDS = ['session', 'worktree', 'space', 'run', 'scheduled'] as const;
export type SidebarSectionKind = typeof SIDEBAR_SECTION_KINDS[number];
export const SIDEBAR_SECTION_LINKS = ['pr', 'issue', 'tracker', 'plan', 'goal'] as const;
export type SidebarSectionLink = typeof SIDEBAR_SECTION_LINKS[number];
export const SIDEBAR_SECTION_ACTIVITY = ['any', 'today', 'two-days', 'week', 'stalled'] as const;
export type SidebarSectionActivity = typeof SIDEBAR_SECTION_ACTIVITY[number];

/** The pins a filter can ask for: the Pinned list, or one of the user's named lists by id. */
export const DEFAULT_PIN_LIST = 'pinned';

/**
 * Chips by category. Inside a category any chip matches; across categories
 * every category with a chip must match. An empty category asks nothing.
 */
export type SidebarSectionFilter = {
  states: readonly SidebarSectionState[];
  work: readonly SidebarSectionWorkState[];
  pins: readonly string[];
  kinds: readonly SidebarSectionKind[];
  links: readonly SidebarSectionLink[];
  projectIds: readonly string[];
  activity: SidebarSectionActivity;
  /**
   * Words to find in the work's title or branch, matched as the sidebar's
   * search matches them: every word somewhere in a session's title, the
   * worktree's name or its branch. Empty asks nothing.
   */
  text: string;
};

/**
 * `grouping: 'project'` lists whole projects under their headers (a group of
 * projects such as "Clients"), so its filter takes projects only, and it always
 * claims them: a project is drawn in one place.
 */
export type CustomSidebarSection = {
  kind: 'custom';
  id: string;
  name: string;
  grouping: 'time' | 'project';
  filter: SidebarSectionFilter;
  claims: boolean;
  hideWhenEmpty: boolean;
};

export type SidebarSectionEntry = { kind: 'builtin'; id: BuiltinSidebarSectionId } | CustomSidebarSection;

/** A named list of pins the user files works into with Pin to. */
export type SidebarPinList = { id: string; name: string };

export const SIDEBAR_SECTION_NAME_MAX = 60;
export const SIDEBAR_SECTIONS_MAX = 24;
export const SIDEBAR_PIN_LISTS_MAX = 24;
export const SIDEBAR_SECTION_TEXT_MAX = 100;

export const EMPTY_SIDEBAR_SECTION_FILTER: SidebarSectionFilter = Object.freeze({
  states: [], work: [], pins: [], kinds: [], links: [], projectIds: [], activity: 'any', text: '',
});


const idSchema = z.string().trim().min(1).max(64);
const nameSchema = z.string().trim().min(1).transform((value) => value.slice(0, SIDEBAR_SECTION_NAME_MAX));
// Chips the build does not know (a newer client's) are dropped, the rest kept once.
const chips = <const T extends readonly [string, ...string[]]>(values: T) => z.array(z.unknown()).transform((entries) => (
  [...new Set(entries.flatMap((entry) => {
    const parsed = z.enum(values).safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  }))]
));
// A project's id names its folder (`path_` and the path encoded), so it grows
// with the path; the ids this module makes itself stay short.
const projectIdSchema = z.string().trim().min(1).max(4096);
const idList = (schema: z.ZodType<string>) => z.array(z.unknown()).transform((entries) => (
  [...new Set(entries.flatMap((entry) => {
    const parsed = schema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  }))]
));
const ids = idList(idSchema);
const projectIds = idList(projectIdSchema);

const filterSchema = z.object({
  states: chips(SIDEBAR_SECTION_STATES).catch([]),
  work: chips(SIDEBAR_SECTION_WORK_STATES).catch([]),
  pins: ids.catch([]),
  kinds: chips(SIDEBAR_SECTION_KINDS).catch([]),
  links: chips(SIDEBAR_SECTION_LINKS).catch([]),
  projectIds: projectIds.catch([]),
  activity: z.enum(SIDEBAR_SECTION_ACTIVITY).catch('any'),
  text: z.string().transform((value) => value.trim().slice(0, SIDEBAR_SECTION_TEXT_MAX)).catch(''),
}).partial();

const customSchema = z.object({
  kind: z.literal('custom'),
  id: idSchema,
  name: nameSchema,
  grouping: z.enum(['time', 'project']).catch('time'),
  filter: filterSchema.catch({}),
  claims: z.boolean().catch(false),
  hideWhenEmpty: z.boolean().catch(true),
});

const builtinIdSchema = z.enum(BUILTIN_SIDEBAR_SECTION_IDS);
const builtinSchema = z.object({ kind: z.literal('builtin'), id: builtinIdSchema });

const toFilter = (filter: z.infer<typeof filterSchema>, grouping: 'time' | 'project'): SidebarSectionFilter => (
  // A group of projects lists whole projects; the other chips do not apply to it.
  grouping === 'project'
    ? { ...EMPTY_SIDEBAR_SECTION_FILTER, projectIds: filter.projectIds ?? [] }
    : {
      states: filter.states ?? [],
      work: filter.work ?? [],
      pins: filter.pins ?? [],
      kinds: filter.kinds ?? [],
      links: filter.links ?? [],
      projectIds: filter.projectIds ?? [],
      activity: filter.activity ?? 'any',
      text: filter.text ?? '',
    }
);

/**
 * The stored list made whole: invalid and repeated entries dropped, and every
 * built-in section present. A built-in one missing from the list (a list saved
 * before it existed) goes back where the default order puts it.
 */
export const DEFAULT_SIDEBAR_SECTIONS: readonly SidebarSectionEntry[] = BUILTIN_SIDEBAR_SECTION_IDS.map((id) => ({ kind: 'builtin', id }));

export const sidebarSectionsSchema = z.array(z.unknown()).transform((stored): SidebarSectionEntry[] => {
  const entries: SidebarSectionEntry[] = [];
  const seen = new Set<string>();
  for (const raw of stored) {
    const builtin = builtinSchema.safeParse(raw);
    if (builtin.success) {
      if (seen.has(builtin.data.id)) continue;
      seen.add(builtin.data.id);
      entries.push({ kind: 'builtin', id: builtin.data.id });
      continue;
    }
    const custom = customSchema.safeParse(raw);
    if (!custom.success || seen.has(custom.data.id) || builtinIdSchema.safeParse(custom.data.id).success) continue;
    if (entries.filter((entry) => entry.kind === 'custom').length >= SIDEBAR_SECTIONS_MAX) continue;
    seen.add(custom.data.id);
    entries.push({
      ...custom.data,
      filter: toFilter(custom.data.filter, custom.data.grouping),
      // A project shows in one place: a group of projects always takes its own.
      claims: custom.data.grouping === 'project' ? true : custom.data.claims,
    });
  }
  BUILTIN_SIDEBAR_SECTION_IDS.forEach((id, defaultIndex) => {
    if (seen.has(id)) return;
    // After the built-in section that precedes it by default, else first.
    const previous = BUILTIN_SIDEBAR_SECTION_IDS.slice(0, defaultIndex).reverse().find((candidate) => seen.has(candidate));
    const at = previous ? entries.findIndex((entry) => entry.kind === 'builtin' && entry.id === previous) + 1 : 0;
    entries.splice(at, 0, { kind: 'builtin', id });
    seen.add(id);
  });
  return entries;
});

export const sidebarPinListsSchema = z.array(z.unknown()).transform((stored): SidebarPinList[] => {
  const lists: SidebarPinList[] = [];
  const seen = new Set<string>([DEFAULT_PIN_LIST]);
  for (const raw of stored) {
    const parsed = z.object({ id: idSchema, name: nameSchema }).safeParse(raw);
    if (!parsed.success || seen.has(parsed.data.id) || lists.length >= SIDEBAR_PIN_LISTS_MAX) continue;
    seen.add(parsed.data.id);
    lists.push(parsed.data);
  }
  return lists;
});

export const hiddenSidebarSectionsSchema = ids;

/** A fresh id for a section or a pin list. */
export const createSidebarSectionId = (): string => (
  `s${Date.now().toString(36)}${Math.floor(Math.random() * 0x100000).toString(36)}`
);

/**
 * Whether a filter asks for anything. A section that asks nothing lists
 * nothing: listing every work would repeat the whole sidebar in it.
 */
export const hasSidebarSectionConditions = (filter: SidebarSectionFilter): boolean => (
  filter.states.length > 0
  || filter.work.length > 0
  || filter.pins.length > 0
  || filter.kinds.length > 0
  || filter.links.length > 0
  || filter.projectIds.length > 0
  || filter.activity !== 'any'
  || filter.text.trim() !== ''
);

/** Whether a section asks for plans, which live with the project's knowledge, not with the session. */
export const sidebarSectionReadsPlans = (filter: SidebarSectionFilter): boolean => filter.links.includes('plan');

/** Whether a section's filter reads live state, which changes on every turn. */
export const sidebarSectionReadsLiveState = (filter: SidebarSectionFilter): boolean => (
  filter.states.some((state) => state !== 'looks-done')
);

/** What the filter is matched against: one work's facts. */
export type SidebarWorkFacts = {
  /** What the work is; a scheduled task's run is also a session or a worktree, so it is its own fact. */
  kind: Exclude<SidebarSectionKind, 'scheduled'>;
  /** A scheduled task started one of its top-level sessions. */
  scheduled: boolean;
  projectId: string | null;
  /** The pin list the work is filed in (`DEFAULT_PIN_LIST` for Pinned), or null. */
  pin: string | null;
  inWork: boolean;
  done: boolean;
  running: boolean;
  needsAnswer: boolean;
  unread: boolean;
  /** The last turn of a top-level session in it failed. */
  failed: boolean;
  looksDone: boolean;
  hasPr: boolean;
  /** An issue on a repository or another service, not a tracker's. */
  hasIssue: boolean;
  /** A tracker's work item, such as a Linear issue. */
  hasTrackerItem: boolean;
  /** A project plan was sent to one of its sessions. */
  hasPlan: boolean;
  hasGoal: boolean;
  /** The latest activity in the work, in ms; 0 when unknown. */
  lastActivityAt: number;
  /** What the text condition reads: the titles of its top-level sessions, the worktree's name and branch. */
  texts: readonly string[];
};

const DAY_MS = 24 * 60 * 60 * 1000;
// A work nobody has touched for this long has stalled (the Overview's rule).
const STALLED_MS = 3 * DAY_MS;

const startOfLocalDay = (now: number): number => {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

const matchesActivity = (activity: SidebarSectionActivity, lastActivityAt: number, now: number): boolean => {
  switch (activity) {
    case 'any': return true;
    case 'today': return lastActivityAt >= startOfLocalDay(now);
    case 'two-days': return lastActivityAt >= startOfLocalDay(startOfLocalDay(now) - 1);
    case 'week': return lastActivityAt >= now - 7 * DAY_MS;
    case 'stalled': return lastActivityAt > 0 && lastActivityAt < now - STALLED_MS;
  }
};

const matchesState = (state: SidebarSectionState, facts: SidebarWorkFacts): boolean => {
  switch (state) {
    case 'running': return facts.running;
    case 'needs-answer': return facts.needsAnswer;
    case 'unread': return facts.unread;
    case 'failed': return facts.failed;
    case 'looks-done': return facts.looksDone;
  }
};

const matchesLink = (link: SidebarSectionLink, facts: SidebarWorkFacts): boolean => {
  switch (link) {
    case 'pr': return facts.hasPr;
    case 'issue': return facts.hasIssue;
    case 'tracker': return facts.hasTrackerItem;
    case 'plan': return facts.hasPlan;
    case 'goal': return facts.hasGoal;
  }
};

export const matchesSidebarSectionFilter = (filter: SidebarSectionFilter, facts: SidebarWorkFacts, now: number): boolean => {
  if (filter.states.length > 0 && !filter.states.some((state) => matchesState(state, facts))) return false;
  if (filter.work.length > 0 && !filter.work.some((state) => (state === 'in-work' ? facts.inWork : facts.done))) return false;
  if (filter.pins.length > 0 && (facts.pin === null || !filter.pins.includes(facts.pin))) return false;
  if (filter.kinds.length > 0 && !filter.kinds.some((kind) => (kind === 'scheduled' ? facts.scheduled : kind === facts.kind))) return false;
  if (filter.links.length > 0 && !filter.links.some((link) => matchesLink(link, facts))) return false;
  if (filter.projectIds.length > 0 && (facts.projectId === null || !filter.projectIds.includes(facts.projectId))) return false;
  if (filter.text.trim() !== '' && !matchesRankQuery(facts.texts, filter.text, SIDEBAR_SEARCH)) return false;
  return matchesActivity(filter.activity, facts.lastActivityAt, now);
};

/** The starting points the section editor offers; names are set by the editor, translated. */
const SIDEBAR_SECTION_TEMPLATES = ['waiting', 'running', 'prs', 'stalled', 'today', 'projects', 'blank'] as const;
export type SidebarSectionTemplate = typeof SIDEBAR_SECTION_TEMPLATES[number];

export const createSidebarSectionFromTemplate = (template: SidebarSectionTemplate, name: string): CustomSidebarSection => {
  const base: CustomSidebarSection = {
    kind: 'custom', id: createSidebarSectionId(), name, grouping: 'time', filter: EMPTY_SIDEBAR_SECTION_FILTER, claims: false, hideWhenEmpty: true,
  };
  switch (template) {
    case 'waiting': return { ...base, filter: { ...EMPTY_SIDEBAR_SECTION_FILTER, states: ['needs-answer', 'unread'] } };
    case 'running': return { ...base, filter: { ...EMPTY_SIDEBAR_SECTION_FILTER, states: ['running'] } };
    case 'prs': return { ...base, filter: { ...EMPTY_SIDEBAR_SECTION_FILTER, links: ['pr'] } };
    case 'stalled': return { ...base, filter: { ...EMPTY_SIDEBAR_SECTION_FILTER, work: ['in-work'], activity: 'stalled' } };
    case 'today': return { ...base, filter: { ...EMPTY_SIDEBAR_SECTION_FILTER, activity: 'today' } };
    case 'projects': return { ...base, grouping: 'project', claims: true, hideWhenEmpty: false };
    case 'blank': return base;
  }
};
