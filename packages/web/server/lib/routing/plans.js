/**
 * The plan store OpenCode reads: `plans.json` and the append-only
 * `plan-notes.jsonl`, both in OpenCode's data directory. The Plans section
 * writes the same files, so the shapes here must stay in step with
 * `packages/core/src/model-plan.ts` in OpenCode. A malformed file is an error,
 * never an empty store, so a bad write cannot erase the user's plans.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { renameSyncWithRetry } from '../shared/atomic-rename.js';
import { readBoundedFileSync } from '../shared/bounded-file-read.js';

import { resolveOpenCodeDataDir } from './route-overrides-store.js';

const COVERAGE = ['subscription', 'credits', 'metered', 'free', 'trial'];
const TIERS = ['cheap', 'standard', 'frontier'];
const UNITS = ['requests', 'messages', 'tokens', 'usd', 'percent', 'other'];
const STATUSES = ['active', 'expired', 'cancelled', 'unknown'];
const PERIODS = ['monthly', 'yearly', 'once'];
const NOTE_KINDS = ['experience', 'expectation', 'plan-change', 'correction', 'other'];
const NOTE_SOURCES = ['user', 'model', 'ui'];
const MAX_PLAN_STORE_BYTES = 8 * 1024 * 1024;
const MAX_PLAN_NOTES_BYTES = 8 * 1024 * 1024;

const text = z.string();
const finite = z.number().finite();

const feeSchema = z.object({
  amount: finite,
  currency: text.min(1),
  period: z.enum(PERIODS),
  renewsOn: text.optional(),
});

const quotaWindowSchema = z.object({
  name: text.min(1),
  unit: z.enum(UNITS),
  limit: finite.optional(),
  windowHours: finite.optional(),
  resetRule: text.optional(),
  resetAt: text.optional(),
  note: text.optional(),
});

const planSchema = z.object({
  id: text.min(1),
  providerID: text.min(1),
  label: text.min(1),
  plan: text.optional(),
  coverage: z.enum(COVERAGE),
  fee: feeSchema.optional(),
  quotas: z.array(quotaWindowSchema),
  expiresOn: text.optional(),
  status: z.enum(STATUSES),
  verifiedAt: text.optional(),
  verifiedFrom: text.optional(),
  howToCheck: text.optional(),
  notes: text.optional(),
  createdAt: text,
  updatedAt: text,
});

const modelEntrySchema = z.object({
  tier: z.enum(TIERS),
  coveredBy: z.array(text).optional(),
  note: text.optional(),
  updatedAt: text,
});

const poolEntrySchema = z.object({
  tier: z.enum(TIERS).optional(),
  purpose: text.optional(),
  updatedAt: text,
});

const storeSchema = z.object({
  version: z.literal(1),
  plans: z.array(planSchema),
  models: z.record(text, modelEntrySchema),
  pools: z.record(text, poolEntrySchema),
});

const noteSchema = z.object({
  id: text,
  at: text,
  kind: z.enum(NOTE_KINDS),
  text,
  source: z.enum(NOTE_SOURCES),
  providerID: text.optional(),
  planID: text.optional(),
  modelID: text.optional(),
  poolID: text.optional(),
});

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

export const emptyPlanStore = () => ({ version: 1, plans: [], models: {}, pools: {} });

const planStoreFiles = (dataDir = resolveOpenCodeDataDir()) => ({
  dir: dataDir,
  store: path.join(dataDir, 'plans.json'),
  notes: path.join(dataDir, 'plan-notes.jsonl'),
});

export const readPlanStore = (dataDir) => {
  const { store } = planStoreFiles(dataDir);
  let fileRead;
  try {
    fileRead = readBoundedFileSync(store, MAX_PLAN_STORE_BYTES);
  } catch (error) {
    throw httpError(409, `${store} is unreadable: ${error?.code ?? 'error'}. Fix its permissions or move it before saving plan information.`, 'PLAN_STORE_UNREADABLE');
  }
  if (!fileRead.ok) {
    if (fileRead.reason === 'missing') return emptyPlanStore();
    if (fileRead.reason === 'too-large') {
      throw httpError(409, `${store} exceeds the ${MAX_PLAN_STORE_BYTES}-byte plan store limit. Fix or move it before saving plan information.`, 'PLAN_STORE_MALFORMED');
    }
    throw httpError(409, `${store} is not a regular file. Fix or move it before saving plan information.`, 'PLAN_STORE_MALFORMED');
  }
  let parsed;
  try {
    parsed = JSON.parse(fileRead.buffer.toString('utf8'));
  } catch {
    throw httpError(409, `${store} is not valid JSON. Fix or move it before saving plan information.`, 'PLAN_STORE_MALFORMED');
  }
  const result = storeSchema.safeParse(parsed);
  if (!result.success) {
    throw httpError(409, `${store} does not match the plan store format: ${result.error.issues[0]?.message ?? 'invalid'}`, 'PLAN_STORE_MALFORMED');
  }
  return result.data;
};

export const writePlanStore = (value, dataDir) => {
  const { dir, store } = planStoreFiles(dataDir);
  const valid = storeSchema.parse(value);
  fs.mkdirSync(dir, { recursive: true });
  const temporary = `${store}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(valid, null, 2)}\n`);
  renameSyncWithRetry((from, to) => fs.renameSync(from, to), temporary, store);
  return valid;
};

const slug = (value) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

const withoutUndefined = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

/** Sets the fields given. A field left out is kept; a field set to null is removed. */
const merge = (base, patch) => {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
};

export const upsertPlan = (store, patch, now) => {
  const providerID = patch.providerID ?? store.plans.find((item) => item.id === patch.id)?.providerID;
  if (!providerID) throw httpError(400, 'A plan needs a providerID, such as anthropic or openai.', 'INVALID_PLAN');
  const id = patch.id ?? slug(`${providerID}-${patch.plan ?? patch.label ?? 'plan'}`);
  const existing = store.plans.find((item) => item.id === id);
  const base = existing ?? {
    id,
    providerID,
    label: providerID,
    coverage: 'subscription',
    quotas: [],
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  const next = planSchema.parse(merge(base, { ...patch, id, providerID, updatedAt: now }));
  const plans = existing ? store.plans.map((item) => (item.id === id ? next : item)) : [...store.plans, next];
  return { store: { ...store, plans }, plan: next };
};

export const setModel = (store, model, patch, now) => {
  const existing = store.models[model];
  const tier = patch.tier ?? existing?.tier;
  if (!tier) throw httpError(400, `${model} needs a tier: cheap, standard or frontier.`, 'INVALID_TIER');
  const entry = modelEntrySchema.parse(merge(existing ?? {}, { ...patch, tier, updatedAt: now }));
  return { ...store, models: { ...store.models, [model]: entry } };
};

export const setPool = (store, poolID, patch, now) => ({
  ...store,
  pools: { ...store.pools, [poolID]: poolEntrySchema.parse(merge(store.pools[poolID] ?? {}, { ...patch, updatedAt: now })) },
});

export const addNote = (input, now, dataDir) => {
  const value = typeof input.text === 'string' ? input.text.trim() : '';
  if (!value) throw httpError(400, 'A note needs some text.', 'INVALID_NOTE');
  const note = noteSchema.parse(
    withoutUndefined({
      id: `note_${Date.parse(now).toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      at: now,
      kind: input.kind ?? 'other',
      text: value,
      source: input.source ?? 'ui',
      providerID: input.providerID || undefined,
      planID: input.planID || undefined,
      modelID: input.modelID || undefined,
      poolID: input.poolID || undefined,
    }),
  );
  const { dir, notes } = planStoreFiles(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(notes, `${JSON.stringify(note)}\n`);
  return note;
};

/**
 * The notes that match, oldest first, keeping the newest `limit`. A damaged line is skipped and counted.
 * The append-only log is read whole under an 8 MiB cap so filters and skipped counts cover the full file.
 */
export const readNotes = (filter = {}, dataDir) => {
  const { notes: file } = planStoreFiles(dataDir);
  const result = readBoundedFileSync(file, MAX_PLAN_NOTES_BYTES);
  if (!result.ok) {
    if (result.reason === 'missing') return { notes: [], skipped: 0 };
    if (result.reason === 'too-large') {
      throw httpError(413, `${file} exceeds the ${MAX_PLAN_NOTES_BYTES}-byte limit.`, 'PLAN_NOTES_TOO_LARGE');
    }
    throw httpError(409, `${file} is not a regular file.`, 'PLAN_NOTES_NOT_REGULAR');
  }

  let skipped = 0;
  const parsed = [];
  for (const line of result.buffer.toString('utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      parsed.push(noteSchema.parse(JSON.parse(line)));
    } catch {
      skipped += 1;
    }
  }
  const since = filter.since === undefined ? undefined : Date.parse(filter.since);
  const matching = parsed
    .filter((note) => filter.providerID === undefined || note.providerID === filter.providerID)
    .filter((note) => filter.planID === undefined || note.planID === filter.planID)
    .filter((note) => filter.modelID === undefined || note.modelID === filter.modelID)
    .filter((note) => filter.poolID === undefined || note.poolID === filter.poolID)
    .filter((note) => filter.kind === undefined || note.kind === filter.kind)
    .filter((note) => since === undefined || Date.parse(note.at) >= since)
    .sort((left, right) => left.at.localeCompare(right.at));
  return { notes: filter.limit === undefined ? matching : matching.slice(-filter.limit), skipped };
};
