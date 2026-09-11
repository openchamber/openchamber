/**
 * Boundary parsers for settings values. Every value that arrives from the
 * server, the VS Code bridge, or browser storage passes through one of these
 * before it is trusted; `undefined` means "reject", never "default".
 *
 * These are the value-level rules the registry (`./registry.ts`) attaches to
 * each key. They are zod schemas wrapped into one function shape so the
 * registry can hold hand-written and schema-derived parsers alike, and so the
 * registry can be evaluated for its shape (the generated JSON snapshot)
 * without a browser.
 */
import { z, type ZodType } from 'zod';

import type { ProjectEntry } from '@/lib/api/types';
import { createProjectIdFromPath } from '@/lib/projectId';

/**
 * `raw` is the whole untrusted document, for the few legacy keys whose value
 * is derived from a sibling (`queueModeEnabled` → `followUpBehavior`).
 */
export type SettingsParser<T> = (value: unknown, raw: SettingsRawDocument) => T | undefined;

/** The untrusted document as received; only ever read through a parser. */
export type SettingsRawDocument = Readonly<Record<string, unknown>>;

export type ModelRef = { providerID: string; modelID: string };

export type NotificationTemplates = {
  completion: { title: string; message: string };
  error: { title: string; message: string };
  question: { title: string; message: string };
  subtask: { title: string; message: string };
};

export type UsageModelGroups = Record<string, {
  customGroups?: Array<{ id: string; label: string; models: string[]; order: number }>;
  modelAssignments?: Record<string, string>;
  renamedGroups?: Record<string, string>;
}>;

export type ManagedRemoteTunnelPreset = { id: string; name: string; hostname: string };

export type SkillCatalogConfig = {
  id: string;
  label: string;
  source: string;
  subpath?: string;
  gitIdentityId?: string;
};

/** Wrap a schema as a parser: success yields the parsed value, failure yields `undefined`. */
export const fromSchema = <T>(schema: ZodType<T>): SettingsParser<T> => (value) => {
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
};

const finiteNumber = z.number().refine(Number.isFinite);
const trimmed = z.string().transform((value) => value.trim());
const nonEmptyTrimmed = trimmed.pipe(z.string().min(1));
const looseObject = z.record(z.string(), z.unknown());

export const parseBoolean = fromSchema(z.boolean());

/** A non-empty string, kept verbatim. */
export const parseNonEmptyString = fromSchema(z.string().min(1));

/** Any string, trimmed; empty stays empty (some keys use '' as "unset"). */
export const parseTrimmedString = fromSchema(trimmed);

/** A trimmed string that is only accepted when something is left after trimming. */
export const parseNonEmptyTrimmedString = fromSchema(nonEmptyTrimmed);

/** Free text with an upper bound, kept verbatim (whitespace is content here). */
export const parseTextUpTo = (maxLength: number): SettingsParser<string> => fromSchema(z.string().max(maxLength));

export const parseTrimmedStringUpTo = (maxLength: number): SettingsParser<string> => fromSchema(
  trimmed.transform((value) => value.slice(0, maxLength)),
);

export const parseOneOf = <const T extends readonly [string, ...string[]]>(options: T): SettingsParser<T[number]> => fromSchema(
  trimmed.pipe(z.enum(options)),
);

export const parseFiniteNumber = fromSchema(finiteNumber);

export const parseIntegerInRange = (min: number, max: number): SettingsParser<number> => fromSchema(
  finiteNumber.transform((value) => Math.max(min, Math.min(max, Math.round(value)))),
);

export const parseIntegerAtLeast = (min: number): SettingsParser<number> => fromSchema(
  finiteNumber.transform((value) => Math.max(min, Math.round(value))),
);

export const parsePositiveInteger = fromSchema(finiteNumber.positive().transform(Math.floor));

/** `null` clears the value; a finite number keeps it. */
export const parseNullableFiniteNumber = fromSchema(z.union([z.null(), finiteNumber]));

/** `null` clears the value; a non-empty trimmed string keeps it; '' becomes null. */
export const parseNullableTrimmedPath = fromSchema(
  z.union([z.null(), trimmed.transform((value) => (value.length > 0 ? value : null))]),
);

export const parseNullableTrimmedString = fromSchema(z.union([z.null(), trimmed]));

const stringEntries = z.array(z.unknown()).transform((entries) => entries.filter((entry) => z.string().min(1).safeParse(entry).success));

/** Distinct non-empty strings, order preserved. */
export const parseStringSet = fromSchema(stringEntries.transform((entries) => Array.from(new Set(entries.map(String)))));

/** Non-empty strings, duplicates kept (order is the user's). */
export const parseStringList = fromSchema(stringEntries.transform((entries) => entries.map(String)));

const stringListRecord = looseObject.transform((record) => {
  const result: Record<string, string[]> = {};
  for (const [key, entries] of Object.entries(record)) {
    const parsed = z.array(z.unknown()).safeParse(entries);
    if (parsed.success) {
      result[key] = parsed.data.filter((entry) => z.string().safeParse(entry).success).map(String);
    }
  }
  return result;
});

export const parseStringRecordOfStringLists = fromSchema(
  stringListRecord.pipe(z.record(z.string(), z.array(z.string())).refine((record) => Object.keys(record).length > 0)),
);

const modelRefSchema = z.object({
  providerID: nonEmptyTrimmed,
  modelID: nonEmptyTrimmed,
});

export const parseModelRefs = (limit: number): SettingsParser<ModelRef[]> => fromSchema(
  z.array(z.unknown()).transform((entries) => {
    const result: ModelRef[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const parsed = modelRefSchema.safeParse(entry);
      if (!parsed.success) continue;
      const key = `${parsed.data.providerID}/${parsed.data.modelID}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(parsed.data);
      if (result.length >= limit) break;
    }
    return result;
  }),
);

export const parseRecentEfforts = fromSchema(
  looseObject.transform((record) => {
    const result: Record<string, string[]> = {};
    for (const [key, variants] of Object.entries(record)) {
      if (!key) continue;
      const parsed = stringEntries.safeParse(variants);
      if (!parsed.success) continue;
      const unique = Array.from(new Set(parsed.data.map(String)));
      if (unique.length > 0) result[key] = unique.slice(0, 5);
    }
    return result;
  }).refine((record) => Object.keys(record).length > 0),
);

export const parseShortcutOverrides = fromSchema(
  looseObject.transform((record) => {
    const result: Record<string, string> = {};
    for (const [key, combo] of Object.entries(record)) {
      const normalizedKey = key.trim();
      const normalizedCombo = nonEmptyTrimmed.safeParse(combo);
      if (!normalizedKey || !normalizedCombo.success) continue;
      result[normalizedKey] = normalizedCombo.data;
    }
    return result;
  }),
);

const DEFAULT_NOTIFICATION_TEMPLATES: NotificationTemplates = {
  completion: { title: 'Task Complete', message: 'Your task has finished.' },
  error: { title: 'Error Occurred', message: 'An error occurred while processing your task.' },
  question: { title: 'Input Needed', message: 'Please provide input to continue.' },
  subtask: { title: 'Subtask Complete', message: 'A subtask has finished.' },
};

const notificationTemplateSchema = z.object({
  title: z.string().catch(''),
  message: z.string().catch(''),
});

export const parseNotificationTemplates = fromSchema(
  looseObject.transform((record) => {
    const read = (key: keyof NotificationTemplates) => {
      const parsed = notificationTemplateSchema.safeParse(record[key]);
      return parsed.success ? parsed.data : undefined;
    };
    const completion = read('completion');
    const error = read('error');
    const question = read('question');
    const subtask = read('subtask');
    if (!completion && !error && !question && !subtask) return undefined;
    return {
      completion: completion ?? DEFAULT_NOTIFICATION_TEMPLATES.completion,
      error: error ?? DEFAULT_NOTIFICATION_TEMPLATES.error,
      question: question ?? DEFAULT_NOTIFICATION_TEMPLATES.question,
      subtask: subtask ?? DEFAULT_NOTIFICATION_TEMPLATES.subtask,
    };
  }).pipe(z.custom<NotificationTemplates>((value) => value !== undefined)),
);

const stringMap = looseObject.transform((record) => Object.fromEntries(
  Object.entries(record).flatMap(([key, value]) => {
    const parsed = z.string().safeParse(value);
    return parsed.success ? [[key, parsed.data] as const] : [];
  }),
));

const customGroupSchema = z.object({
  id: z.unknown().transform((value) => String(value ?? '')),
  label: z.unknown().transform((value) => String(value ?? '')),
  models: z.array(z.unknown()).transform((models) => models.filter((model) => z.string().safeParse(model).success).map(String)).catch([]),
  order: z.number().catch(0),
});

export const parseUsageModelGroups = fromSchema(
  looseObject.transform((record) => {
    const result: UsageModelGroups = {};
    for (const [providerId, config] of Object.entries(record)) {
      const parsedConfig = looseObject.safeParse(config);
      if (!parsedConfig.success) continue;
      const providerConfig: UsageModelGroups[string] = {};
      const customGroups = z.array(z.unknown()).safeParse(parsedConfig.data.customGroups);
      if (customGroups.success) {
        providerConfig.customGroups = customGroups.data.flatMap((group) => {
          const parsed = customGroupSchema.safeParse(group);
          return parsed.success ? [parsed.data] : [];
        });
      }
      const modelAssignments = stringMap.safeParse(parsedConfig.data.modelAssignments);
      if (modelAssignments.success) providerConfig.modelAssignments = modelAssignments.data;
      const renamedGroups = stringMap.safeParse(parsedConfig.data.renamedGroups);
      if (renamedGroups.success) providerConfig.renamedGroups = renamedGroups.data;
      if (Object.keys(providerConfig).length > 0) result[providerId] = providerConfig;
    }
    return result;
  }).refine((record) => Object.keys(record).length > 0),
);

const managedRemoteTunnelPresetSchema = z.object({
  id: nonEmptyTrimmed,
  name: nonEmptyTrimmed,
  hostname: nonEmptyTrimmed.transform((value) => value.toLowerCase()),
});

export const parseManagedRemoteTunnelPresets = fromSchema(
  z.array(z.unknown()).transform((entries) => {
    const result: ManagedRemoteTunnelPreset[] = [];
    const seenIds = new Set<string>();
    const seenHostnames = new Set<string>();
    for (const entry of entries) {
      const parsed = managedRemoteTunnelPresetSchema.safeParse(entry);
      if (!parsed.success) continue;
      if (seenIds.has(parsed.data.id) || seenHostnames.has(parsed.data.hostname)) continue;
      seenIds.add(parsed.data.id);
      seenHostnames.add(parsed.data.hostname);
      result.push(parsed.data);
    }
    return result;
  }),
);

export const parseManagedRemoteTunnelPresetTokens = fromSchema(
  looseObject.transform((record) => {
    const result: Record<string, string> = {};
    for (const [key, token] of Object.entries(record)) {
      const id = key.trim();
      const parsedToken = nonEmptyTrimmed.safeParse(token);
      if (!id || !parsedToken.success) continue;
      result[id] = parsedToken.data;
    }
    return result;
  }).refine((record) => Object.keys(record).length > 0),
);

const skillCatalogSchema = z.object({
  id: nonEmptyTrimmed,
  label: nonEmptyTrimmed,
  source: nonEmptyTrimmed,
  subpath: trimmed.optional().catch(undefined),
  gitIdentityId: trimmed.optional().catch(undefined),
});

export const parseSkillCatalogs = fromSchema(
  z.array(z.unknown()).transform((entries) => {
    const result: SkillCatalogConfig[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const parsed = skillCatalogSchema.safeParse(entry);
      if (!parsed.success || seen.has(parsed.data.id)) continue;
      seen.add(parsed.data.id);
      const catalog: SkillCatalogConfig = { id: parsed.data.id, label: parsed.data.label, source: parsed.data.source };
      if (parsed.data.subpath) catalog.subpath = parsed.data.subpath;
      if (parsed.data.gitIdentityId) catalog.gitIdentityId = parsed.data.gitIdentityId;
      result.push(catalog);
    }
    return result;
  }),
);

const HEX_COLOR_PATTERN = /^#(?:[\da-fA-F]{3}|[\da-fA-F]{6})$/;

const nonNegativeFinite = finiteNumber.nonnegative();

const projectEntrySchema = z.object({
  path: nonEmptyTrimmed,
  label: nonEmptyTrimmed.optional().catch(undefined),
  icon: nonEmptyTrimmed.optional().catch(undefined),
  iconImage: z.union([
    z.null(),
    z.object({
      mime: nonEmptyTrimmed,
      updatedAt: nonNegativeFinite.transform(Math.round).pipe(z.number().positive()),
      source: z.enum(['custom', 'auto']),
    }),
  ]).optional().catch(undefined),
  color: nonEmptyTrimmed.optional().catch(undefined),
  iconBackground: z.union([
    z.null(),
    trimmed.pipe(z.string().regex(HEX_COLOR_PATTERN)).transform((value) => value.toLowerCase()),
  ]).optional().catch(undefined),
  addedAt: nonNegativeFinite.optional().catch(undefined),
  lastOpenedAt: nonNegativeFinite.optional().catch(undefined),
  sidebarCollapsed: z.boolean().optional().catch(undefined),
});

export const parseProjects = fromSchema(
  z.array(z.unknown()).transform((entries) => {
    const result: ProjectEntry[] = [];
    const seenIds = new Set<string>();
    const seenPaths = new Set<string>();
    for (const entry of entries) {
      const parsed = projectEntrySchema.safeParse(entry);
      if (!parsed.success) continue;
      const rawPath = parsed.data.path;
      const normalizedPath = rawPath === '/' ? rawPath : rawPath.replace(/\\/g, '/').replace(/\/+$/, '');
      if (!normalizedPath) continue;
      const id = createProjectIdFromPath(normalizedPath);
      if (!id || seenIds.has(id) || seenPaths.has(normalizedPath)) continue;
      seenIds.add(id);
      seenPaths.add(normalizedPath);

      const project: ProjectEntry = { id, path: normalizedPath };
      if (parsed.data.label) project.label = parsed.data.label;
      if (parsed.data.icon) project.icon = parsed.data.icon;
      if (parsed.data.iconImage !== undefined) project.iconImage = parsed.data.iconImage;
      if (parsed.data.color) project.color = parsed.data.color;
      if (parsed.data.iconBackground !== undefined) project.iconBackground = parsed.data.iconBackground;
      if (parsed.data.addedAt !== undefined) project.addedAt = parsed.data.addedAt;
      if (parsed.data.lastOpenedAt !== undefined) project.lastOpenedAt = parsed.data.lastOpenedAt;
      if (parsed.data.sidebarCollapsed !== undefined) project.sidebarCollapsed = parsed.data.sidebarCollapsed;
      result.push(project);
    }
    return result;
  }).refine((projects) => projects.length > 0),
);

const followUpBehaviorSchema = z.enum(['steer', 'queue']);

/** Legacy `queueModeEnabled` → `followUpBehavior`; 'immediate' collapses onto 'steer'. */
export const parseFollowUpBehavior: SettingsParser<'steer' | 'queue'> = (value, raw) => {
  const direct = followUpBehaviorSchema.safeParse(value);
  if (direct.success) return direct.data;
  if (value === 'immediate') return 'steer';
  const legacy = z.boolean().safeParse(raw.queueModeEnabled);
  if (!legacy.success) return undefined;
  return legacy.data ? 'queue' : 'steer';
};

/** Legacy provider names: 'server' was the OpenAI-compatible endpoint; 'browser'/'wasm' the local one. */
export const parseSttProvider = fromSchema(
  trimmed.pipe(z.enum(['local', 'openai-compatible', 'server', 'browser', 'wasm'])).transform((provider): 'local' | 'openai-compatible' => {
    if (provider === 'server') return 'openai-compatible';
    if (provider === 'browser' || provider === 'wasm') return 'local';
    return provider;
  }),
);

/** Legacy 'auto' never read OS chrome config; it means right. */
export const parseDesktopWindowControlsPosition = fromSchema(
  trimmed.pipe(z.enum(['left', 'right', 'auto'])).transform((mode): 'left' | 'right' => (mode === 'left' ? 'left' : 'right')),
);

export const parsePwaAppName = fromSchema(
  trimmed.transform((value) => value.replace(/\s+/g, ' ').slice(0, 64)),
);

/** Lower-cased, deduplicated shells; unknown names are dropped. */
export const parseTerminalShells = <T extends string>(isShell: (value: string) => value is T): SettingsParser<T[]> => fromSchema(
  z.array(z.unknown()).transform((entries) => {
    const shells: T[] = [];
    for (const entry of entries) {
      const parsed = trimmed.transform((value) => value.toLowerCase()).safeParse(entry);
      if (parsed.success && isShell(parsed.data) && !shells.includes(parsed.data)) shells.push(parsed.data);
    }
    return shells;
  }),
);

/** A value accepted by a domain type guard (`isTerminalShell`, `isUiFontOption`, …). */
export const parseGuarded = <T>(isValid: (value: unknown) => value is T): SettingsParser<T> => fromSchema(
  z.custom<T>(isValid),
);

/** Map a parser's output; `undefined` from the mapper rejects the value. */
export const mapParser = <A, B>(parser: SettingsParser<A>, map: (value: A) => B | undefined): SettingsParser<B> => (value, raw) => {
  const parsed = parser(value, raw);
  return parsed === undefined ? undefined : map(parsed);
};
