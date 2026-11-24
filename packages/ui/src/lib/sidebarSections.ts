import { z } from 'zod';
import { matchesRankQuery, SIDEBAR_SEARCH } from '@/lib/search/fuzzySearch';


const BUILTIN_SIDEBAR_SECTION_IDS = ['pages', 'chats', 'pinned', 'work', 'projects'] as const;
export type BuiltinSidebarSectionId = typeof BUILTIN_SIDEBAR_SECTION_IDS[number];

export const SIDEBAR_SECTION_STATES = ['running', 'needs-answer', 'unread', 'failed', 'looks-done'] as const;
export type SidebarSectionState = typeof SIDEBAR_SECTION_STATES[number];
export const SIDEBAR_SECTION_WORK_STATES = ['in-work', 'done'] as const;
export type SidebarSectionWorkState = typeof SIDEBAR_SECTION_WORK_STATES[number];
export const SIDEBAR_SECTION_KINDS = ['session', 'lead', 'worktree', 'space', 'run', 'scheduled'] as const;
export type SidebarSectionKind = typeof SIDEBAR_SECTION_KINDS[number];
export const SIDEBAR_SECTION_LINKS = ['pr', 'issue', 'tracker', 'plan', 'goal'] as const;
export type SidebarSectionLink = typeof SIDEBAR_SECTION_LINKS[number];
export const SIDEBAR_SECTION_ACTIVITY = ['any', 'today', 'two-days', 'week', 'stalled'] as const;
export type SidebarSectionActivity = typeof SIDEBAR_SECTION_ACTIVITY[number];

export const DEFAULT_PIN_LIST = 'pinned';

export type SidebarSectionFilter = {
  states: readonly SidebarSectionState[];
  work: readonly SidebarSectionWorkState[];
  pins: readonly string[];
  kinds: readonly SidebarSectionKind[];
  links: readonly SidebarSectionLink[];
  projectIds: readonly string[];
  folders: readonly string[];
  activity: SidebarSectionActivity;
  text: readonly string[];
};

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

export type SidebarPinList = { id: string; name: string };

export const SIDEBAR_SECTION_NAME_MAX = 60;
export const SIDEBAR_SECTIONS_MAX = 24;
export const SIDEBAR_PIN_LISTS_MAX = 24;
export const SIDEBAR_SECTION_TEXT_MAX = 100;
export const SIDEBAR_SECTION_PHRASES_MAX = 12;

export const SIDEBAR_SESSION_BATCH_DEFAULT = 7;
export const SIDEBAR_SESSION_BATCH_MIN = 3;
export const SIDEBAR_SESSION_BATCH_MAX = 50;
export const clampSessionBatchSize = (size: number): number => (
  Math.max(SIDEBAR_SESSION_BATCH_MIN, Math.min(SIDEBAR_SESSION_BATCH_MAX, Math.round(size)))
);

export const EMPTY_SIDEBAR_SECTION_FILTER: SidebarSectionFilter = Object.freeze({
  states: [], work: [], pins: [], kinds: [], links: [], projectIds: [], folders: [], activity: 'any', text: [],
});


const idSchema = z.string().trim().min(1).max(64);
const phraseSchema = z.string().trim().transform((value) => value.slice(0, SIDEBAR_SECTION_TEXT_MAX));
const nameSchema = z.string().trim().min(1).transform((value) => value.slice(0, SIDEBAR_SECTION_NAME_MAX));
const chips = <const T extends readonly [string, ...string[]]>(values: T) => z.array(z.unknown()).transform((entries) => (
  [...new Set(entries.flatMap((entry) => {
    const parsed = z.enum(values).safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  }))]
));
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
  folders: ids.catch([]),
  activity: z.enum(SIDEBAR_SECTION_ACTIVITY).catch('any'),
  text: z.union([z.string().transform((value) => [value]), z.array(z.unknown())]).transform((entries) => (
    [...new Set(entries.flatMap((entry) => {
      const phrase = phraseSchema.safeParse(entry);
      return phrase.success && phrase.data ? [phrase.data] : [];
    }))].slice(0, SIDEBAR_SECTION_PHRASES_MAX)
  )).catch([]),
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
  grouping === 'project'
    ? { ...EMPTY_SIDEBAR_SECTION_FILTER, projectIds: filter.projectIds ?? [] }
    : {
      states: filter.states ?? [],
      work: filter.work ?? [],
      pins: filter.pins ?? [],
      kinds: filter.kinds ?? [],
      links: filter.links ?? [],
      projectIds: filter.projectIds ?? [],
      folders: filter.folders ?? [],
      activity: filter.activity ?? 'any',
      text: filter.text ?? [],
    }
);

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
      claims: custom.data.grouping === 'project' ? true : custom.data.claims,
    });
  }
  BUILTIN_SIDEBAR_SECTION_IDS.forEach((id, defaultIndex) => {
    if (seen.has(id)) return;
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

export const sidebarPageIdsSchema = idList(z.string().trim().min(1).max(128));

export const createSidebarSectionId = (): string => (
  `s${Date.now().toString(36)}${Math.floor(Math.random() * 0x100000).toString(36)}`
);

export const hasSidebarSectionConditions = (filter: SidebarSectionFilter): boolean => (
  filter.states.length > 0
  || filter.work.length > 0
  || filter.pins.length > 0
  || filter.kinds.length > 0
  || filter.links.length > 0
  || filter.projectIds.length > 0
  || filter.folders.length > 0
  || filter.activity !== 'any'
  || filter.text.length > 0
);

export const sidebarSectionReadsPlans = (filter: SidebarSectionFilter): boolean => filter.links.includes('plan');

export const sidebarSectionReadsLiveState = (filter: SidebarSectionFilter): boolean => (
  filter.states.some((state) => state !== 'looks-done')
);

export type SidebarWorkFacts = {
  kind: Exclude<SidebarSectionKind, 'scheduled' | 'lead'>;
  lead: boolean;
  scheduled: boolean;
  projectId: string | null;
  folderId: string | null;
  pin: string | null;
  inWork: boolean;
  done: boolean;
  running: boolean;
  needsAnswer: boolean;
  unread: boolean;
  failed: boolean;
  looksDone: boolean;
  hasPr: boolean;
  hasIssue: boolean;
  hasTrackerItem: boolean;
  hasPlan: boolean;
  hasGoal: boolean;
  lastActivityAt: number;
  texts: readonly string[];
};

const DAY_MS = 24 * 60 * 60 * 1000;
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

const matchesKind = (kind: SidebarSectionKind, facts: SidebarWorkFacts): boolean => {
  if (kind === 'scheduled') return facts.scheduled;
  if (kind === 'lead') return facts.lead;
  return kind === facts.kind;
};

export const matchesSidebarSectionFilter = (filter: SidebarSectionFilter, facts: SidebarWorkFacts, now: number): boolean => {
  if (filter.states.length > 0 && !filter.states.some((state) => matchesState(state, facts))) return false;
  if (filter.work.length > 0 && !filter.work.some((state) => (state === 'in-work' ? facts.inWork : facts.done))) return false;
  if (filter.pins.length > 0 && (facts.pin === null || !filter.pins.includes(facts.pin))) return false;
  if (filter.kinds.length > 0 && !filter.kinds.some((kind) => matchesKind(kind, facts))) return false;
  if (filter.links.length > 0 && !filter.links.some((link) => matchesLink(link, facts))) return false;
  if (filter.projectIds.length > 0 && (facts.projectId === null || !filter.projectIds.includes(facts.projectId))) return false;
  if (filter.folders.length > 0 && (facts.folderId === null || !filter.folders.includes(facts.folderId))) return false;
  if (filter.text.length > 0 && !filter.text.some((phrase) => matchesRankQuery(facts.texts, phrase, SIDEBAR_SEARCH))) return false;
  return matchesActivity(filter.activity, facts.lastActivityAt, now);
};

const SIDEBAR_SECTION_TEMPLATES = ['recent', 'waiting', 'running', 'prs', 'stalled', 'today', 'projects', 'blank'] as const;
export type SidebarSectionTemplate = typeof SIDEBAR_SECTION_TEMPLATES[number];

export const createSidebarSectionFromTemplate = (template: SidebarSectionTemplate, name: string): CustomSidebarSection => {
  const base: CustomSidebarSection = {
    kind: 'custom', id: createSidebarSectionId(), name, grouping: 'time', filter: EMPTY_SIDEBAR_SECTION_FILTER, claims: false, hideWhenEmpty: true,
  };
  switch (template) {
    case 'recent': return { ...base, filter: { ...EMPTY_SIDEBAR_SECTION_FILTER, activity: 'week' } };
    case 'waiting': return { ...base, filter: { ...EMPTY_SIDEBAR_SECTION_FILTER, states: ['needs-answer', 'unread'] } };
    case 'running': return { ...base, filter: { ...EMPTY_SIDEBAR_SECTION_FILTER, states: ['running'] } };
    case 'prs': return { ...base, filter: { ...EMPTY_SIDEBAR_SECTION_FILTER, links: ['pr'] } };
    case 'stalled': return { ...base, filter: { ...EMPTY_SIDEBAR_SECTION_FILTER, work: ['in-work'], activity: 'stalled' } };
    case 'today': return { ...base, filter: { ...EMPTY_SIDEBAR_SECTION_FILTER, activity: 'today' } };
    case 'projects': return { ...base, grouping: 'project', claims: true, hideWhenEmpty: false };
    case 'blank': return base;
  }
};
