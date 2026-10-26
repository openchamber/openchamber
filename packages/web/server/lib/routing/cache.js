/**
 * "Try to preserve cache usage". A provider keeps a prompt cache per model, so
 * switching models mid-session makes the new model read the whole context
 * uncached, and the old model's cache goes cold while the session is away from
 * it. While the model that wrote the last answer likely still holds a warm
 * cache, Auto stays on it instead of moving down to a lower category; moving up
 * is never held back.
 *
 * "Lower" is the built-in category order: trivial < research < implement <
 * hard. Categories the user added have no place in that order, so a send routed
 * to one of them switches as it always did.
 */
import { z } from 'zod';
import { BUILTIN_CATEGORIES } from './defaults.js';

/** How long a provider keeps a prompt cache after its last use. */
export const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;

/** OpenCode's warming `duration` when the config says only `true` (core `plugin/warming.ts`). */
const DEFAULT_WARMING_DURATION_MS = 30 * 60 * 1000;

const RANK = new Map(BUILTIN_CATEGORIES.map((category, index) => [category.id, index]));

const rankOf = (category) => (category.builtin ? RANK.get(category.id) ?? null : null);

const sameModel = (a, b) => a.providerID === b.providerID && a.modelID === b.modelID;

/**
 * The category Auto keeps instead of `chosen`, or null to switch as Jev said.
 * `current` is the model that wrote the session's last answer. Several
 * categories can share that model; the highest of them is where the session
 * is, so a choice below it is a move down. Only a category that runs the same
 * agent as `chosen` is kept: another agent sends another system prompt, which
 * misses the cache anyway, and would run the request with tools it did not ask
 * for (a planning agent for an edit).
 */
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

/** OpenCode answers a duration as `"1800000 millis"`; a hand-written `"30 minutes"` reads too. */
const durationMs = (text) => {
  const match = DURATION.exec(text.trim());
  const unit = match ? UNIT_MS[match[2].toLowerCase()] : undefined;
  const ms = unit ? Number(match[1]) * unit : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};

const warmingSchema = z.union([z.boolean(), z.object({ duration: z.string().optional() })]);
const configEntriesSchema = z.array(z.object({ info: z.object({ warming: warmingSchema.optional() }).nullish() }));

/**
 * How long after its last answer a session's cache stays warm, from the config
 * entries OpenCode answers for the directory (lowest priority first, the last
 * one that sets `warming` wins, as OpenCode reads it). With warming on,
 * OpenCode pings the model until `duration` after the last turn, and the last
 * ping keeps the cache one more lifetime. Entries this cannot read count as
 * warming off: holding a model on a cache that went cold is the costlier
 * mistake.
 */
export const warmWindowMs = (configEntries) => {
  const parsed = configEntriesSchema.safeParse(configEntries);
  if (!parsed.success) return PROMPT_CACHE_TTL_MS;
  const warming = parsed.data.findLast((entry) => entry.info?.warming !== undefined)?.info.warming;
  if (!warming) return PROMPT_CACHE_TTL_MS;
  const duration = warming === true || !warming.duration ? null : durationMs(warming.duration);
  return (duration ?? DEFAULT_WARMING_DURATION_MS) + PROMPT_CACHE_TTL_MS;
};
