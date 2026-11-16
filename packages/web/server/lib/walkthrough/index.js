import { isString } from '../shared/guards.js';
import { getRepositoryRoot } from '../git/service.js';
import { describeSmallModel, generateSmallModelText } from '../small-model/index.js';
import { buildDigest } from './digest.js';
import { indexHunks } from './hunks.js';
import { normalizeLanguage } from './languages.js';
import { buildPrompt, JSON_SHAPE_INSTRUCTION } from './prompt.js';
import { normalizeWalkthrough, parseModelJson, responseSchema } from './schema.js';
import {
  buildCacheKey,
  canonicalReadContext,
  pruneMissingRepositories,
  readCachedWalkthrough,
  readPointer,
  writeCachedWalkthrough,
  writePointer,
} from './store.js';
import { readWalkthroughModelOverride, readWalkthroughModelVariant } from './model-settings.js';
import { loadSourceSections, parseSource, sourceKey, WalkthroughSourceError } from './sources.js';
import { supportsChangeRequestPatch } from './pull-request.js';

setTimeout(() => {
  void pruneMissingRepositories().catch(() => {
    // Housekeeping failing is not worth surfacing or retrying.
  });
}, 0).unref?.();

const GENERATION_TIMEOUT_BASE_MS = 120_000;
const GENERATION_TIMEOUT_PER_HUNK_MS = 1_000;
const GENERATION_TIMEOUT_MAX_MS = 900_000;

const generationTimeoutMs = (hunkCount) => Math.min(
  GENERATION_TIMEOUT_MAX_MS,
  GENERATION_TIMEOUT_BASE_MS + Math.max(0, hunkCount) * GENERATION_TIMEOUT_PER_HUNK_MS,
);
const MIN_OUTPUT_TOKENS = 24_000;
const MAX_OUTPUT_TOKENS = 96_000;
const OUTPUT_CONTEXT_SHARE = 0.25;

const walkthroughOutputTokens = ({ contextTokens, outputTokenLimit }) => {
  const wanted = Math.min(
    MAX_OUTPUT_TOKENS,
    Math.max(MIN_OUTPUT_TOKENS, Math.floor((Number(contextTokens) || 0) * OUTPUT_CONTEXT_SHARE)),
  );
  return Number(outputTokenLimit) > 0 ? Math.min(wanted, Number(outputTokenLimit)) : wanted;
};

async function readInstructions(directory, deps) {
  if (!deps.readWalkthroughInstructions) return '';
  try {
    return String((await deps.readWalkthroughInstructions(directory)) ?? '').trim();
  } catch (error) {
    throw fail(`Walkthrough instructions could not be read: ${error instanceof Error ? error.message : String(error)}`, 500, { code: 'instructions-unreadable' });
  }
}

const fail = (message, statusCode, extra = {}) =>
  Object.assign(new Error(message), { statusCode, ...extra });

const jobs = new Map();

const schemaRefusedBy = new Set();

const modelKey = (model) => `${model.providerID}/${model.modelID}`;
const addReadContext = (result, readContext) => {
  if (readContext) result.readContext = readContext;
  return result;
};

const jobKey = (repoRoot, sourceKeyValue, readContext) => readContext
  ? JSON.stringify({
    repoRoot,
    sourceKey: sourceKeyValue,
    readContext: canonicalReadContext(readContext),
  })
  : `${repoRoot}\0${sourceKeyValue}`;

const readContextForSource = (source, readContext) => {
  if (source.kind !== 'pr') return undefined;
  const valid = readContext
    && supportsChangeRequestPatch(readContext.provider)
    && isString(readContext.instance)
    && isString(readContext.accountId)
    && isString(readContext.repositoryId)
    && Number.isInteger(readContext.bindingRevision)
    && isString(readContext.directory)
    && isString(readContext.primaryRemote);
  if (!valid) {
    throw fail('A trusted source control read context is required for pull request walkthroughs', 400, {
      code: 'INVALID_SOURCE_CONTROL_READ_CONTEXT',
    });
  }
  return Object.freeze(canonicalReadContext(readContext));
};

const setStage = (repoRoot, sourceKeyValue, stage, readContext) => {
  const job = jobs.get(jobKey(repoRoot, sourceKeyValue, readContext));
  if (job) job.stage = stage;
};

export function getGenerationStage(repoRoot, sourceKeyValue, readContext) {
  return jobs.get(jobKey(repoRoot, sourceKeyValue, readContext))?.stage ?? null;
}

export function isGenerating(repoRoot, sourceKeyValue, readContext) {
  return jobs.has(jobKey(repoRoot, sourceKeyValue, readContext));
}

/** @public */
export async function getRepositoryRootFor(directory, rawSource, rawReadContext) {
  const source = parseSource(rawSource);
  const readContext = readContextForSource(source, rawReadContext);
  return { repoRoot: await getRepositoryRoot(directory), sourceKey: sourceKey(source), readContext };
}

export async function cancelWalkthroughGeneration({ directory, source: rawSource, readContext: rawReadContext }) {
  const source = parseSource(rawSource);
  const readContext = readContextForSource(source, rawReadContext);
  const repoRoot = await getRepositoryRoot(directory);
  const job = jobs.get(jobKey(repoRoot, sourceKey(source), readContext));
  if (!job) return addReadContext({ cancelled: false }, readContext);
  job.controller.abort();
  return addReadContext({ cancelled: true }, readContext);
}

const modelLabel = (model) => `${model.providerID}/${model.modelID}`;

const resolveModel = (directory, explicitModel, providerID, modelID) => {
  const savedModel = readWalkthroughModelOverride();
  const overrideModel = explicitModel || savedModel;
  return describeSmallModel({
    directory,
    outputReserveTokens: walkthroughOutputTokens,
    overrideModel,
    overrideVariant: overrideModel && overrideModel === savedModel ? readWalkthroughModelVariant() : undefined,
    preferredProviderID: providerID || undefined,
    preferredModelID: modelID || undefined,
  });
};

export const __testing = { generationTimeoutMs, walkthroughOutputTokens };

async function loadCurrentDiff(directory, source, deps, readContext) {
  const { sections } = await loadSourceSections(directory, source, { ...deps, readContext });
  const built = buildDigest(sections);
  return built;
}

const stopHunkIds = (walkthrough) =>
  walkthrough.chapters.flatMap((chapter) => chapter.stops.flatMap((stop) => stop.hunkIds));

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

export async function getWalkthrough({ directory, source: rawSource, model: explicitModel, providerID, modelID, language: rawLanguage, readContext: rawReadContext }, deps = {}) {
  const source = parseSource(rawSource);
  const readContext = readContextForSource(source, rawReadContext);
  const repoRoot = await getRepositoryRoot(directory);
  const key = sourceKey(source);
  const language = normalizeLanguage(rawLanguage);

  const pointer = readPointer(repoRoot, key, readContext);
  const [built, model, instructions] = await Promise.all([
    loadCurrentDiff(directory, source, deps, readContext),
    resolveModel(directory, explicitModel, providerID, modelID).catch(() => null),
    readInstructions(directory, deps).catch(() => ''),
  ]);
  const { files } = built;
  const hunkIndex = indexHunks(files);
  const readiness = computeReadiness({ ...built, model, source, language, instructions });

  const base = {
    source,
    hunks: serializeHunks(files),
    hunkCount: hunkIndex.size,
    readiness,
    generating: isGenerating(repoRoot, key, readContext),
  };
  addReadContext(base, readContext);

  const requestedKey = model
    ? buildCacheKey({
      repoRoot,
      sourceKey: key,
      providerID: model.providerID,
      modelID: model.modelID,
      language,
      files,
      readContext,
    })
    : null;

  const requested = requestedKey ? readCachedWalkthrough(requestedKey) : null;
  const entry = requested ?? (pointer ? readCachedWalkthrough(pointer.cacheKey) : null);
  if (!entry) {
    return { ...base, walkthrough: null };
  }

  if (requested && pointer?.cacheKey !== requestedKey) {
    writePointer(repoRoot, key, {
      repoRoot,
      sourceKey: key,
      cacheKey: requestedKey,
      generatedAt: requested.generatedAt,
    }, readContext);
  }

  return {
    ...base,
    walkthrough: entry.walkthrough,
    model: entry.model,
    language: entry.language ?? null,
    generatedAt: entry.generatedAt,
    ...resolveAgainstCurrent(entry.walkthrough, hunkIndex),
  };
}

function computeReadiness({ model, digest, files, fileCount, hunkCount, generatedFileCount, source, language, instructions }) {
  if (!model) return { ready: false, reason: 'no-model' };

  if (hunkCount === 0) {
    const reason = files.length > 0 && generatedFileCount === files.length ? 'only-generated' : 'empty-diff';
    return { ready: false, reason, model, generatedFileCount };
  }

  if (model.hasLogin === false) {
    return { ready: false, reason: 'no-provider-login' };
  }

  const { prompt, system } = buildPrompt({ digest, fileCount, hunkCount, source, language, instructions });
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

export async function generateWalkthrough({ directory, source: rawSource, force = false, model: explicitModel, providerID, modelID, language: rawLanguage, readContext: rawReadContext }, deps = {}) {
  const source = parseSource(rawSource);
  const readContext = readContextForSource(source, rawReadContext);
  const repoRoot = await getRepositoryRoot(directory);
  const key = sourceKey(source);
  const language = normalizeLanguage(rawLanguage);

  const existing = jobs.get(jobKey(repoRoot, key, readContext));
  if (existing) return existing.promise;

  const controller = new AbortController();
  const promise = runGeneration({ directory, source, repoRoot, key, force, explicitModel, providerID, modelID, language, readContext, signal: controller.signal }, deps)
    .finally(() => {
      if (jobs.get(jobKey(repoRoot, key, readContext))?.controller === controller) {
        jobs.delete(jobKey(repoRoot, key, readContext));
      }
    });

  jobs.set(jobKey(repoRoot, key, readContext), { controller, promise, stage: 'collecting' });
  return promise;
}

async function runGeneration({ directory, source, repoRoot, key, force, explicitModel, providerID, modelID, language, readContext, signal }, deps) {

  const model = await resolveModel(directory, explicitModel, providerID, modelID);
  if (!model) {
    throw fail('No model is available — sign in to a provider first', 404, { code: 'no-model' });
  }
  if (model.hasLogin === false) {
    throw fail(
      `No OpenCode login found for provider "${model.providerID}" — sign in or choose a different model`,
      401,
      { code: 'no-provider-login', model },
    );
  }

  const { digest, files, idByAlias, fileCount, hunkCount, generatedFileCount } = await loadCurrentDiff(directory, source, deps, readContext);
  setStage(repoRoot, key, 'asking', readContext);
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
    readContext,
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
      }, readContext);
      return addReadContext({
        source,
        walkthrough: cached.walkthrough,
        model: cached.model,
        language: cached.language ?? null,
        generatedAt: cached.generatedAt,
        fromCache: true,
        hunks: serializeHunks(files),
        hunkCount,
        ...resolveAgainstCurrent(cached.walkthrough, hunkIndex),
      }, readContext);
    }
  }

  let previousWalkthrough = null;
  const pointer = readPointer(repoRoot, key, readContext);
  if (pointer) {
    const previousEntry = readCachedWalkthrough(pointer.cacheKey);
    if (
      previousEntry
      && previousEntry.cacheKey !== cacheKey
      && previousEntry.model?.providerID === model.providerID
      && previousEntry.model?.modelID === model.modelID
      && normalizeLanguage(previousEntry.language) === language
    ) {
      previousWalkthrough = previousEntry.walkthrough;
    }
  }

  const instructions = await readInstructions(directory, deps);
  const { prompt, system } = buildPrompt({ digest, fileCount, hunkCount, source, previousWalkthrough, language, instructions });

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
    sessionID: `openchamber-walkthrough-${cacheKey}`,
    model: `${model.providerID}/${model.modelID}`,
    variant: model.variant,
    responseSchema: options.responseSchema,
    onOverflow: 'error',
    timeoutMs: generationTimeoutMs(hunkCount),
    maxOutputTokens: model.outputTokens ?? MIN_OUTPUT_TOKENS,
    signal,
  });

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
    if (error?.code === 'no-provider-login') {
      return fail(error.message, 401, { code: 'no-provider-login', model });
    }
    return null;
  };

  const refusesSchema = (error) => error?.code === 'structured-output-unsupported'
    || (Number(error?.status) >= 400 && Number(error?.status) < 500);

  let raw;
  let usedSchema = false;

  if (schemaRefusedBy.has(modelKey(model))) {
    setStage(repoRoot, key, 'retrying', readContext);
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
      setStage(repoRoot, key, 'retrying', readContext);
      try {
        raw = await withoutSchema();
      } catch (fallbackError) {
        throw asRequestFailure(fallbackError) ?? fallbackError;
      }
    }
  }

  setStage(repoRoot, key, 'assembling', readContext);

  let walkthrough;
  try {
    walkthrough = normalizeWalkthrough(parseModelJson(raw.text), idByAlias, digest.files);
  } catch (error) {
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
  addReadContext(entry, readContext);

  writeCachedWalkthrough(cacheKey, entry);
  writePointer(repoRoot, key, { repoRoot, sourceKey: key, cacheKey, generatedAt }, readContext);

  return addReadContext({
    source,
    walkthrough,
    model: entry.model,
    language,
    generatedAt,
    fromCache: false,
    hunks: serializeHunks(files),
    hunkCount,
    ...resolveAgainstCurrent(walkthrough, hunkIndex),
  }, readContext);
}
