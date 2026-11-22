/**
 * The Jev side of routing: request shapes and the HTTP call. Pure builders are
 * exported so the decision logic can be tested without a network.
 */
import { z } from 'zod';
import {
  JEV_TIMEOUT_MS,
  ROUTING_INSTRUCTIONS,
  SAFETY_INSTRUCTIONS,
  SAFETY_KINDS,
} from './defaults.js';
import { MAX_DESCRIPTION_LENGTH, MAX_DETAILS_LENGTH } from './model-routes.js';
import { readBoundedResponseText } from '../guests/response-body.js';

// A Jev answer is a small { answers } object, so 1 MiB is ample. The endpoint
// can be one the user picked in Settings or an admin pinned, so its body is
// untrusted input: ask() reads it through the bounded reader instead of
// buffering it whole, the same contract as the guests and model-discovery
// reads.
export const JEV_MAX_RESPONSE_BYTES = 1024 * 1024;

// A category whose model is a pool (`opencode-route/<id>`) runs on whatever
// that pool picks; the pool's own description says what it is for.
const ROUTE_PROVIDER_ID = 'opencode-route';
// The pool keys Jev reads. `model-routes.js` validates them on save, but the
// config file can be edited by hand, so each value is held to the same rules
// here and one that breaks them reads as absent, as the Routing page reads it.
const poolTextSchema = z.object({
  description: z.string().max(MAX_DESCRIPTION_LENGTH).regex(/^[^\r\n]*$/).optional().catch(undefined),
  details: z.string().max(MAX_DETAILS_LENGTH).optional().catch(undefined),
});

/**
 * The criteria text of one category: its description, plus the description and
 * details of the model pool it runs on, when it runs on one that has them.
 * Jev's request keeps one string per category (`ROUTING_INSTRUCTIONS` note in
 * DOCUMENTATION.md).
 */
const categoryCriteria = (category, pools) => {
  if (category.model?.providerID !== ROUTE_PROVIDER_ID) return category.description;
  const poolID = category.model.modelID;
  const pool = poolTextSchema.safeParse(Object.hasOwn(pools, poolID) ? pools[poolID] : null);
  if (!pool.success) return category.description;
  const notes = [pool.data.description, pool.data.details]
    .map((text) => text?.trim())
    .filter(Boolean);
  if (notes.length === 0) return category.description;
  return `${category.description}\n\nRuns on the model pool "${poolID}": ${notes.join('\n')}`;
};

/** `pools` is the `experimental.model_routes` map (`model-routes.js` `readModelRoutes`). */
export const buildRoutingRequest = ({ categories, history, request, pools = {} }) => {
  const criteria = {};
  for (const category of categories) criteria[category.id] = categoryCriteria(category, pools);
  return {
    state: { history, request },
    questions: { category: { type: 'choice', instructions: ROUTING_INSTRUCTIONS, criteria } },
  };
};

/**
 * `permission` is the v2 request OpenCode reported: the action (tool kind), the
 * resources it touches and its metadata. Jev's contract keeps its own names.
 */
export const buildPermissionRequest = (permission) => ({
  state: {
    permission: {
      type: permission.action,
      patterns: permission.resources,
      metadata: permission.metadata,
    },
  },
  questions: {
    ask: { type: 'noul', instructions: SAFETY_INSTRUCTIONS },
    kind: { type: 'choice', instructions: 'What is the most significant effect of this action?', criteria: SAFETY_KINDS },
  },
});

/**
 * The Settings "Test" request: one tiny choice with an obvious answer, so any
 * working provider answers it and the reply proves the whole round trip.
 */
export const buildProbeRequest = () => ({
  state: { request: 'Which of these is a colour: blue or table?' },
  questions: {
    probe: {
      type: 'choice',
      instructions: 'Pick the word that names a colour.',
      criteria: { blue: 'A colour.', table: 'A piece of furniture.' },
    },
  },
});

const choiceAnswerSchema = z.object({ choice: z.string(), confidence: z.number() });

/** True when the probe came back as a choice answer, whichever choice it made. */
export const isProbeAnswer = (answer) => choiceAnswerSchema.safeParse(answer).success;
const noulAnswerSchema = z.object({ noul: z.number() });
const permissionAnswersSchema = z.object({
  ask: noulAnswerSchema,
  kind: z.object({ choice: z.string() }).partial().optional(),
});

/**
 * Maps a Jev answer onto the category to use. Anything short of a confident,
 * known, enabled category is the fallback; the reason says which.
 */
export const decideRouting = (answer, { categories, minConfidence }) => {
  const parsed = choiceAnswerSchema.safeParse(answer);
  if (!parsed.success) return { category: null, reason: 'unknown-category', confidence: 0 };
  const category = categories.find((c) => c.id === parsed.data.choice) ?? null;
  if (!category) return { category: null, reason: 'unknown-category', confidence: parsed.data.confidence };
  if (parsed.data.confidence < minConfidence) return { category: null, reason: 'low-confidence', confidence: parsed.data.confidence };
  return { category, reason: 'routed', confidence: parsed.data.confidence };
};

export const decidePermission = (answers, { threshold }) => {
  const parsed = permissionAnswersSchema.safeParse(answers);
  if (!parsed.success) throw new Error('Jev answer is missing the ask score');
  const score = parsed.data.ask.noul;
  return { hold: score >= threshold, score, kind: parsed.data.kind?.choice ?? null };
};

const directAnswersSchema = z.object({ answers: z.record(z.string(), z.unknown()) });
const wrappedAnswersSchema = z.object({
  result: z.object({ answers: z.record(z.string(), z.unknown()) }),
}).transform((val) => ({ answers: val.result.answers }));

const responseSchema = z.union([directAnswersSchema, wrappedAnswersSchema]);

export const createJevClient = ({ fetchImpl = fetch, timeoutMs = JEV_TIMEOUT_MS } = {}) => ({
  /**
   * `endpoint` comes from `classifierEndpoint`. Resolves to the parsed answers;
   * throws with `status` on an HTTP error, `code: 'timeout'` on abort, and
   * `code: 'response_too_large'` when the body crosses JEV_MAX_RESPONSE_BYTES.
   */
  ask: async (request, endpoint) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const started = Date.now();
    try {
      const response = await fetchImpl(endpoint.url, {
        method: 'POST',
        headers: { ...endpoint.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, model: endpoint.model }),
        signal: abort.signal,
      });
      const bounded = await readBoundedResponseText(response, JEV_MAX_RESPONSE_BYTES);
      if (!response.ok) {
        throw Object.assign(new Error(`Jev responded ${response.status}`), { status: response.status });
      }
      if (bounded.tooLarge) {
        throw Object.assign(new Error(`Jev response exceeded ${JEV_MAX_RESPONSE_BYTES} bytes`), { code: 'response_too_large' });
      }
      // Response.text() (the previous read) strips a leading UTF-8 BOM; the bounded
      // reader's utf8 decode preserves it and JSON.parse rejects it, so strip it here
      // to keep BOM-prefixed endpoint answers working.
      const text = bounded.text.replace(/^\uFEFF/, '');
      const body = responseSchema.safeParse(JSON.parse(text));
      if (!body.success) throw new Error('Jev response has no answers');
      return { answers: body.data.answers, ms: Date.now() - started };
    } catch (error) {
      if (error?.name === 'AbortError') throw Object.assign(new Error(`Jev timed out after ${timeoutMs}ms`), { code: 'timeout' });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  },
});
