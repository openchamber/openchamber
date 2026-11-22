/**
 * Routing configuration on disk.
 *
 * `routing.json` holds only deviations from the built-in defaults: a patched or
 * disabled built-in category, a user category, the fallback model, thresholds.
 * `routing-auth.json` holds the Jev API key alone, mode 0600, so the config
 * file can be read, shown and exported without carrying a secret.
 * `classification.json` holds which classification provider answers Jev
 * requests (see `classifier.js`). `classifier-endpoint.json` holds the custom
 * System One endpoint (URL, model, optional key), mode 0600 like the key file;
 * a file of its own so saving one never rewrites the other.
 *
 * Reads never throw on a missing file (a fresh install is the defaults); a
 * malformed file is an error, not an empty config, so a bad write cannot
 * silently reset the user's categories.
 */
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

const FILE_VERSION = 1;
const CATEGORY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

// The Auto sentinel is what routing resolves *from*; as a fallback or category
// model it would send itself to OpenCode.
const modelSchema = z.object({
  providerID: z.string().trim().min(1).max(200),
  modelID: z.string().trim().min(1).max(200),
}).strict().refine((model) => !isAutoModel(model), { message: 'The Auto model cannot be a routing target' });

const variantSchema = z.string().trim().min(1).max(80).nullable();
const agentSchema = z.string().trim().min(1).max(80).nullable();

/** A built-in category on disk carries only what the user changed. */
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

/** The effective category the runtime and the UI work with. */
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
  // Clients from before the setting send a config without it.
  preserveCache: z.boolean().default(DEFAULT_PRESERVE_CACHE),
  safetyNet: z.object({ enabled: z.boolean(), threshold: z.number().min(0).max(1) }).strict(),
  // Older clients send configs without it; the runtime keeps the stored value then.
  stickiness: stickinessSchema.optional(),
  categories: z.array(effectiveCategorySchema).max(32),
}).strict();

const authSchema = z.object({ token: z.string().min(1).max(4000) }).strict();

const classifierSchema = z.object({ version: z.literal(FILE_VERSION), source: z.enum(CLASSIFIER_SOURCES) }).strict();

const isParsedEndpointUrl = (url) => {
  try {
    return parseCustomEndpointUrl(url) === url;
  } catch {
    return false;
  }
};

// A hand-edited URL that the setter would not have produced is not an endpoint.
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

const routingConfigPath = (dataDir) => path.join(dataDir, 'routing.json');
const routingAuthPath = (dataDir) => path.join(dataDir, 'routing-auth.json');
const classifierPath = (dataDir) => path.join(dataDir, 'classification.json');
const customEndpointPath = (dataDir) => path.join(dataDir, 'classifier-endpoint.json');
const autoSessionsPath = (dataDir) => path.join(dataDir, 'auto-sessions.json');

const readJsonFile = async (file, schema, maxBytes) => {
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

const writeJsonFile = async (file, value, mode) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode });
  await renameWithRetry((from, to) => fs.rename(from, to), tmp, file);
  if (mode) await fs.chmod(file, mode);
};

/** The synchronous twin of `readJsonFile`, for the one file read before the server takes requests. */
const readJsonFileSync = (file, schema, maxBytes) => {
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
const writeJsonFileSync = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSyncWithRetry((from, to) => renameSync(from, to), tmp, file);
};

const emptyFile = () => ({ version: FILE_VERSION });

/** Built-ins plus the stored deviations, in built-in order followed by user categories. */
export const resolveEffectiveConfig = (stored) => {
  const file = stored ?? emptyFile();
  const overrides = file.categories ?? {};
  const categories = [];
  for (const builtin of BUILTIN_CATEGORIES) {
    const override = overrides[builtin.id];
    if (override && override.builtin !== true) continue; // a user id colliding with a built-in is ignored
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

/** The stored shape for an effective config: built-ins keep only their deviations. */
export const toStoredConfig = (config) => {
  const categories = {};
  const builtinIds = new Set(BUILTIN_CATEGORIES.map((c) => c.id));
  const present = new Set();
  for (const category of config.categories) {
    present.add(category.id);
    if (category.builtin) {
      const builtin = BUILTIN_CATEGORIES.find((c) => c.id === category.id);
      if (!builtin) continue;
      const override = { builtin: true };
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
    const entry = { builtin: false, name: category.name, description: category.description };
    if (!category.enabled) entry.disabled = true;
    if (category.model) entry.model = category.model;
    if (category.variant) entry.variant = category.variant;
    if (category.agent) entry.agent = category.agent;
    categories[category.id] = entry;
  }
  for (const builtin of BUILTIN_CATEGORIES) {
    if (!present.has(builtin.id)) categories[builtin.id] = { builtin: true, deleted: true };
  }
  const stored = {
    version: FILE_VERSION,
    enabled: config.enabled,
    minConfidence: config.minConfidence,
    preserveCache: config.preserveCache,
    safetyNet: config.safetyNet,
  };
  const sameStickiness = config.stickiness
    && Object.keys(DEFAULT_STICKINESS).every((field) => config.stickiness[field] === DEFAULT_STICKINESS[field]);
  if (config.stickiness && !sameStickiness) stored.stickiness = config.stickiness;
  if (config.fallback) {
    stored.fallback = { model: config.fallback.model };
    if (config.fallback.variant) stored.fallback.variant = config.fallback.variant;
  }
  if (Object.keys(categories).length > 0) stored.categories = categories;
  return stored;
};

/** Parses an untrusted effective config (a PUT body) into the trusted shape, or throws. */
export const parseEffectiveConfig = (input) => {
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

export const createRoutingStore = ({ dataDir }) => {
  const configFile = routingConfigPath(dataDir);
  const authFile = routingAuthPath(dataDir);
  const classifierFile = classifierPath(dataDir);
  const customEndpointFile = customEndpointPath(dataDir);
  const autoSessionsFile = autoSessionsPath(dataDir);
  let writeChain = Promise.resolve();
  const serialize = (run) => {
    const next = writeChain.catch(() => undefined).then(run);
    writeChain = next;
    return next;
  };

  return {
    /** Effective config; a missing file is the defaults, a broken file throws. */
    readConfig: async () => resolveEffectiveConfig(await readJsonFile(configFile, fileSchema, ROUTING_CONFIG_MAX_BYTES)),
    writeConfig: (config) => serialize(async () => {
      await writeJsonFile(configFile, toStoredConfig(config));
      return config;
    }),
    readToken: async () => {
      try {
        return (await readJsonFile(authFile, authSchema, ROUTING_AUTH_MAX_BYTES))?.token ?? null;
      } catch (error) {
        console.warn('[routing] routing-auth.json is unreadable:', error?.message ?? error);
        return null;
      }
    },
    writeToken: (token) => serialize(() => writeJsonFile(authFile, { token }, 0o600)),
    clearToken: () => serialize(async () => {
      await fs.rm(authFile, { force: true });
    }),
    /**
     * The classification provider the user picked, or null before any pick.
     * An unreadable file is treated as no pick: the default source still
     * serves, and the next pick rewrites it.
     */
    readClassifierSource: async () => {
      try {
        return (await readJsonFile(classifierFile, classifierSchema, CLASSIFIER_SOURCE_MAX_BYTES))?.source ?? null;
      } catch (error) {
        console.warn('[routing] classification.json is unreadable:', error?.message ?? error);
        return null;
      }
    },
    writeClassifierSource: (source) => serialize(() => writeJsonFile(classifierFile, { version: FILE_VERSION, source })),
    /** The custom endpoint, or null when none is saved. Unreadable reads as none, like the key file. */
    readCustomEndpoint: async () => {
      try {
        return (await readJsonFile(customEndpointFile, customEndpointFileSchema, CUSTOM_ENDPOINT_MAX_BYTES))?.endpoint ?? null;
      } catch (error) {
        // V8 quotes the broken text in a JSON syntax error, and this file holds a key.
        const reason = error instanceof SyntaxError ? 'malformed JSON' : error?.message ?? error;
        console.warn('[routing] classifier-endpoint.json is unreadable:', reason);
        return null;
      }
    },
    writeCustomEndpoint: (endpoint) => serialize(() => writeJsonFile(customEndpointFile, { version: FILE_VERSION, endpoint }, 0o600)),
    clearCustomEndpoint: () => serialize(async () => {
      await fs.rm(customEndpointFile, { force: true });
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
        console.warn('[routing] auto-sessions.json is unreadable:', error?.message ?? error);
        return [];
      }
    },
    /** Replaces the whole list in one synchronous write. A failed write throws and keeps the old file. */
    writeAutoSessions: (sessions) => {
      writeJsonFileSync(autoSessionsFile, { version: FILE_VERSION, sessions });
    },
  };
};
