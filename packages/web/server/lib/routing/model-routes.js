import express from 'express';

/**
 * Model pools for OpenCode's `experimental.model_routes`: ordered provider/model
 * targets behind one `opencode-route/<id>` name, each with its own autonomy level.
 *
 * OpenChamber owns the Jev category decision (which kind of task this is);
 * OpenCode owns provider failover inside the chosen pool. This module is the
 * bridge: it reads the user's global `opencode.json(c)` for editing, shows
 * the pools in the other config files read-only, and writes route definitions
 * back to the user file, the same file the providers surface writes to.
 * Writes are refused in enterprise mode, where the administrator
 * controls the OpenCode config.
 */

export const AUTONOMY_LEVELS = ["fixed", "rules", "adaptive", "predictive", "agent"];
const SELECTION_MODES = ["ordered", "round-robin", "weighted"];

const ROUTE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const TARGET_PATTERN = /^[^/#]+\/[^#]+(?:#[^#]+)?$/;

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isWhole = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const MAX_MS = 3_600_000;
const MAX_COUNT = 50;

// The keys each object may carry, as OpenCode's schema defines them. OpenCode
// reads only these, so any other key would be saved and silently ignored.
// `description` and `details` are the exception: OpenChamber owns them and
// gives them to Jev (`jev.js`). OpenCode decodes its config with
// `onExcessProperty: "ignore"` (core config.ts, config/normalize.ts), so it
// loads a route that carries them and drops the two keys.
const ROUTE_KEYS = ["name", "targets", "health", "budgets", "hedgeAfterMs", "attempts", "autonomy", "selection", "weights", "schedules", "description", "details"];
// The UI reads a value over these as absent (`modelRoutesApi.ts`), so the two
// must match; `model-routes.test.js` checks that.
export const MAX_DESCRIPTION_LENGTH = 200;
export const MAX_DETAILS_LENGTH = 2000;
const TARGET_KEYS = ["model", "defaultVariant", "variants", "until"];
const HEALTH_KEYS = ["firstTokenTimeoutMs", "maxResponseTimeMs", "minOutputTokensPerSecond", "sampleWindow", "slowThreshold", "cooldownMs", "quotaCooldownMs"];
const BUDGET_KEYS = ["requestsPerMinute", "requestsPerDay", "tokensPerMinute", "tokensPerDay", "softLimit"];
const TUNING_KEYS = ["enabled", "intervalMinutes", "windowHours", "notes"];
const SCHEDULE_KEYS = ["id", "targets", "when", "factor", "weight", "note"];
const WINDOW_KEYS = ["daysOfWeek", "daysOfMonth", "start", "end", "timezone", "from", "until"];
const GLOBAL_SCHEDULE_KEYS = ["id", "providers", "models", "targets", "routes", "when", "factor", "weight", "note"];
// The weekday spellings OpenCode's schema accepts, beside a whole number from 0 (Sunday) to 6.
const DAY_OF_WEEK_NAMES = [
  "sun", "sunday", "mon", "monday", "tue", "tuesday", "tues", "wed", "wednesday",
  "thu", "thursday", "thur", "thurs", "fri", "friday", "sat", "saturday",
];

// OpenCode's defaults for the health window (model-route.ts).
const DEFAULT_SAMPLE_WINDOW = 5;
const DEFAULT_SLOW_THRESHOLD = 3;

/** Names the keys of `value` that the schema does not define, or null. */
const unknownKeysProblem = (value, allowed) => {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return null;
  const noun = unknown.length === 1 ? "key" : "keys";
  return `unknown ${noun} ${unknown.map((key) => `"${key}"`).join(", ")} (expected ${allowed.join(", ")})`;
};

/** The nested `experimental.routes` record from a config, or null. */
const readNestedRoutes = (config) => {
  const routes = config?.experimental?.routes;
  return isRecord(routes) ? routes : null;
};

/**
 * The route pools from a merged OpenCode config, or {}.
 * OpenCode's canonical shape is the nested `experimental.routes.models`;
 * the flat `experimental.model_routes` folds under it, matching opencode's
 * normalize shim: a pool present in both shapes keeps its nested definition,
 * and a pool present in only one shape is kept as it is.
 */
export const readModelRoutes = (config) => {
  const routes = {};
  const flat = config?.experimental?.model_routes;
  if (isRecord(flat)) Object.assign(routes, flat);
  const nested = readNestedRoutes(config)?.models;
  if (isRecord(nested)) Object.assign(routes, nested);
  return routes;
};

/**
 * The pools OpenCode builds from every config file it reads (`sources` from
 * `readConfigSources`, lowest priority first). A later file's pool replaces an
 * earlier one of the same id whole, as OpenCode's model-routes config plugin
 * does (`routes.set(id, route)`), so a pool's description comes from the same
 * file as its targets. A file that failed to parse reads as empty and adds nothing.
 */
export const readLayeredModelRoutes = (sources) => {
  const routes = {};
  for (const source of sources) Object.assign(routes, readModelRoutes(source.config));
  return routes;
};

const readModelRouteTuning = (config) => {
  const nested = readNestedRoutes(config)?.tuning;
  if (isRecord(nested)) return nested;
  const tuning = config?.experimental?.model_route_tuning;
  return isRecord(tuning) ? tuning : null;
};

/**
 * Tuning across every config file (`sources` lowest priority first): fold
 * each file's two shapes first, then merge in reading order, so a key from
 * a higher-priority file wins whatever shape that file stores it in.
 * Reading the deep-merged config instead would let a lower file's nested
 * tuning beat a higher file's flat override of the same key, because the
 * merged config keeps both shapes side by side and the per-config reader
 * prefers the nested one.
 */
const readLayeredModelRouteTuning = (sources) => {
  let tuning = null;
  for (const source of sources) {
    const layerTuning = readModelRouteTuning(source.config);
    if (!layerTuning) continue;
    if (!tuning) tuning = {};
    Object.assign(tuning, layerTuning);
  }
  return tuning;
};

/**
 * The cross-pool schedules as one config file stores them, or null.
 * The nested `experimental.routes.schedules` list wins over the flat
 * `experimental.model_route_schedules` list when both are present.
 */
const readModelRouteSchedules = (config) => {
  const nested = readNestedRoutes(config)?.schedules;
  if (nested !== undefined && nested !== null) return nested;
  return config?.experimental?.model_route_schedules ?? null;
};

/**
 * Cross-pool schedules from the config files other than `targetPath`, with
 * the file each came from, in OpenCode's reading order. OpenCode applies every
 * file's list (it flattens them), so Settings shows these read-only and writes
 * only the user file's. `sources` is `readConfigSources(directory)`: the
 * global files, `OPENCODE_CONFIG`, and every folder file from the outermost
 * ancestor down to the project, json and jsonc and `.opencode`.
 */
const readOtherModelRouteSchedules = (sources, targetPath) =>
  sources.flatMap(({ path, config }) => {
    if (!path || path === targetPath) return [];
    const schedules = readModelRouteSchedules(config);
    return Array.isArray(schedules) && schedules.length > 0 ? [{ path, schedules }] : [];
  });

/**
 * The pools in the config files other than `targetPath`, with the file each
 * came from, in OpenCode's reading order. OpenCode builds its pools from
 * every file it reads, so Settings shows these read-only and writes only the
 * user file's pools. Each file's map is shown as stored: a later file's pool
 * replaces an earlier one of the same id in OpenCode's view, and the file
 * that holds a pool is where that pool is edited.
 */
const readOtherModelRoutes = (sources, targetPath) =>
  sources.flatMap(({ path, config }) => {
    if (!path || path === targetPath) return [];
    const routes = readModelRoutes(config);
    return Object.keys(routes).length > 0 ? [{ path, routes }] : [];
  });

/** The layers' files as a source list, for callers that have no readConfigSources. */
export const sourcesFromLayers = (layers) => [
  [layers.paths.userPath, layers.userConfig],
  [layers.paths.userOverridePath, layers.userOverrideConfig],
  [layers.paths.customPath, layers.customConfig],
  [layers.paths.projectPath, layers.projectConfig],
].map(([path, config]) => ({ path, config }));

const HEALTH_LIMITS = {
  firstTokenTimeoutMs: MAX_MS,
  maxResponseTimeMs: MAX_MS,
  cooldownMs: MAX_MS,
  quotaCooldownMs: MAX_MS,
  sampleWindow: MAX_COUNT,
  slowThreshold: MAX_COUNT,
};

const validateHealth = (id, health) => {
  if (!isRecord(health)) return `route "${id}" health must be an object`;
  const unknown = unknownKeysProblem(health, HEALTH_KEYS);
  if (unknown) return `route "${id}" health has ${unknown}`;
  for (const [key, max] of Object.entries(HEALTH_LIMITS)) {
    const value = health[key];
    if (value === undefined) continue;
    if (key === "firstTokenTimeoutMs" && value === false) continue;
    if (!isWhole(value, 1, max)) return `route "${id}" health.${key} must be a whole number from 1 to ${max}`;
  }
  if (health.minOutputTokensPerSecond !== undefined && !isPositiveNumber(health.minOutputTokensPerSecond))
    return `route "${id}" health.minOutputTokensPerSecond must be a positive number`;
  // OpenCode clamps slowThreshold to the window without saying so; a window
  // that cannot hold that many slow requests is refused instead.
  const windowSize = health.sampleWindow ?? DEFAULT_SAMPLE_WINDOW;
  const slowCount = health.slowThreshold ?? DEFAULT_SLOW_THRESHOLD;
  if (slowCount > windowSize)
    return `route "${id}" health.slowThreshold (${slowCount}) cannot exceed health.sampleWindow (${windowSize}): the window could never hold that many slow requests`;
  return null;
};

const BUDGET_LIMITS = ["requestsPerMinute", "requestsPerDay", "tokensPerMinute", "tokensPerDay"];

const validateBudgets = (id, budgets, targets) => {
  if (!isRecord(budgets)) return `route "${id}" budgets must map target references to allowances`;
  for (const [target, budget] of Object.entries(budgets)) {
    // OpenCode reads a budget by the concrete model a target expands to, so a
    // pattern key matches no leaf and the allowance would never apply.
    if (target.includes("*"))
      return `route "${id}" budget for "${target}" is keyed by a pattern: OpenCode reads budgets by concrete model reference, so key the budget by a concrete target instead`;
    // A route reference is not a leaf either: OpenCode looks budgets up only
    // by the concrete models a route expands to, never by `opencode-route/<id>`,
    // so a budget keyed by the reference would never apply. (Weights differ:
    // a nested route attaches under its `opencode-route/<id>` key, so a
    // weights key naming the reference is live configuration.)
    if (routeReferenceOf(target) !== null)
      return `route "${id}" budget for "${target}" is keyed by a route reference: OpenCode reads budgets by concrete model reference, so key the budget by a concrete model the route expands to instead`;
    if (!targets.some((candidate) => keyNamesTarget(target, candidate)))
      return `route "${id}" budget for "${target}" matches no target in the route`;
    if (!isRecord(budget)) return `route "${id}" budget for "${target}" must be an object`;
    const unknown = unknownKeysProblem(budget, BUDGET_KEYS);
    if (unknown) return `route "${id}" budget for "${target}" has ${unknown}`;
    for (const key of BUDGET_LIMITS) {
      if (budget[key] !== undefined && !isWhole(budget[key], 1, Number.MAX_SAFE_INTEGER))
        return `route "${id}" budget for "${target}" ${key} must be a positive whole number`;
    }
    if (budget.softLimit !== undefined && !(typeof budget.softLimit === "number" && budget.softLimit >= 0.125 && budget.softLimit <= 1))
      return `route "${id}" budget for "${target}" softLimit must be between 0.125 and 1`;
  }
  return null;
};

// Only a string is equal to its own String(), so this is a plain value check (the tuning-notes one).
const isString = (value) => String(value) === value;

const isPositiveNumber = (value) => Number.isFinite(value) && value > 0;

// A window time as OpenCode's schedule parser reads it (`minutesOf` in
// model-route-schedule.ts): "9:30", "09:30", "9:30:15" or "9:30:5", hours to
// 23, minutes to 59, seconds to 59. The parser compares minutes since
// midnight and rounds seconds down, so two spellings of one minute are the
// same time to it.
const windowTimeMinutes = (value) => {
  if (!isString(value)) return undefined;
  const match = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(value.trim());
  if (match === null) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] === undefined ? 0 : Number(match[3]);
  if (hours > 23 || minutes > 59 || seconds > 59) return undefined;
  return hours * 60 + minutes;
};

const isWindowTime = (value) => windowTimeMinutes(value) !== undefined;

const isKnownTimezone = (value) => {
  if (!isString(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value.trim() });
    return true;
  } catch {
    return false;
  }
};

/** A schedule's `when` window, judged the way OpenCode judges it: its schema first, then the
 * schedule parser, which drops a window it cannot read and takes the whole schedule with it. */
const validateScheduleWindow = (subject, window) => {
  const unknown = unknownKeysProblem(window, WINDOW_KEYS);
  if (unknown) return `${subject} window has ${unknown}`;
  if (window.daysOfWeek !== undefined) {
    if (!Array.isArray(window.daysOfWeek))
      return `${subject} window.daysOfWeek must be a list of weekday names or whole numbers from 0 to 6`;
    if (window.daysOfWeek.length === 0)
      return `${subject} window.daysOfWeek must not be empty: OpenCode drops a schedule whose day list reads as empty, so leave the key out for every day`;
    for (const day of window.daysOfWeek)
      if (!DAY_OF_WEEK_NAMES.includes(day) && !isWhole(day, 0, 6))
        return `${subject} window.daysOfWeek entry "${String(day)}" is not a weekday name or a whole number from 0 to 6`;
  }
  if (window.daysOfMonth !== undefined) {
    if (!Array.isArray(window.daysOfMonth))
      return `${subject} window.daysOfMonth must be a list of whole numbers from 1 to 31, or -1 for the last day`;
    if (window.daysOfMonth.length === 0)
      return `${subject} window.daysOfMonth must not be empty: OpenCode drops a schedule whose day list reads as empty, so leave the key out for every day`;
    for (const day of window.daysOfMonth)
      if (day !== -1 && !isWhole(day, 1, 31))
        return `${subject} window.daysOfMonth entry "${String(day)}" is not a whole number from 1 to 31 or -1`;
  }
  for (const key of ["start", "end"])
    if (window[key] !== undefined && !isWindowTime(window[key]))
      return `${subject} window.${key} must be a local time like "09:00"`;
  if (
    window.start !== undefined &&
    window.end !== undefined &&
    windowTimeMinutes(window.start) === windowTimeMinutes(window.end)
  )
    return `${subject} window.start and window.end must not be the same time: OpenCode treats an equal start and end as an empty window that can never apply`;
  if (window.timezone !== undefined && !isKnownTimezone(window.timezone))
    return `${subject} window.timezone must be an IANA timezone name OpenCode can resolve`;
  for (const key of ["from", "until"])
    if (window[key] !== undefined && !isWhole(window[key], 1, Number.MAX_SAFE_INTEGER))
      return `${subject} window.${key} must be a positive epoch-millisecond time`;
  if (window.from !== undefined && window.until !== undefined && window.from >= window.until)
    return `${subject} window.from must be before window.until: OpenCode drops a window that can never apply`;
  // A window that has already ended can never apply again: OpenCode's
  // active() check is `now >= window.until` from the moment it passes.
  if (window.until !== undefined && window.until <= Date.now())
    return `${subject} window.until is in the past: the window has already ended, so the schedule can never apply`;
  return null;
};

/**
 * Whether two `*` patterns can match one reference at the same time. A star
 * takes any run of characters, so the patterns share a reference when their
 * fixed parts line up without a clash: `openai/gpt-*` and `openai/*-luna`
 * share `openai/gpt-6-luna`, while `openai/gpt-*` and `openai/claude-*` share
 * nothing. The walk visits pairs of pattern positions. A star either takes
 * no characters, which moves past it, or takes the character the other
 * pattern fixes next, which moves that pattern on.
 */
/**
 * Whether every model reference the later pattern matches is also matched
 * by the earlier pattern. Providers must be equal, because `keyNamesTarget`
 * reads the provider literally. The model parts are `*` globs, and a glob
 * inclusion check runs over position sets: a pair of position sets is a
 * counterexample when the later pattern can end there and the earlier one
 * cannot. The alphabet is the literal characters either pattern names plus
 * one other character, because a glob transition only ever asks whether a
 * character equals one of those literals or is taken by a `*`.
 */
const patternCoversPattern = (earlier, later) => {
  const [earlierProvider, ...earlierParts] = earlier.split("/");
  const [laterProvider, ...laterParts] = later.split("/");
  if (earlierProvider !== laterProvider) return false;
  const earlierModel = earlierParts.join("/");
  const laterModel = laterParts.join("/");
  const literals = new Set([...earlierModel, ...laterModel].filter((character) => character !== "*"));
  let other = "\u0001";
  while (literals.has(other)) other = String.fromCodePoint(other.codePointAt(0) + 1);
  const alphabet = [...literals, other];
  const closure = (pattern, positions) => {
    const closed = new Set(positions);
    const stack = [...positions];
    while (stack.length > 0) {
      const position = stack.pop();
      if (pattern[position] === "*" && !closed.has(position + 1)) {
        closed.add(position + 1);
        stack.push(position + 1);
      }
    }
    return closed;
  };
  const step = (pattern, positions, character) => {
    const next = new Set();
    for (const position of positions) {
      if (pattern[position] === "*") next.add(position);
      else if (pattern[position] === character) next.add(position + 1);
    }
    return closure(pattern, next);
  };
  const keyOf = (earlierPositions, laterPositions) =>
    `${[...earlierPositions].sort((a, b) => a - b).join(",")}|${[...laterPositions].sort((a, b) => a - b).join(",")}`;
  const start = [closure(earlierModel, new Set([0])), closure(laterModel, new Set([0]))];
  const seen = new Set([keyOf(start[0], start[1])]);
  const stack = [start];
  while (stack.length > 0) {
    const [earlierPositions, laterPositions] = stack.pop();
    if (laterPositions.has(laterModel.length) && !earlierPositions.has(earlierModel.length)) return false;
    for (const character of alphabet) {
      const nextEarlier = step(earlierModel, earlierPositions, character);
      const nextLater = step(laterModel, laterPositions, character);
      if (nextLater.size === 0) continue;
      const key = keyOf(nextEarlier, nextLater);
      if (seen.has(key)) continue;
      seen.add(key);
      stack.push([nextEarlier, nextLater]);
    }
  }
  return true;
};

const patternsOverlap = (first, second) => {
  const seen = new Set();
  const stack = [[0, 0]];
  while (stack.length > 0) {
    const [i, j] = stack.pop();
    const key = `${i},${j}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (i === first.length && j === second.length) return true;
    if (first[i] === "*") stack.push([i + 1, j]);
    if (second[j] === "*") stack.push([i, j + 1]);
    if (first[i] === "*" && j < second.length && second[j] !== "*") stack.push([i, j + 1]);
    else if (second[j] === "*" && i < first.length && first[i] !== "*") stack.push([i + 1, j]);
    else if (first[i] !== undefined && first[i] === second[j]) stack.push([i + 1, j + 1]);
  }
  return false;
};

/** A route's `schedules`: time-bound weight changes, as OpenCode's Schedule schema defines them.
 * A schedule with nothing to change, or with both changes, is refused: OpenCode drops the first
 * kind without a word and applies only the weight of the second, ignoring its factor. */
const validateSchedules = (id, schedules, targets) => {
  if (!Array.isArray(schedules)) return `route "${id}" schedules must be a list of schedule objects`;
  for (const [index, schedule] of schedules.entries()) {
    const label = `schedule ${index + 1}`;
    if (!isRecord(schedule)) return `route "${id}" ${label} must be an object`;
    const unknown = unknownKeysProblem(schedule, SCHEDULE_KEYS);
    if (unknown) return `route "${id}" ${label} has ${unknown}`;
    if (schedule.id !== undefined && !isString(schedule.id))
      return `route "${id}" ${label} id must be a string`;
    if (schedule.note !== undefined && !isString(schedule.note))
      return `route "${id}" ${label} note must be a string`;
    if (schedule.targets !== undefined) {
      if (!Array.isArray(schedule.targets) || schedule.targets.some((target) => !isString(target) || target.trim() === ""))
        return `route "${id}" ${label} targets must be a list of non-empty target references`;
      if (schedule.targets.length === 0)
        return `route "${id}" ${label} targets must not be empty: OpenCode applies a schedule with an empty targets list to every target in the route, so leave the key out for every target`;
      for (const rawEntry of schedule.targets) {
        // OpenCode trims each schedule entry before matching it, so the
        // entry is judged by its trimmed spelling: padding alone neither
        // refuses an entry OpenCode would apply nor changes which of the
        // specific verdicts below an entry gets.
        const entry = rawEntry.trim();
        // OpenCode matches a schedule entry against a `provider/model`
        // reference, which carries no variant, so an entry spelled with the
        // `#variant` suffix targets use everywhere else can never match.
        if (entry.includes("#"))
          return `route "${id}" ${label} target "${entry}" carries a "#variant" suffix: OpenCode matches schedule targets against provider/model references without a variant, so the entry would never apply`;
        // OpenCode matches a schedule entry only against the concrete leaf
        // references a route expands to, so an entry naming a route reference
        // can never match a leaf. Weights differ here: a nested route
        // attaches under its `opencode-route/<id>` key, so a weights key
        // naming the reference is live configuration.
        if (routeReferenceOf(entry) !== null)
          return `route "${id}" ${label} target "${entry}" is a route reference: OpenCode matches schedule targets against concrete provider/model references, so the entry would never apply`;
        // OpenCode's schedule matcher is case-insensitive (its glob is built
        // with the `i` flag), so the entry and the targets are compared in
        // lower case: a case-only difference still applies there.
        const entryReference = referenceOf(entry).toLowerCase();
        const matches = targets.some((target) => {
          const targetReference = referenceOf(target).toLowerCase();
          if (keyNamesTarget(entryReference, targetReference) || keyNamesTarget(targetReference, entryReference)) return true;
          // Two patterns can cover a model together even when neither covers
          // the other, so a partly overlapping pair counts as a match too.
          return entryReference.includes("*") && targetReference.includes("*") && patternsOverlap(entryReference, targetReference);
        });
        if (!matches) return `route "${id}" ${label} target "${entry}" matches no target in the route`;
      }
    }
    if (!isRecord(schedule.when)) return `route "${id}" ${label} needs a when window object`;
    const windowProblem = validateScheduleWindow(`route "${id}" ${label}`, schedule.when);
    if (windowProblem) return windowProblem;
    if (schedule.factor !== undefined && schedule.weight !== undefined)
      return `route "${id}" ${label} gives both factor and weight: OpenCode uses the weight and ignores the factor, so give one of them`;
    if (schedule.factor === undefined && schedule.weight === undefined)
      return `route "${id}" ${label} needs a factor or a weight: OpenCode drops a schedule with neither`;
    if (schedule.factor !== undefined && !isPositiveNumber(schedule.factor))
      return `route "${id}" ${label} factor must be a positive number`;
    if (schedule.weight !== undefined && !isPositiveNumber(schedule.weight))
      return `route "${id}" ${label} weight must be a positive number`;
  }
  return null;
};

/**
 * The spelling problem in a target reference that already matches
 * TARGET_PATTERN, or null. Provider, model and variant names contain no
 * whitespace and no empty `/`-joined segments, and OpenCode does not trim target
 * references (trimming is specific to schedule entries), so a padded,
 * whitespace-containing or empty-segment reference attaches under a key no
 * real model ever has.
 * Model IDs may contain `/` (`openrouter/anthropic/claude-sonnet-4`); every
 * segment still has to be non-empty, unpadded and free of whitespace.
 */
const targetReferenceSpellingProblem = (reference) => {
  const hashIndex = reference.indexOf("#");
  const modelPart = hashIndex < 0 ? reference : reference.slice(0, hashIndex);
  const segments = modelPart.split("/");
  for (const [index, segment] of segments.entries()) {
    const name = index === 0 ? "provider" : "model";
    if (segment === "")
      return `target "${reference}" has an empty ${name} segment: OpenCode keys a target by its provider/model spelling, so a reference with an empty segment would never match a model`;
    if (segment !== segment.trim())
      return `target "${reference}" has a padded ${name} segment: OpenCode does not trim target references, so the padded spelling would never match a model`;
    if (/\s/.test(segment))
      return `target "${reference}" has a ${name} segment containing whitespace: ${name} names contain no whitespace, so the spelling would never match a model`;
  }
  if (hashIndex >= 0) {
    const variant = reference.slice(hashIndex + 1);
    if (variant !== variant.trim())
      return `target "${reference}" has a padded variant: OpenCode does not trim target references, so the padded spelling would never match a model`;
    if (/\s/.test(variant))
      return `target "${reference}" has a variant containing whitespace: variant names contain no whitespace, so the spelling would never match a model`;
  }
  return null;
};

/** A single target: a `provider/model` string or `{ model, ... }` with variant overrides. */
const validateTarget = (target) => {
  if (typeof target === "string") {
    if (!TARGET_PATTERN.test(target)) return "must look like provider/model";
    return targetReferenceSpellingProblem(target);
  }
  if (!isRecord(target)) return "must be a provider/model string or an object with a model field";
  const unknown = unknownKeysProblem(target, TARGET_KEYS);
  if (unknown) return unknown;
  if (typeof target.model !== "string" || !TARGET_PATTERN.test(target.model))
    return "its model must look like provider/model";
  const spellingProblem = targetReferenceSpellingProblem(target.model);
  if (spellingProblem) return spellingProblem;
  if (target.until !== undefined && !(Number.isInteger(target.until) && target.until > 0))
    return "its until must be a positive epoch-millisecond time";
  if (target.until !== undefined && routeReferenceOf(target.model) !== null)
    return "its until is on a route reference: OpenCode includes the referenced route unconditionally and never reads until on a reference, so the until would never apply";
  if (target.until !== undefined && target.until <= Date.now())
    return "its until is already past: OpenCode drops a target whose until has passed, so the target would leave the route as soon as the config is saved";
  if (target.defaultVariant !== undefined && routeReferenceOf(target.model) !== null)
    return "its defaultVariant is on a route reference: OpenCode expands the referenced route from its own targets and never reads defaultVariant on a reference, so the default variant would never apply";
  if (target.variants !== undefined && routeReferenceOf(target.model) !== null)
    return "its variants are on a route reference: OpenCode expands the referenced route from its own targets and never reads variants on a reference, so the variant remaps would never apply";
  if (target.defaultVariant !== undefined && (typeof target.defaultVariant !== "string" || target.defaultVariant === ""))
    return "its defaultVariant must be a string and not empty: OpenCode drops an empty default variant, so the target would run at its own default";
  if (target.defaultVariant !== undefined && target.defaultVariant !== target.defaultVariant.trim())
    return "its defaultVariant is padded with whitespace: OpenCode does not trim variant names, so the padded default variant would never apply";
  if (target.defaultVariant !== undefined && /\s/.test(target.defaultVariant))
    return "its defaultVariant contains whitespace: variant names contain no whitespace, so the default variant would never apply";
  if (target.variants !== undefined) {
    if (!isRecord(target.variants)) return "its variants must map route variants to target variants";
    for (const [from, to] of Object.entries(target.variants)) {
      if (from === "") return "its variants must not use an empty route variant as a key: no selected variant is ever empty, so the remap would never apply";
      if (from !== from.trim()) return "its variants must not use a padded route variant as a key: OpenCode does not trim variant names, so the remap would never apply";
      if (/\s/.test(from)) return "its variants must not use a route variant containing whitespace as a key: variant names contain no whitespace, so the remap would never apply";
      if (typeof to !== "string" || to === "") return `its variant remap "${from}" must be a string and not empty`;
      if (to !== to.trim()) return `its variant remap "${from}" is padded with whitespace: OpenCode does not trim variant names, so the remap would never apply`;
      if (/\s/.test(to)) return `its variant remap "${from}" contains whitespace: variant names contain no whitespace, so the remap would never apply`;
    }
  }
  return null;
};

// A weight or budget key names a target by its reference: the model with any
// `#variant` removed (core keys them that way). A `*` target also covers the
// concrete models it matches, so those keys are accepted too.
const referenceOf = (target) => (target.model ?? target).split("#")[0];

const ROUTE_REFERENCE_PREFIX = "opencode-route/";

/** The route id a target references (`opencode-route/<id>`), or null for a model target. */
const routeReferenceOf = (target) => {
  const reference = referenceOf(target);
  return reference.startsWith(ROUTE_REFERENCE_PREFIX) ? reference.slice(ROUTE_REFERENCE_PREFIX.length) : null;
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a concrete `provider/model` key is the target or one its `*` pattern matches. */
export const keyNamesTarget = (key, target) => {
  const reference = referenceOf(target);
  if (key === reference) return true;
  if (!reference.includes("*")) return false;
  const [provider, ...pattern] = reference.split("/");
  const [keyProvider, ...model] = key.split("/");
  if (provider !== keyProvider || model.length === 0) return false;
  const matcher = new RegExp(`^${pattern.join("/").split("*").map(escapeRegExp).join(".*")}$`);
  return matcher.test(model.join("/"));
};

/**
 * The concrete targets a route expands to: its own model targets plus the
 * ones reached through the routes its targets reference, transitively.
 * OpenCode reads a route's budgets by the concrete model a target expands
 * to, collecting them from every route on the trail, and it matches a
 * route's schedule entries against the same concrete leaves, so the
 * set-level check judges budget keys and schedule entries against this
 * expanded set. The visited set keeps a
 * reference cycle from looping; a cycle contributes the concrete targets
 * its members name directly. Malformed targets are skipped here and
 * reported by the single-route validation. A caller can seed the visited
 * set with a trail of routes OpenCode has already visited, so the expansion
 * is judged the way it runs from a referencing route.
 */
const expandedTargetsOf = (routes, id, trail = []) => {
  const expanded = [];
  const visited = new Set(trail);
  const walk = (routeId) => {
    if (visited.has(routeId)) return;
    visited.add(routeId);
    const route = routes[routeId];
    if (!isRecord(route) || !Array.isArray(route.targets)) return;
    for (const target of route.targets) {
      if (!isString(target) && !(isRecord(target) && isString(target.model))) continue;
      const referenced = routeReferenceOf(target);
      if (referenced === null) expanded.push(target);
      else walk(referenced);
    }
  };
  walk(id);
  return expanded;
};

export const validateModelRoute = (id, route, expandedTargets) => {
  if (!ROUTE_ID_PATTERN.test(id)) return `invalid route id "${id}"`;
  if (!isRecord(route)) return `route "${id}" must be an object`;
  const unknown = unknownKeysProblem(route, ROUTE_KEYS);
  if (unknown) return `route "${id}" has ${unknown}`;
  if (route.name !== undefined && typeof route.name !== "string") return `route "${id}" name must be a string`;
  // Only a string is equal to its own String(), so these are plain value checks.
  if (route.description !== undefined) {
    if (String(route.description) !== route.description || /[\r\n]/.test(route.description))
      return `route "${id}" description must be one line of text`;
    if (route.description.length > MAX_DESCRIPTION_LENGTH)
      return `route "${id}" description must be at most ${MAX_DESCRIPTION_LENGTH} characters`;
  }
  if (route.details !== undefined) {
    if (String(route.details) !== route.details) return `route "${id}" details must be text`;
    if (route.details.length > MAX_DETAILS_LENGTH)
      return `route "${id}" details must be at most ${MAX_DETAILS_LENGTH} characters`;
  }
  if (!Array.isArray(route.targets) || route.targets.length === 0)
    return `route "${id}" needs at least one target`;
  const seenTargets = new Set();
  const earlierTargets = [];
  for (const target of route.targets) {
    const problem = validateTarget(target);
    if (problem) return `route "${id}" has a bad target: ${problem}`;
    // OpenCode attaches each target once, keyed by its full model reference
    // (variant included, defaultVariant not), and silently drops a later
    // entry with the same key — including that entry's variant settings.
    const key = target.model ?? target;
    if (seenTargets.has(key))
      return `route "${id}" lists target "${key}" twice: OpenCode attaches each target once and silently drops the later entry, including its variant settings`;
    seenTargets.add(key);
    // A pattern target attaches every model it covers under its own
    // settings, so a later target it fully covers (with the same
    // #variant, which is part of the attach key) never attaches at all.
    // The later target can be concrete, judged with keyNamesTarget, or a
    // pattern whose whole model set the earlier pattern covers, judged
    // with patternCoversPattern. A partly overlapping pattern stays live.
    // An earlier pattern with an until is carved out: it shadows only
    // until it expires, and the later target applies after that, so
    // the pair is a staging shape rather than a dead entry. Any until
    // still present here is in the future — a past one is refused above.
    const reference = referenceOf(key);
    if (routeReferenceOf(reference) === null) {
      const variant = key.split("#")[1] ?? "";
      for (const earlier of earlierTargets) {
        if (earlier.until !== undefined) continue;
        const earlierReference = referenceOf(earlier.key);
        if (!earlierReference.includes("*") || routeReferenceOf(earlierReference) !== null) continue;
        if ((earlier.key.split("#")[1] ?? "") !== variant) continue;
        const covered = reference.includes("*")
          ? patternCoversPattern(earlierReference, reference)
          : keyNamesTarget(reference, earlierReference);
        if (covered)
          return `route "${id}" target "${key}" is already covered by the earlier pattern target "${earlier.key}": OpenCode attaches each model once, so this entry and its variant settings would never apply`;
      }
    }
    earlierTargets.push({ key, until: isRecord(target) ? target.until : undefined });
  }
  if (route.autonomy !== undefined && !AUTONOMY_LEVELS.includes(route.autonomy))
    return `route "${id}" has unknown autonomy "${route.autonomy}" (expected ${AUTONOMY_LEVELS.join(", ")})`;
  if (route.selection !== undefined && !SELECTION_MODES.includes(route.selection))
    return `route "${id}" has unknown selection "${route.selection}" (expected ${SELECTION_MODES.join(", ")})`;
  // OpenCode keeps a fixed route in its configured order, so a selection mode there would be ignored.
  if (route.autonomy === "fixed" && route.selection !== undefined && route.selection !== "ordered")
    return `route "${id}" is fixed, so it keeps its configured order; selection "${route.selection}" needs autonomy rules or higher`;
  // Weights and budgets are rules-level too: on a fixed route OpenCode replaces
  // every weight with 1 and never collects the budgets, so both would be ignored.
  if (route.autonomy === "fixed" && route.weights !== undefined)
    return `route "${id}" is fixed, so OpenCode ignores its weights; weights need autonomy rules or higher`;
  if (route.autonomy === "fixed" && route.budgets !== undefined)
    return `route "${id}" is fixed, so OpenCode ignores its budgets; budgets need autonomy rules or higher`;
  if (route.weights !== undefined) {
    if (!isRecord(route.weights)) return `route "${id}" weights must map target references to numbers`;
    for (const [key, weight] of Object.entries(route.weights)) {
      if (!isPositiveNumber(weight))
        return `route "${id}" weight for "${key}" must be a positive number`;
      // OpenCode reads a weight by the concrete key a target attaches with
      // (a leaf model or an `opencode-route/<id>` group), so a pattern key
      // matches no attach key and the weight would never apply.
      if (key.includes("*"))
        return `route "${id}" weight for "${key}" is keyed by a pattern: OpenCode reads weights by concrete target reference, so key the weight by a concrete target instead`;
      if (!route.targets.some((target) => keyNamesTarget(key, target)))
        return `route "${id}" weight for "${key}" matches no target in the route`;
    }
  }
  if (route.attempts !== undefined && !isWhole(route.attempts, 1, MAX_COUNT))
    return `route "${id}" attempts must be a whole number from 1 to ${MAX_COUNT}`;
  if (route.hedgeAfterMs !== undefined && !isWhole(route.hedgeAfterMs, 1, MAX_MS))
    return `route "${id}" hedgeAfterMs must be a whole number from 1 to ${MAX_MS}`;
  if (route.health !== undefined) {
    const problem = validateHealth(id, route.health);
    if (problem) return problem;
  }
  if (route.budgets !== undefined) {
    // The set-level caller passes the targets the route expands to through
    // its route references; a single route judged alone can only be judged
    // against its direct targets.
    const problem = validateBudgets(id, route.budgets, expandedTargets ?? route.targets);
    if (problem) return problem;
  }
  if (route.schedules !== undefined) {
    // Schedules judge against the same expanded targets: OpenCode inherits
    // a route's schedule rules into nested groups and matches them against
    // each concrete leaf, so a leaf reached through a reference counts.
    const problem = validateSchedules(id, route.schedules, expandedTargets ?? route.targets);
    if (problem) return problem;
  }
  return null;
};

export const validateModelRoutes = (routes) => {
  if (!isRecord(routes)) return "routes must be an object of route definitions";
  for (const [id, route] of Object.entries(routes)) {
    const problem = validateModelRoute(id, route, expandedTargetsOf(routes, id));
    if (problem) return problem;
  }
  // A target can reference another route in the set (`opencode-route/<id>`).
  // OpenCode drops a reference it cannot visit — the named route is not in
  // the set, or it is already on the trail (a cycle) — without a word, so a
  // dead reference is refused here, the only place it can be named.
  for (const [id, route] of Object.entries(routes)) {
    for (const target of route.targets) {
      const referenced = routeReferenceOf(target);
      // A route is always on its own trail during expansion, so a target
      // referencing the route itself is dropped from every entry point,
      // even when the route also has targets that do serve models.
      if (referenced === id)
        return `route "${id}" target "${target.model ?? target}" references its own route: OpenCode drops a self-reference during expansion, so the target would never apply`;
      if (referenced !== null && !Object.hasOwn(routes, referenced))
        return `route "${id}" target "${target.model ?? target}" references route "${referenced}", which is not one of the saved routes`;
    }
  }
  // A route expands to models only through a concrete target, its own or one
  // a referenced route reaches without revisiting a route (OpenCode's trail
  // guard drops the revisits, and a simple path to a concrete target never
  // revisits one). Seed the routes that name a concrete target, then grow
  // through references until no route is added; what is left reaches none.
  const expanding = new Set(
    Object.entries(routes)
      .filter(([, route]) => route.targets.some((target) => routeReferenceOf(target) === null))
      .map(([id]) => id),
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const [id, route] of Object.entries(routes)) {
      if (expanding.has(id)) continue;
      if (route.targets.some((target) => expanding.has(routeReferenceOf(target)))) {
        expanding.add(id);
        grew = true;
      }
    }
  }
  for (const id of Object.keys(routes))
    if (!expanding.has(id))
      return `route "${id}" would expand to no models: its targets only reference routes in a cycle that reaches no concrete model target`;
  // A reference can be dead in one route even when every route expands
  // globally. Expanding the referenced route with the referencing route
  // already on the trail is how OpenCode visits it from that route, so a
  // reference that reaches no concrete target that way contributes no
  // model to the referencing route and is refused per entry.
  for (const [id, route] of Object.entries(routes)) {
    for (const target of route.targets) {
      const referenced = routeReferenceOf(target);
      if (referenced === null || referenced === id) continue;
      if (expandedTargetsOf(routes, referenced, [id]).length === 0)
        return `route "${id}" target "${target.model ?? target}" can never serve a model in this route: route "${referenced}" reaches models only through route "${id}" itself, which OpenCode will not revisit during expansion`;
    }
  }
  return null;
};

/**
 * `experimental.model_route_schedules`: weight changes across routes, as
 * OpenCode's GlobalSchedule schema defines them. The window, the factor or
 * weight, and the list rules are the ones a route's own schedules follow: a
 * blank entry or an empty list is refused, because OpenCode reads an empty
 * matcher as "everything".
 */
export const validateModelRouteSchedules = (schedules) => {
  if (!Array.isArray(schedules)) return "schedules must be a list of schedule objects";
  for (const [index, schedule] of schedules.entries()) {
    const label = `schedule ${index + 1}`;
    if (!isRecord(schedule)) return `${label} must be an object`;
    const unknown = unknownKeysProblem(schedule, GLOBAL_SCHEDULE_KEYS);
    if (unknown) return `${label} has ${unknown}`;
    for (const key of ["id", "note"])
      if (schedule[key] !== undefined && !isString(schedule[key])) return `${label} ${key} must be a string`;
    for (const key of ["providers", "models", "targets", "routes"]) {
      const list = schedule[key];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.some((entry) => !isString(entry) || entry.trim() === ""))
        return `${label} ${key} must be a list of non-blank strings`;
      if (list.length === 0)
        return `${label} ${key} must not be empty: OpenCode reads an empty list as every ${key.slice(0, -1)}, so leave the key out instead`;
    }
    if (!isRecord(schedule.when)) return `${label} needs a when window object`;
    const windowProblem = validateScheduleWindow(label, schedule.when);
    if (windowProblem) return windowProblem;
    if (schedule.factor !== undefined && schedule.weight !== undefined)
      return `${label} sets both factor and weight: OpenCode applies the weight and ignores the factor, so keep one`;
    if (schedule.factor === undefined && schedule.weight === undefined)
      return `${label} needs a factor or a weight: OpenCode drops a schedule with neither`;
    if (schedule.factor !== undefined && !isPositiveNumber(schedule.factor)) return `${label} factor must be a positive number`;
    if (schedule.weight !== undefined && !isPositiveNumber(schedule.weight)) return `${label} weight must be a positive number`;
  }
  return null;
};

// The shape OpenCode's schema accepts for one note (`NOTE_LINE`, packages/schema/src/config/model-routes.ts):
// one line of `match: text`, with a non-space character before its first colon (never a colon) and after it.
const NOTE_LINE = /^[^:\r\n]*[^\s:][^:\r\n]*:[^\r\n]*\S[^\r\n]*$/;

export const validateModelRouteTuning = (tuning) => {
  if (!isRecord(tuning)) return "tuning must be an object";
  const unknown = unknownKeysProblem(tuning, TUNING_KEYS);
  if (unknown) return `tuning has ${unknown}`;
  if (tuning.enabled !== undefined && typeof tuning.enabled !== "boolean") return "tuning.enabled must be true or false";
  if (tuning.intervalMinutes !== undefined && !isWhole(tuning.intervalMinutes, 1, 1440))
    return "tuning.intervalMinutes must be a whole number from 1 to 1440";
  if (tuning.windowHours !== undefined && !isWhole(tuning.windowHours, 1, 336))
    return "tuning.windowHours must be a whole number from 1 to 336";
  if (tuning.notes !== undefined) {
    // Only a string is equal to its own String(), so this is a plain value check.
    if (!Array.isArray(tuning.notes) || !tuning.notes.every((line) => String(line) === line))
      return "tuning.notes must be a list of strings";
    const bad = tuning.notes.findIndex((line) => !NOTE_LINE.test(line));
    if (bad !== -1) return `tuning.notes line ${bad + 1} must read "match: text" on one line`;
  }
  return null;
};

export const registerModelRouteRoutes = (app, dependencies) => {
  const {
    readConfigLayers,
    getConfigForPath,
    writeConfig,
    CONFIG_FILE,
    isEnterpriseMode,
    refreshOpenCodeAfterConfigChange,
    resolveOptionalProjectDirectory = async () => ({ directory: null }),
    readConfigSources = (directory) => sourcesFromLayers(readConfigLayers(directory)),
  } = dependencies;

  // Only the read-only lists of other files' pools and schedules look at the
  // project: OpenCode applies every folder file's pools and schedules too, so
  // Settings shows them. Tuning keeps reading and writing as before.
  const otherFilesFor = async (req, targetPath) => {
    const { directory } = await resolveOptionalProjectDirectory(req);
    const sources = readConfigSources(directory ?? null);
    return {
      otherRoutes: readOtherModelRoutes(sources, targetPath),
      otherSchedules: readOtherModelRouteSchedules(sources, targetPath),
    };
  };

  const refuseInEnterpriseMode = (_req, res, next) =>
    isEnterpriseMode()
      ? res.status(403).json({ error: "Model pools are managed by the administrator in enterprise mode" })
      : next();

  app.get("/api/model-routes", async (req, res) => {
    try {
      const layers = readConfigLayers(null);
      const targetPath = layers.paths.userPath ?? CONFIG_FILE;
      const targetConfig = getConfigForPath(layers, targetPath);
      res.json({
        // The user file's own pools, which are the ones Settings edits; the
        // merged view would copy other files' pools into it on save.
        routes: readModelRoutes(targetConfig),
        tuning: readLayeredModelRouteTuning(sourcesFromLayers(layers)),
        // The user file's own list, which is the one Settings edits; the
        // merged view would copy other files' entries into it on save.
        schedules: readModelRouteSchedules(targetConfig),
        ...(await otherFilesFor(req, targetPath)),
        path: targetPath,
      });
    } catch (error) {
      res.status(500).json({ error: error?.message ?? "Failed to read model pools" });
    }
  });

  app.put("/api/model-routes", express.json({ limit: "256kb" }), refuseInEnterpriseMode, async (req, res) => {
    try {
      const { routes, tuning, schedules } = req.body ?? {};
      if (routes === undefined && tuning === undefined && schedules === undefined)
        return res.status(400).json({ error: "Send routes, tuning, schedules, or any of them together" });
      if (routes !== undefined) {
        const problem = validateModelRoutes(routes);
        if (problem) return res.status(400).json({ error: problem });
      }
      if (tuning !== undefined && tuning !== null) {
        const problem = validateModelRouteTuning(tuning);
        if (problem) return res.status(400).json({ error: problem });
      }
      if (schedules !== undefined && schedules !== null) {
        const problem = validateModelRouteSchedules(schedules);
        if (problem) return res.status(400).json({ error: problem });
      }
      const layers = readConfigLayers(null);
      const targetPath = layers.paths.userPath ?? CONFIG_FILE;
      const targetConfig = getConfigForPath(layers, targetPath);
      if (!isRecord(targetConfig.experimental)) targetConfig.experimental = {};
      // A file that stores the nested shape keeps it: edited values go to
      // `experimental.routes.*` and the flat key is removed, because the
      // readers fold flat under nested and a stale flat key would come back
      // as a second copy. A flat file keeps the flat keys as before.
      const nestedRoutes = readNestedRoutes(targetConfig);
      if (routes !== undefined) {
        if (nestedRoutes) {
          nestedRoutes.models = routes;
          delete targetConfig.experimental.model_routes;
        } else targetConfig.experimental.model_routes = routes;
      }
      if (tuning === null) {
        delete targetConfig.experimental.model_route_tuning;
        if (nestedRoutes) delete nestedRoutes.tuning;
      } else if (tuning !== undefined) {
        if (nestedRoutes) {
          nestedRoutes.tuning = tuning;
          delete targetConfig.experimental.model_route_tuning;
        } else targetConfig.experimental.model_route_tuning = tuning;
      }
      if (schedules === null) {
        delete targetConfig.experimental.model_route_schedules;
        if (nestedRoutes) delete nestedRoutes.schedules;
      } else if (schedules !== undefined) {
        if (nestedRoutes) {
          nestedRoutes.schedules = schedules;
          delete targetConfig.experimental.model_route_schedules;
        } else targetConfig.experimental.model_route_schedules = schedules;
      }
      writeConfig(targetConfig, targetPath);
      if (refreshOpenCodeAfterConfigChange) {
        try {
          await refreshOpenCodeAfterConfigChange("model-routes");
        } catch {
          // The file is written; a restart can pick it up later.
        }
      }
      res.json({
        routes: routes ?? readModelRoutes(targetConfig),
        tuning: tuning === undefined ? readLayeredModelRouteTuning(sourcesFromLayers(layers)) : tuning,
        schedules: readModelRouteSchedules(targetConfig),
        ...(await otherFilesFor(req, targetPath)),
        path: targetPath,
      });
    } catch (error) {
      res.status(500).json({ error: error?.message ?? "Failed to save model pools" });
    }
  });
};
