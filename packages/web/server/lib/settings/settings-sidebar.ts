import { z } from 'zod';
import type { JsonValue } from '../shared/json-values.js';
import type { SanitizedSettings, SettingsDocument } from './settings-helpers.js';

const SIDEBAR_BUILTIN_SECTION_IDS = ['pages', 'chats', 'pinned', 'work', 'projects'];
const SIDEBAR_SECTIONS_STORED_MAX = 24 + SIDEBAR_BUILTIN_SECTION_IDS.length;
const sidebarSectionIdSchema = z.string().trim().min(1).max(64);
const sidebarSectionNameSchema = z.string().trim().min(1).transform((value) => value.slice(0, 60));
const sidebarChips = (values: string[]) => z.array(z.unknown()).transform((entries) => (
  [...new Set(entries.flatMap((entry) => {
    const parsed = z.enum(values).safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  }))]
));
const sidebarIdList = (schema: z.ZodString) => z.array(z.unknown()).transform((entries) => (
  [...new Set(entries.flatMap((entry) => {
    const parsed = schema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  }))]
));
const sidebarIds = sidebarIdList(sidebarSectionIdSchema);
const sidebarProjectIds = sidebarIdList(z.string().trim().min(1).max(4096));
const sidebarPageIds = sidebarIdList(z.string().trim().min(1).max(128));
const sidebarSectionSchema = z.union([
  z.object({ kind: z.literal('builtin'), id: z.enum(SIDEBAR_BUILTIN_SECTION_IDS) }),
  z.object({
    kind: z.literal('custom'),
    id: sidebarSectionIdSchema,
    name: sidebarSectionNameSchema,
    grouping: z.enum(['time', 'project']).catch('time'),
    filter: z.object({
      states: sidebarChips(['running', 'needs-answer', 'unread', 'failed', 'looks-done']).catch([]),
      work: sidebarChips(['in-work', 'done']).catch([]),
      pins: sidebarIds.catch([]),
      kinds: sidebarChips(['session', 'worktree', 'space', 'run', 'scheduled']).catch([]),
      links: sidebarChips(['pr', 'issue', 'tracker', 'plan', 'goal']).catch([]),
      projectIds: sidebarProjectIds.catch([]),
      folders: sidebarIds.catch([]),
      activity: z.enum(['any', 'today', 'two-days', 'week', 'stalled']).catch('any'),
      text: z.union([z.string().transform((value) => [value]), z.array(z.unknown())]).transform((entries) => (
        [...new Set(entries.flatMap((entry) => {
          const phrase = z.string().trim().transform((value) => value.slice(0, 100)).safeParse(entry);
          return phrase.success && phrase.data ? [phrase.data] : [];
        }))].slice(0, 12)
      )).catch([]),
    }).partial().catch({}),
    claims: z.boolean().catch(false),
    hideWhenEmpty: z.boolean().catch(true),
  }),
]);

export type SidebarSection = z.infer<typeof sidebarSectionSchema>;

export const sanitizeSidebarSections = (entries: readonly JsonValue[] | readonly unknown[]) => {
  const result: SidebarSection[] = [];
  const seen = new Set();
  for (const entry of entries) {
    const parsed = sidebarSectionSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.id) || result.length >= SIDEBAR_SECTIONS_STORED_MAX) continue;
    if (parsed.data.kind === 'custom' && SIDEBAR_BUILTIN_SECTION_IDS.includes(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    result.push(parsed.data);
  }
  return result;
};

export const keepOmittedBuiltinSections = (stored: SidebarSection[], incoming: SidebarSection[]) => {
  const result = [...incoming];
  const has = (id: string) => result.some((entry) => entry.id === id);
  stored.forEach((entry, index) => {
    if (entry?.kind !== 'builtin' || has(entry.id)) return;
    const previous = stored.slice(0, index).reverse().find((candidate) => has(candidate?.id));
    const at = previous ? result.findIndex((candidate) => candidate.id === previous.id) + 1 : 0;
    result.splice(at, 0, entry);
  });
  return result;
};

const sanitizeSidebarPinLists = (entries: readonly unknown[]) => {
  const result: { id: string; name: string }[] = [];
  const seen = new Set(['pinned']);
  for (const entry of entries) {
    const parsed = z.object({ id: sidebarSectionIdSchema, name: sidebarSectionNameSchema }).safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.id) || result.length >= 24) continue;
    seen.add(parsed.data.id);
    result.push(parsed.data);
  }
  return result;
};

export const sanitizeSidebarSettings = (candidate: SettingsDocument, result: SanitizedSettings) => {
  if (Array.isArray(candidate.sidebarSections)) {
    result.sidebarSections = sanitizeSidebarSections(candidate.sidebarSections);
  }
  if (Array.isArray(candidate.sidebarPinLists)) {
    result.sidebarPinLists = sanitizeSidebarPinLists(candidate.sidebarPinLists);
  }
  if (Array.isArray(candidate.sidebarHiddenSections)) {
    result.sidebarHiddenSections = [...new Set(candidate.sidebarHiddenSections.flatMap((entry) => {
      const parsed = sidebarSectionIdSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    }))];
  }
  for (const key of ['sidebarPageOrder', 'sidebarHiddenPages'] as const) {
    if (Array.isArray(candidate[key])) result[key] = sidebarPageIds.parse(candidate[key]);
  }
};
