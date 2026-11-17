import { z } from 'zod';
import { BUILTIN_CATEGORIES } from './defaults.js';

export const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;

const DEFAULT_WARMING_DURATION_MS = 30 * 60 * 1000;

const RANK = new Map(BUILTIN_CATEGORIES.map((category, index) => [category.id, index]));

const rankOf = (category) => (category.builtin ? RANK.get(category.id) ?? null : null);

const sameModel = (a, b) => a.providerID === b.providerID && a.modelID === b.modelID;

export const cacheHoldCategory = ({ categories, fallback, composerAgent, chosen, current }) => {
  const chosenRank = chosen ? rankOf(chosen) : null;
  if (chosenRank === null || !current) return null;
  const modelOf = (category) => category.model ?? fallback.model;
  const agentOf = (category) => category.agent || composerAgent || null;
  if (sameModel(modelOf(chosen), current)) return null;
  let held = null;
  for (const category of categories) {
    const rank = rankOf(category);
    if (rank === null || !sameModel(modelOf(category), current) || agentOf(category) !== agentOf(chosen)) continue;
    if (!held || rank > rankOf(held)) held = category;
  }
  return held && rankOf(held) > chosenRank ? held : null;
};

const DURATION = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i;
const UNIT_MS = {
  ms: 1, millis: 1, millisecond: 1, milliseconds: 1,
  s: 1000, second: 1000, seconds: 1000,
  m: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hour: 3_600_000, hours: 3_600_000,
};

const durationMs = (text) => {
  const match = DURATION.exec(text.trim());
  const unit = match ? UNIT_MS[match[2].toLowerCase()] : undefined;
  const ms = unit ? Number(match[1]) * unit : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};

const warmingSchema = z.union([z.boolean(), z.object({ duration: z.string().optional() })]);
const configEntriesSchema = z.array(z.object({ info: z.object({ warming: warmingSchema.optional() }).nullish() }));

export const warmWindowMs = (configEntries) => {
  const parsed = configEntriesSchema.safeParse(configEntries);
  if (!parsed.success) return PROMPT_CACHE_TTL_MS;
  const warming = parsed.data.findLast((entry) => entry.info?.warming !== undefined)?.info.warming;
  if (!warming) return PROMPT_CACHE_TTL_MS;
  const duration = warming === true || !warming.duration ? null : durationMs(warming.duration);
  return (duration ?? DEFAULT_WARMING_DURATION_MS) + PROMPT_CACHE_TTL_MS;
};
