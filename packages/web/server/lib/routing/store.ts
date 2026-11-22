import fs from 'node:fs/promises';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  BUILTIN_CATEGORIES,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_PRESERVE_CACHE,
  DEFAULT_SAFETY_THRESHOLD,
  DEFAULT_STICKINESS,
  THINKING_LEVELS,
  isAutoModel,
} from './defaults.js';
import { CLASSIFIER_SOURCES, parseCustomEndpointUrl } from './classifier.js';
import { renameWithRetry, renameSyncWithRetry } from '../shared/atomic-rename.js';
import { readBoundedFile, readBoundedFileSync } from '../shared/bounded-file-read.js';

/**
 * Maximum read bytes for routing.json.
 * The effective config caps categories at 32 (effectiveConfigSchema .max(32)).
 * Each category name is <= 60 chars, description <= 2,000 chars, model <= 200 + 200 chars,
 * variant/agent <= 80 chars. A legitimate file is <= 90 KB in ASCII and under 400 KiB
 * with four-byte UTF-8 characters. 1 MiB gives at least 2.5x headroom over that worst case.
 */
export const ROUTING_CONFIG_MAX_BYTES = 1024 * 1024; // 1 MiB

/**
 * Maximum read bytes for routing-auth.json.
 * Holds { token } with token <= 4,000 chars (authSchema). A legitimate file is <= 16.1 KiB
 * with four-byte UTF-8 characters. 64 KiB gives ~4x headroom.
 */
export const ROUTING_AUTH_MAX_BYTES = 64 * 1024; // 64 KiB

/**
 * Maximum read bytes for classification.json.
 * Holds { version: 1, source } where source is an enum (classifierSchema).
 * A legitimate file is a few dozen bytes. 64 KiB leaves generous headroom.
 */
export const CLASSIFIER_SOURCE_MAX_BYTES = 64 * 1024; // 64 KiB

/**
 * Maximum read bytes for classifier-endpoint.json.
 * Holds URL <= 2,000 chars, model <= 200 chars, key <= 4,000 chars (customEndpointSchema).
 * A legitimate file is <= 25 KiB with four-byte UTF-8 characters. 64 KiB leaves over 2x headroom.
 */
export const CUSTOM_ENDPOINT_MAX_BYTES = 64 * 1024; // 64 KiB

/**
 * Maximum read bytes for auto-sessions.json.
 * Capped at 1,000 sessions (AUTO_SESSION_LIMIT = 1000). Each entry has sessionId <= 200 chars,
 * directory <= 4,000 chars, and timestamp. At four bytes per character, a pathological worst
 * case is under 17 MiB. 32 MiB leaves ~2x headroom while keeping synchronous startup bounded.
 */
export const AUTO_SESSIONS_MAX_BYTES = 32 * 1024 * 1024; // 32 MiB
import type { JsonValue } from '../shared/json-values.js';

const FILE_VERSION = 1;
const CATEGORY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const modelSchema = z.object({
  providerID: z.string().trim().min(1).max(200),
  modelID: z.string().trim().min(1).max(200),
}).strict().refine((model) => !isAutoModel(model), { message: 'The Auto model cannot be a routing target' });

const variantSchema = z.string().trim().min(1).max(80).nullable();
const agentSchema = z.string().trim().min(1).max(80).nullable();

const builtinOverrideSchema = z.object({
  builtin: z.literal(true),
  disabled: z.boolean().optional(),
  deleted: z.boolean().optional(),
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().min(1).max(2000).optional(),
  model: modelSchema.nullable().optional(),
  variant: variantSchema.optional(),
  agent: agentSchema.optional(),
}).strict();

const userCategorySchema = z.object({
  builtin: z.literal(false),
  disabled: z.boolean().optional(),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(2000),
  model: modelSchema.nullable().optional(),
  variant: variantSchema.optional(),
  agent: agentSchema.optional(),
}).strict();

const stickinessSchema = z.object({
  enabled: z.boolean(),
  enterTurns: z.number().int().min(1).max(10),
  exitTurns: z.number().int().min(1).max(10),
  strongConfidence: z.number().min(0.5).max(1),
}).strict();

const fileSchema = z.object({
  version: z.literal(FILE_VERSION),
  enabled: z.boolean().optional(),
  fallback: z.object({ model: modelSchema, variant: variantSchema.optional() }).strict().nullable().optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  preserveCache: z.boolean().optional(),
  safetyNet: z.object({ enabled: z.boolean(), threshold: z.number().min(0).max(1) }).strict().optional(),
  stickiness: stickinessSchema.optional(),
  categories: z.record(z.string().regex(CATEGORY_ID), z.discriminatedUnion('builtin', [builtinOverrideSchema, userCategorySchema])).optional(),
}).strict();

const effectiveCategorySchema = z.object({
  id: z.string().regex(CATEGORY_ID),
  builtin: z.boolean(),
  enabled: z.boolean(),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(2000),
  model: modelSchema.nullable(),
  variant: variantSchema,
  agent: agentSchema,
}).strict();

const effectiveConfigSchema = z.object({
  enabled: z.boolean(),
  fallback: z.object({ model: modelSchema, variant: variantSchema }).strict().nullable(),
  minConfidence: z.number().min(0).max(1),
  preserveCache: z.boolean().default(DEFAULT_PRESERVE_CACHE),
  safetyNet: z.object({ enabled: z.boolean(), threshold: z.number().min(0).max(1) }).strict(),
  // Older clients send configs without it; the runtime keeps the stored value then.
  stickiness: stickinessSchema.optional(),
  categories: z.array(effectiveCategorySchema).max(32),
}).strict();

export type RoutingModel = z.infer<typeof modelSchema>;
export type RoutingCategory = z.infer<typeof effectiveCategorySchema>;
export type RoutingConfig = z.infer<typeof effectiveConfigSchema>;
type StoredConfig = z.infer<typeof fileSchema>;
type BuiltinOverride = z.infer<typeof builtinOverrideSchema>;
type UserCategory = z.infer<typeof userCategorySchema>;

const authSchema = z.object({ token: z.string().min(1).max(4000) }).strict();
const geminiKeySchema = z.object({ key: z.string().min(1).max(4000) }).strict();

const classifierSchema = z.object({ version: z.literal(FILE_VERSION), source: z.enum(CLASSIFIER_SOURCES) }).strict();

const isParsedEndpointUrl = (url: string) => {
  try {
    return parseCustomEndpointUrl(url) === url;
  } catch {
    return false;
  }
};

const customEndpointSchema = z.object({
  url: z.string().max(2000).refine(isParsedEndpointUrl, { message: 'Invalid endpoint URL' }),
  model: z.string().trim().min(1).max(200),
  key: z.string().min(1).max(4000).optional(),
}).strict();

const customEndpointFileSchema = z.object({ version: z.literal(FILE_VERSION), endpoint: customEndpointSchema }).strict();

// Sessions the user put on Auto, oldest first: the order is the eviction order.
const autoSessionsFileSchema = z.object({
  version: z.literal(FILE_VERSION),
  sessions: z.array(z.object({
    sessionId: z.string().min(1).max(200),
    directory: z.string().max(4000).nullable(),
    at: z.number().finite(),
  }).strict()),
}).strict();
export type CustomEndpoint = z.infer<typeof customEndpointSchema>;

const routingConfigPath = (dataDir: string) => path.join(dataDir, 'routing.json');
const routingAuthPath = (dataDir: string) => path.join(dataDir, 'routing-auth.json');
const classifierPath = (dataDir: string) => path.join(dataDir, 'classification.json');
const customEndpointPath = (dataDir: string) => path.join(dataDir, 'classifier-endpoint.json');
const autoSessionsPath = (dataDir: string) => path.join(dataDir, 'auto-sessions.json');
const geminiKeyPath = (dataDir: string) => path.join(dataDir, 'classifier-gemini-key.json');

const hasErrorMessage = (cause: unknown): cause is { message: unknown } => cause !== null
  && (typeof cause === 'object' || typeof cause === 'function') && 'message' in cause;

const readJsonFile = async <T>(file: string, schema: z.ZodType<T>, maxBytes: number) => {
  const result = await readBoundedFile(file, maxBytes);
  if (!result.ok) {
    if (result.reason === 'missing') return null;
    if (result.reason === 'too-large') {
      throw new Error(`Invalid ${path.basename(file)}: exceeds ${maxBytes} byte limit`);
    }
    throw new Error(`Invalid ${path.basename(file)}: not a regular file`);
  }
  const text = result.buffer.toString('utf8').replace(/^﻿/, '').trim();
  if (text === '') return null;
  const parsed = schema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`Invalid ${path.basename(file)}: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`);
  return parsed.data;
};

const writeJsonFile = async <T>(file: string, value: T, mode?: number) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode });
  await renameWithRetry((from: string, to: string) => fs.rename(from, to), tmp, file);
  if (mode) await fs.chmod(file, mode);
};

/** The synchronous twin of `readJsonFile`, for the one file read before the server takes requests. */
const readJsonFileSync = <T>(file: string, schema: z.ZodType<T>, maxBytes: number) => {
  const result = readBoundedFileSync(file, maxBytes);
  if (!result.ok) {
    if (result.reason === 'missing') return null;
    if (result.reason === 'too-large') {
      throw new Error(`Invalid ${path.basename(file)}: exceeds ${maxBytes} byte limit`);
    }
    throw new Error(`Invalid ${path.basename(file)}: not a regular file`);
  }
  const text = result.buffer.toString('utf8').replace(/^﻿/, '').trim();
  if (text === '') return null;
  const parsed = schema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`Invalid ${path.basename(file)}: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`);
  return parsed.data;
};

/** Writes through a temporary file, so a failed write leaves the previous file in place. */
const writeJsonFileSync = <T>(file: string, value: T) => {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSyncWithRetry((from: string, to: string) => renameSync(from, to), tmp, file);
};

const emptyFile = (): StoredConfig => ({ version: FILE_VERSION });

export const resolveEffectiveConfig = (stored: StoredConfig | null): RoutingConfig => {
  const file = stored ?? emptyFile();
  const overrides = file.categories ?? {};
  const categories = [];
  for (const builtin of BUILTIN_CATEGORIES) {
    const override = overrides[builtin.id];
    if (override && override.builtin !== true) continue;
    if (override?.deleted) continue;
    categories.push({
      id: builtin.id,
      builtin: true,
      enabled: !(override?.disabled === true),
      name: override?.name ?? builtin.name,
      description: override?.description ?? builtin.description,
      model: override?.model ?? null,
      variant: override?.variant ?? null,
      agent: override?.agent ?? null,
    });
  }
  for (const [id, entry] of Object.entries(overrides)) {
    if (entry.builtin !== false) continue;
    categories.push({
      id,
      builtin: false,
      enabled: !(entry.disabled === true),
      name: entry.name,
      description: entry.description,
      model: entry.model ?? null,
      variant: entry.variant ?? null,
      agent: entry.agent ?? null,
    });
  }
  return {
    enabled: file.enabled ?? false,
    fallback: file.fallback ? { model: file.fallback.model, variant: file.fallback.variant ?? null } : null,
    minConfidence: file.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
    preserveCache: file.preserveCache ?? DEFAULT_PRESERVE_CACHE,
    safetyNet: file.safetyNet ?? { enabled: false, threshold: DEFAULT_SAFETY_THRESHOLD },
    stickiness: file.stickiness ?? { ...DEFAULT_STICKINESS },
    categories,
  };
};

export const toStoredConfig = (config: RoutingConfig) => {
  const categories: NonNullable<StoredConfig['categories']> = {};
  const builtinIds = new Set(BUILTIN_CATEGORIES.map((c) => c.id));
  const present = new Set();
  for (const category of config.categories) {
    present.add(category.id);
    if (category.builtin) {
      const builtin = BUILTIN_CATEGORIES.find((c) => c.id === category.id);
      if (!builtin) continue;
      const override: BuiltinOverride = { builtin: true };
      if (!category.enabled) override.disabled = true;
      if (category.name !== builtin.name) override.name = category.name;
      if (category.description !== builtin.description) override.description = category.description;
      if (category.model) override.model = category.model;
      if (category.variant) override.variant = category.variant;
      if (category.agent) override.agent = category.agent;
      if (Object.keys(override).length > 1) categories[category.id] = override;
      continue;
    }
    if (builtinIds.has(category.id)) continue;
    const entry: UserCategory = { builtin: false, name: category.name, description: category.description };
    if (!category.enabled) entry.disabled = true;
    if (category.model) entry.model = category.model;
    if (category.variant) entry.variant = category.variant;
    if (category.agent) entry.agent = category.agent;
    categories[category.id] = entry;
  }
  for (const builtin of BUILTIN_CATEGORIES) {
    if (!present.has(builtin.id)) categories[builtin.id] = { builtin: true, deleted: true };
  }
  const stored: StoredConfig = {
    version: FILE_VERSION,
    enabled: config.enabled,
    minConfidence: config.minConfidence,
    preserveCache: config.preserveCache,
    safetyNet: config.safetyNet,
  };
  const { stickiness } = config;
  const sameStickiness = stickiness
    && (['enabled', 'enterTurns', 'exitTurns', 'strongConfidence'] as const).every((field) => stickiness[field] === DEFAULT_STICKINESS[field]);
  if (stickiness && !sameStickiness) stored.stickiness = stickiness;
  if (config.fallback) {
    stored.fallback = { model: config.fallback.model };
    if (config.fallback.variant) stored.fallback.variant = config.fallback.variant;
  }
  if (Object.keys(categories).length > 0) stored.categories = categories;
  return stored;
};

export const parseEffectiveConfig = (input: JsonValue | undefined) => {
  const parsed = effectiveConfigSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw Object.assign(new Error(`Invalid routing config at ${issue?.path.join('.') || 'root'}: ${issue?.message ?? 'schema mismatch'}`), { status: 400 });
  }
  const config = parsed.data;
  const ids = new Set();
  for (const category of config.categories) {
    if (ids.has(category.id)) throw Object.assign(new Error(`Duplicate category id ${category.id}`), { status: 400 });
    ids.add(category.id);
    if (category.variant && !THINKING_LEVELS.includes(category.variant) && !/^[\w.-]+$/.test(category.variant)) {
      throw Object.assign(new Error(`Invalid variant for ${category.id}`), { status: 400 });
    }
  }
  return config;
};

export const createRoutingStore = ({ dataDir }: { dataDir: string }) => {
  const configFile = routingConfigPath(dataDir);
  const authFile = routingAuthPath(dataDir);
  const classifierFile = classifierPath(dataDir);
  const customEndpointFile = customEndpointPath(dataDir);
  const autoSessionsFile = autoSessionsPath(dataDir);
  const geminiKeyFile = geminiKeyPath(dataDir);
  let writeChain: Promise<RoutingConfig | void> = Promise.resolve();
  const serialize = <T extends RoutingConfig | void>(run: () => Promise<T>) => {
    const next = writeChain.catch(() => undefined).then(run);
    writeChain = next;
    return next;
  };

  return {
    readConfig: async () => resolveEffectiveConfig(await readJsonFile(configFile, fileSchema, ROUTING_CONFIG_MAX_BYTES)),
    writeConfig: (config: RoutingConfig) => serialize(async () => {
      await writeJsonFile(configFile, toStoredConfig(config));
      return config;
    }),
    readToken: async () => {
      try {
        return (await readJsonFile(authFile, authSchema, ROUTING_AUTH_MAX_BYTES))?.token ?? null;
      } catch (error) {
        console.warn('[routing] routing-auth.json is unreadable:', (hasErrorMessage(error) ? error.message : undefined) ?? error);
        return null;
      }
    },
    writeToken: (token: string) => serialize(() => writeJsonFile(authFile, { token }, 0o600)),
    clearToken: () => serialize(async () => {
      await fs.rm(authFile, { force: true });
    }),
    readClassifierSource: async () => {
      try {
        return (await readJsonFile(classifierFile, classifierSchema, CLASSIFIER_SOURCE_MAX_BYTES))?.source ?? null;
      } catch (error) {
        console.warn('[routing] classification.json is unreadable:', (hasErrorMessage(error) ? error.message : undefined) ?? error);
        return null;
      }
    },
    writeClassifierSource: (source: z.infer<typeof classifierSchema>['source']) => serialize(() => writeJsonFile(classifierFile, { version: FILE_VERSION, source })),
    readCustomEndpoint: async () => {
      try {
        return (await readJsonFile(customEndpointFile, customEndpointFileSchema, CUSTOM_ENDPOINT_MAX_BYTES))?.endpoint ?? null;
      } catch (error) {
        const reason = error instanceof SyntaxError ? 'malformed JSON' : (hasErrorMessage(error) ? error.message : undefined) ?? error;
        console.warn('[routing] classifier-endpoint.json is unreadable:', reason);
        return null;
      }
    },
    writeCustomEndpoint: (endpoint: CustomEndpoint) => serialize(() => writeJsonFile(customEndpointFile, { version: FILE_VERSION, endpoint }, 0o600)),
    clearCustomEndpoint: () => serialize(async () => {
      await fs.rm(customEndpointFile, { force: true });
    }),
    readGeminiKey: async () => {
      try {
        return (await readJsonFile(geminiKeyFile, geminiKeySchema, ROUTING_AUTH_MAX_BYTES))?.key ?? null;
      } catch (error) {
        const reason = error instanceof SyntaxError ? 'malformed JSON' : (hasErrorMessage(error) ? error.message : undefined) ?? error;
        console.warn('[routing] classifier-gemini-key.json is unreadable:', reason);
        return null;
      }
    },
    writeGeminiKey: (key: string) => serialize(() => writeJsonFile(geminiKeyFile, { key }, 0o600)),
    clearGeminiKey: () => serialize(async () => {
      await fs.rm(geminiKeyFile, { force: true });
    }),
    /**
     * The sessions on Auto, oldest first. Read once when the runtime starts,
     * before any request, so it is synchronous. No file is no sessions; an
     * unreadable file is none too, with a warning, as an unreadable pick is.
     */
    readAutoSessions: () => {
      try {
        return readJsonFileSync(autoSessionsFile, autoSessionsFileSchema, AUTO_SESSIONS_MAX_BYTES)?.sessions ?? [];
      } catch (error) {
        console.warn('[routing] auto-sessions.json is unreadable:', (hasErrorMessage(error) ? error.message : undefined) ?? error);
        return [];
      }
    },
    /** Replaces the whole list in one synchronous write. A failed write throws and keeps the old file. */
    writeAutoSessions: (sessions: z.infer<typeof autoSessionsFileSchema>['sessions']) => {
      writeJsonFileSync(autoSessionsFile, { version: FILE_VERSION, sessions });
    },
  };
};
