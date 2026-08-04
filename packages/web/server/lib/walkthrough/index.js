import { getRepositoryRoot } from '../git/service.js';
import { describeSmallModel, generateSmallModelText } from '../small-model/index.js';
import { buildDigest } from './digest.js';
import { indexHunks } from './hunks.js';
import { normalizeLanguage } from './languages.js';
import { buildPrompt, JSON_SHAPE_INSTRUCTION } from './prompt.js';
import { normalizeWalkthrough, parseModelJson, responseSchema } from './schema.js';
import {
  buildCacheKey,
  pruneMissingRepositories,
  readCachedWalkthrough,
  readPointer,
  writeCachedWalkthrough,
  writePointer,
} from './store.js';
import { readWalkthroughModelOverride } from './model-settings.js';
import { loadSourceSections, parseSource, sourceKey, WalkthroughSourceError } from './sources.js';

// Walkthrough generation is always user-initiated and never automatic: it costs
// tokens, and a background regeneration on every keystroke would be a way to
// spend a budget without anyone deciding to.

// This module is imported lazily, which means module-level work lands on the
// first walkthrough request. Housekeeping has no business being there, so it is
// deferred and never awaited: the request proceeds immediately and the prune
// interleaves behind it.
setTimeout(() => {
  void pruneMissingRepositories().catch(() => {
    // Housekeeping failing is not worth surfacing or retrying.
  });
}, 0).unref?.();

// A hang guard, not a pace-setter. Losing a nearly-finished generation wastes
// real money and minutes, while an over-long deadline only holds a job slot, so
// this errs long. It scales because a three-hunk edit and a 500-hunk pull
// request have no business sharing a deadline.
const GENERATION_TIMEOUT_BASE_MS = 120_000;
const GENERATION_TIMEOUT_PER_HUNK_MS = 1_000;
const GENERATION_TIMEOUT_MAX_MS = 900_000;

const generationTimeoutMs = (hunkCount) => Math.min(
  GENERATION_TIMEOUT_MAX_MS,
  GENERATION_TIMEOUT_BASE_MS + Math.max(0, hunkCount) * GENERATION_TIMEOUT_PER_HUNK_MS,
);
// A full walkthrough is a few thousand tokens of JSON. The budget exists for
// what comes before it: reasoning models spend the same allowance thinking and
// return nothing when it runs out, which is a bill for no answer.
//
// So the ask is derived from the model rather than fixed. A flat 24k was the
// same number for a 64k-context model and for one that admits to 384k output
// tokens, and on the latter it was the only reason generation failed.
//
// The reserve subtracted from the input budget is the same number, always: ask
// for more than was reserved and a large diff overruns the context mid-answer,
// which surfaces as a truncation bug rather than a budgeting one.
const MIN_OUTPUT_TOKENS = 24_000;
// A ceiling, because the reserve is taken out of the input allowance: a model
// that would let us ask for 384k tokens of answer would also let us spend a
// third of a million tokens of context reserving them, and no walkthrough needs
// that much thinking.
const MAX_OUTPUT_TOKENS = 96_000;
// Above this share of the context, the reserve starts costing more diff than
// the extra room is worth.
const OUTPUT_CONTEXT_SHARE = 0.25;

/**
 * Answer allowance for a specific model: as much as it admits it can emit,
 * bounded by a share of its context and never below what this feature always
 * asked for.
 */
const walkthroughOutputTokens = ({ contextTokens, outputTokenLimit }) => {
  const wanted = Math.min(
    MAX_OUTPUT_TOKENS,
    Math.max(MIN_OUTPUT_TOKENS, Math.floor((Number(contextTokens) || 0) * OUTPUT_CONTEXT_SHARE)),
  );
  // A model whose own limit is below the floor gets its limit: asking for more
  // than a provider allows is rejected outright by some and ignored by others.
  return Number(outputTokenLimit) > 0 ? Math.min(wanted, Number(outputTokenLimit)) : wanted;
};

const fail = (message, statusCode, extra = {}) =>
  Object.assign(new Error(message), { statusCode, ...extra });

// Generation outlives the request that started it.
//
// A dropped connection and a deliberate cancel look identical at the socket, so
// tying the work to the request lifetime meant an accidental refresh threw away
// a minute of paid-for work. Jobs are keyed by repository + source, so a client
// that comes back attaches to the running job instead of starting a second one,
// and cancelling is an explicit request rather than a side effect of leaving.
const jobs = new Map();

// Providers that answered a schema request with a 4xx. Retrying the schema on
// every generation means paying for a call we already know will fail, so the
// refusal is remembered and the fallback goes first next time.
//
// Process-lifetime only, on purpose: a provider that gains structured-output
// support should not need a settings change to be tried again — a restart is
// enough, and the cost of one wasted first attempt after that is small.
const schemaRefusedBy = new Set();

const modelKey = (model) => `${model.providerID}/${model.modelID}`;

const jobKey = (repoRoot, sourceKeyValue) => `${repoRoot}\0${sourceKeyValue}`;

/**
 * Coarse stages, reported so a long wait is legible.
 *
 * Only phases a person can actually wait on are named. Building the digest and
 * reading the cache take single-digit milliseconds; giving them their own rows
 * would imply progress where there is none. `retrying` appears only when a
 * provider rejects the schema and the prompt-side fallback runs.
 */
export const GENERATION_STAGES = ['collecting', 'asking', 'retrying', 'assembling'];

const setStage = (repoRoot, sourceKeyValue, stage) => {
  const job = jobs.get(jobKey(repoRoot, sourceKeyValue));
  if (job) job.stage = stage;
};

/**
 * Current stage of a running generation, or `null` when nothing is running.
 * Reads memory only — no git, no network — so it is cheap to poll.
 */
export function getGenerationStage(repoRoot, sourceKeyValue) {
  return jobs.get(jobKey(repoRoot, sourceKeyValue))?.stage ?? null;
}

/**
 * Whether a generation is currently running for a source. Lets a reconnecting
 * client show progress instead of an empty panel.
 */
export function isGenerating(repoRoot, sourceKeyValue) {
  return jobs.has(jobKey(repoRoot, sourceKeyValue));
}

/**
 * Resolve the pair the job registry is keyed by, for callers that need to look
 * a job up without doing any diff work.
 */
export async function getRepositoryRootFor(directory, rawSource) {
  const source = parseSource(rawSource);
  return { repoRoot: await getRepositoryRoot(directory), sourceKey: sourceKey(source) };
}

/**
 * Stop a running generation. Only an explicit request does this — leaving the
 * page does not.
 */
export async function cancelWalkthroughGeneration({ directory, source: rawSource }) {
  const source = parseSource(rawSource);
  const repoRoot = await getRepositoryRoot(directory);
  const job = jobs.get(jobKey(repoRoot, sourceKey(source)));
  if (!job) return { cancelled: false };
  job.controller.abort();
  return { cancelled: true };
}

const modelLabel = (model) => `${model.providerID}/${model.modelID}`;

/**
 * Resolve the model for this feature: the walkthrough override when set,
 * otherwise whatever the small-model chain resolves to.
 */
/**
 * Resolve the model for this feature. An explicit per-review choice outranks the
 * saved setting, which in turn outranks the small-model chain — the user picking
 * a roomier model for a risky change is the most specific intent there is.
 */
const resolveModel = (directory, explicitModel) => describeSmallModel({
  directory,
  outputReserveTokens: walkthroughOutputTokens,
  overrideModel: explicitModel || readWalkthroughModelOverride(),
});

export const __testing = { generationTimeoutMs, walkthroughOutputTokens };

/**
 * Current diff for a source, parsed into files and hunks.
 */
async function loadCurrentDiff(directory, source, deps) {
  const { sections } = await loadSourceSections(directory, source, deps);
  const built = buildDigest(sections);
  return built;
}

const stopHunkIds = (walkthrough) =>
  walkthrough.chapters.flatMap((chapter) => chapter.stops.flatMap((stop) => stop.hunkIds));

/**
 * Compare a stored walkthrough against the diff as it is right now.
 *
 * Staleness is not a heuristic here: a hunk id is a hash of the hunk's content,
 * so an anchor that no longer resolves is proof that the code it described has
 * changed or gone. Anchors that still resolve are still accurate.
 */
function resolveAgainstCurrent(walkthrough, hunkIndex) {
  const missingHunkIds = [];
  const staleStopIds = [];

  for (const chapter of walkthrough.chapters) {
    for (const stop of chapter.stops) {
      const missing = stop.hunkIds.filter((id) => !hunkIndex.has(id));
      if (missing.length === 0) continue;
      missingHunkIds.push(...missing);
      staleStopIds.push(stop.id);
    }
  }

  const covered = new Set(stopHunkIds(walkthrough));
  const uncoveredHunkIds = [...hunkIndex.keys()].filter((id) => !covered.has(id));

  return {
    isStale: missingHunkIds.length > 0,
    missingHunkIds,
    staleStopIds,
    uncoveredHunkIds,
  };
}

const serializeHunks = (files) => files.flatMap((file) => file.hunks.map((hunk) => ({
  id: hunk.id,
  path: file.path,
  oldPath: file.oldPath || null,
  status: file.status,
  scope: file.scope,
  header: hunk.header,
  newStart: hunk.newStart,
  added: hunk.added,
  deleted: hunk.deleted,
  patch: hunk.patch,
})));

/**
 * Read the last walkthrough for a source, resolved against the current diff.
 * Never generates and never spends tokens.
 */
export async function getWalkthrough({ directory, source: rawSource, model: explicitModel, language: rawLanguage }, deps = {}) {
  const source = parseSource(rawSource);
  const repoRoot = await getRepositoryRoot(directory);
  const key = sourceKey(source);
  const language = normalizeLanguage(rawLanguage);

  const pointer = readPointer(repoRoot, key);
  // One diff, one model lookup, both answers. These used to be separate
  // endpoints the client called in parallel, which meant every panel open ran
  // the whole git pipeline twice.
  const [built, model] = await Promise.all([
    loadCurrentDiff(directory, source, deps),
    resolveModel(directory, explicitModel).catch(() => null),
  ]);
  const { files } = built;
  const hunkIndex = indexHunks(files);
  const readiness = computeReadiness({ ...built, model, source, language });

  const base = {
    source,
    hunks: serializeHunks(files),
    hunkCount: hunkIndex.size,
    readiness,
    generating: isGenerating(repoRoot, key),
  };

  // Ask the cache for *this* request before falling back to the pointer.
  //
  // The pointer only knows which walkthrough was generated here last, which
  // after a model or language switch is the answer to a different question:
  // the panel would keep showing the English review while the picker said
  // Ukrainian, even though the Ukrainian one was sitting in the cache. The key
  // is computed from the diff this read already parsed, so this costs a file
  // read and no git work at all.
  const requestedKey = model
    ? buildCacheKey({
      repoRoot,
      sourceKey: key,
      providerID: model.providerID,
      modelID: model.modelID,
      language,
      files,
    })
    : null;

  const requested = requestedKey ? readCachedWalkthrough(requestedKey) : null;
  const entry = requested ?? (pointer ? readCachedWalkthrough(pointer.cacheKey) : null);
  if (!entry) {
    // No pointer, or the pointer outlived its entry (eviction, manual cleanup).
    // "No walkthrough" is the truthful answer either way; the pointer is left
    // for the next generation to overwrite.
    return { ...base, walkthrough: null };
  }

  // Showing it makes it the last walkthrough shown here, and a regeneration
  // re-authors from whatever the reader is actually looking at. Only written
  // when it moved, so an unchanged read stays a pure read.
  if (requested && pointer?.cacheKey !== requestedKey) {
    writePointer(repoRoot, key, {
      repoRoot,
      sourceKey: key,
      cacheKey: requestedKey,
      generatedAt: requested.generatedAt,
    });
  }

  return {
    ...base,
    walkthrough: entry.walkthrough,
    model: entry.model,
    // The language the text on screen is actually written in, which is not
    // necessarily the one being asked for now. The picker needs the difference:
    // it is what lets it default to what produced this rather than to a setting.
    language: entry.language ?? null,
    generatedAt: entry.generatedAt,
    ...resolveAgainstCurrent(entry.walkthrough, hunkIndex),
  };
}

/**
 * Whether the resolved model can do this job, computed from a digest the caller
 * already built.
 *
 * Folded into the walkthrough read rather than living on its own endpoint: both
 * answers need the same diff, and computing it twice doubled the git work on
 * every panel open.
 */
function computeReadiness({ model, digest, files, fileCount, hunkCount, generatedFileCount, source, language }) {
  if (!model) return { ready: false, reason: 'no-model' };

  if (hunkCount === 0) {
    // "Only a lockfile changed" is a different answer from "nothing changed",
    // and the user can act on it (commit and move on) rather than wonder why
    // the review refuses.
    const reason = files.length > 0 && generatedFileCount === files.length ? 'only-generated' : 'empty-diff';
    return { ready: false, reason, model, generatedFileCount };
  }

  // Built with the same language the generation would use: the instruction is
  // part of the prompt, so a readiness answer computed without it would be
  // measuring a request nobody is going to send.
  const { prompt, system } = buildPrompt({ digest, fileCount, hunkCount, source, language });
  const requiredChars = prompt.length + system.length;

  if (model.structuredOutput === false) {
    return { ready: false, reason: 'structured-output-unsupported', model, requiredChars };
  }

  if (requiredChars > model.inputCharBudget) {
    return {
      ready: false,
      reason: 'context-too-small',
      model,
      requiredChars,
      availableChars: model.inputCharBudget,
    };
  }

  return { ready: true, model, requiredChars, availableChars: model.inputCharBudget, hunkCount, fileCount };
}

/**
 * Generate a walkthrough for a source.
 *
 * Returns the cached entry when the diff, model, and prompt are all unchanged —
 * which also means returning to a previous state of the working tree costs
 * nothing.
 */
export async function generateWalkthrough({ directory, source: rawSource, force = false, model: explicitModel, language: rawLanguage }, deps = {}) {
  const source = parseSource(rawSource);
  const repoRoot = await getRepositoryRoot(directory);
  const key = sourceKey(source);
  const language = normalizeLanguage(rawLanguage);

  // Attach to a running job rather than starting a second one. A user who
  // refreshed and pressed the button again wants the answer, not two bills.
  const existing = jobs.get(jobKey(repoRoot, key));
  if (existing) return existing.promise;

  const controller = new AbortController();
  const promise = runGeneration({ directory, source, repoRoot, key, force, explicitModel, language, signal: controller.signal }, deps)
    .finally(() => {
      if (jobs.get(jobKey(repoRoot, key))?.controller === controller) {
        jobs.delete(jobKey(repoRoot, key));
      }
    });

  jobs.set(jobKey(repoRoot, key), { controller, promise, stage: 'collecting' });
  return promise;
}

async function runGeneration({ directory, source, repoRoot, key, force, explicitModel, language, signal }, deps) {

  const model = await resolveModel(directory, explicitModel);
  if (!model) {
    throw fail('No model is available — sign in to a provider first', 404, { code: 'no-model' });
  }

  const { digest, files, idByAlias, fileCount, hunkCount, generatedFileCount } = await loadCurrentDiff(directory, source, deps);
  setStage(repoRoot, key, 'asking');
  if (hunkCount === 0) {
    if (files.length > 0 && generatedFileCount === files.length) {
      throw fail('Only generated files changed — there is nothing to review', 400, { code: 'only-generated' });
    }
    throw fail('There are no changes to review', 400, { code: 'empty-diff' });
  }

  const cacheKey = buildCacheKey({
    repoRoot,
    sourceKey: key,
    providerID: model.providerID,
    modelID: model.modelID,
    language,
    files,
  });

  const hunkIndex = indexHunks(files);

  if (!force) {
    const cached = readCachedWalkthrough(cacheKey);
    if (cached) {
      writePointer(repoRoot, key, {
        repoRoot,
        sourceKey: key,
        cacheKey,
        generatedAt: cached.generatedAt,
      });
      return {
        source,
        walkthrough: cached.walkthrough,
        model: cached.model,
        language: cached.language ?? null,
        generatedAt: cached.generatedAt,
        fromCache: true,
        hunks: serializeHunks(files),
        hunkCount,
        ...resolveAgainstCurrent(cached.walkthrough, hunkIndex),
      };
    }
  }

  // A forced regeneration hands the model its own previous narrative so it can
  // keep what is still true instead of starting from a blank page. The old
  // anchors are deliberately not included — they belong to code that has moved.
  let previousWalkthrough = null;
  const pointer = readPointer(repoRoot, key);
  if (pointer) {
    const previousEntry = readCachedWalkthrough(pointer.cacheKey);
    if (previousEntry && previousEntry.cacheKey !== cacheKey) {
      previousWalkthrough = previousEntry.walkthrough;
    }
  }

  const { prompt, system } = buildPrompt({ digest, fileCount, hunkCount, source, previousWalkthrough, language });

  if (model.structuredOutput === false) {
    throw fail(
      `${modelLabel(model)} cannot produce structured output — choose a different small model`,
      409,
      { code: 'structured-output-unsupported', model },
    );
  }

  const run = (options) => generateSmallModelText({
    prompt: options.prompt,
    system: options.system,
    directory,
    model: `${model.providerID}/${model.modelID}`,
    responseSchema: options.responseSchema,
    onOverflow: 'error',
    timeoutMs: generationTimeoutMs(hunkCount),
    // The number the input budget was already reduced by, not a fresh guess.
    maxOutputTokens: model.outputTokens ?? MIN_OUTPUT_TOKENS,
    signal,
  });

  // Roughly half the catalog does not declare `structured_output`, and some of
  // those providers reject the schema outright. A rejected request shape is not
  // a dead end: the shape can travel in the prompt instead, and the response
  // parser is already tolerant of imperfect JSON.
  const withSchema = () => run({ prompt, system, responseSchema });
  const withoutSchema = () => run({
    prompt,
    system: `${system}\n${JSON_SHAPE_INSTRUCTION}`,
    responseSchema: undefined,
  });

  const asRequestFailure = (error) => {
    if (error?.code === 'context-too-small') {
      return fail(error.message, 409, {
        code: 'context-too-small',
        model,
        requiredChars: error.requiredChars,
        availableChars: error.availableChars,
      });
    }
    if (error?.code === 'output-exhausted') {
      return fail(error.message, 409, { code: 'output-exhausted', model });
    }
    return null;
  };

  const refusesSchema = (error) => error?.code === 'structured-output-unsupported'
    || (Number(error?.status) >= 400 && Number(error?.status) < 500);

  let raw;
  let usedSchema = false;

  if (schemaRefusedBy.has(modelKey(model))) {
    // Already known to refuse: skip straight to the fallback rather than pay
    // for a call whose failure is a foregone conclusion.
    setStage(repoRoot, key, 'retrying');
    try {
      raw = await withoutSchema();
    } catch (error) {
      throw asRequestFailure(error) ?? error;
    }
  } else {
    try {
      raw = await withSchema();
      usedSchema = true;
    } catch (error) {
      const failure = asRequestFailure(error);
      if (failure) throw failure;
      if (!refusesSchema(error)) throw error;

      schemaRefusedBy.add(modelKey(model));
      setStage(repoRoot, key, 'retrying');
      try {
        raw = await withoutSchema();
      } catch (fallbackError) {
        throw asRequestFailure(fallbackError) ?? fallbackError;
      }
    }
  }

  setStage(repoRoot, key, 'assembling');

  let walkthrough;
  try {
    walkthrough = normalizeWalkthrough(parseModelJson(raw.text), idByAlias);
  } catch (error) {
    // Without schema support the model was asked for JSON in prose and did not
    // deliver: that is a capability problem the user can fix by switching model,
    // so it gets the picker rather than a parser error.
    if (!usedSchema) {
      throw fail(
        `${modelLabel(model)} could not return the structured response a walkthrough needs`,
        409,
        { code: 'structured-output-unsupported', model },
      );
    }
    throw fail(
      `${modelLabel(model)} did not return a usable walkthrough — try a different small model`,
      502,
      { code: 'invalid-walkthrough', model, cause: error?.message },
    );
  }

  const generatedAt = new Date().toISOString();
  const entry = {
    cacheKey,
    generatedAt,
    repoRoot,
    sourceKey: key,
    model: { providerID: model.providerID, modelID: model.modelID, source: model.source },
    language,
    walkthrough,
  };

  // A failed write costs a regeneration next time; it must never fail the
  // request that already produced a good walkthrough.
  writeCachedWalkthrough(cacheKey, entry);
  writePointer(repoRoot, key, { repoRoot, sourceKey: key, cacheKey, generatedAt });

  return {
    source,
    walkthrough,
    model: entry.model,
    language,
    generatedAt,
    fromCache: false,
    hunks: serializeHunks(files),
    hunkCount,
    ...resolveAgainstCurrent(walkthrough, hunkIndex),
  };
}

export { WalkthroughSourceError };
