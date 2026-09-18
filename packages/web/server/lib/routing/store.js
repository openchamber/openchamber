/**
 * Routing configuration on disk.
 *
 * `routing.json` holds only deviations from the built-in defaults: a patched or
 * disabled built-in category, a user category, the fallback model, thresholds.
 * `routing-auth.json` holds the Jev API key alone, mode 0600, so the config
 * file can be read, shown and exported without carrying a secret.
 *
 * Reads never throw on a missing file (a fresh install is the defaults); a
 * malformed file is an error, not an empty config, so a bad write cannot
 * silently reset the user's categories.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  BUILTIN_CATEGORIES,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_SAFETY_THRESHOLD,
  THINKING_LEVELS,
  isAutoModel,
} from './defaults.js';

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

const fileSchema = z.object({
  version: z.literal(FILE_VERSION),
  enabled: z.boolean().optional(),
  fallback: z.object({ model: modelSchema, variant: variantSchema.optional() }).strict().nullable().optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  safetyNet: z.object({ enabled: z.boolean(), threshold: z.number().min(0).max(1) }).strict().optional(),
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
  safetyNet: z.object({ enabled: z.boolean(), threshold: z.number().min(0).max(1) }).strict(),
  categories: z.array(effectiveCategorySchema).max(32),
}).strict();

const authSchema = z.object({ token: z.string().min(1).max(4000) }).strict();

const routingConfigPath = (dataDir) => path.join(dataDir, 'routing.json');
const routingAuthPath = (dataDir) => path.join(dataDir, 'routing-auth.json');

const readJsonFile = async (file, schema) => {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const text = raw.replace(/^﻿/, '').trim();
  if (text === '') return null;
  const parsed = schema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`Invalid ${path.basename(file)}: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`);
  return parsed.data;
};

const writeJsonFile = async (file, value, mode) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode });
  await fs.rename(tmp, file);
  if (mode) await fs.chmod(file, mode);
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
    safetyNet: file.safetyNet ?? { enabled: false, threshold: DEFAULT_SAFETY_THRESHOLD },
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
  const stored = { version: FILE_VERSION, enabled: config.enabled, minConfidence: config.minConfidence, safetyNet: config.safetyNet };
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
  let writeChain = Promise.resolve();
  const serialize = (run) => {
    const next = writeChain.catch(() => undefined).then(run);
    writeChain = next;
    return next;
  };

  return {
    /** Effective config; a missing file is the defaults, a broken file throws. */
    readConfig: async () => resolveEffectiveConfig(await readJsonFile(configFile, fileSchema)),
    writeConfig: (config) => serialize(async () => {
      await writeJsonFile(configFile, toStoredConfig(config));
      return config;
    }),
    readToken: async () => {
      try {
        return (await readJsonFile(authFile, authSchema))?.token ?? null;
      } catch (error) {
        console.warn('[routing] routing-auth.json is unreadable:', error?.message ?? error);
        return null;
      }
    },
    writeToken: (token) => serialize(() => writeJsonFile(authFile, { token }, 0o600)),
    clearToken: () => serialize(async () => {
      await fs.rm(authFile, { force: true });
    }),
  };
};
