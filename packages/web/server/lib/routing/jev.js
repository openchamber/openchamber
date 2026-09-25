/**
 * The Jev side of routing: request shapes and the HTTP call. Pure builders are
 * exported so the decision logic can be tested without a network.
 */
import { z } from 'zod';
import {
  JEV_API_URL,
  JEV_MODEL,
  JEV_TIMEOUT_MS,
  ROUTING_INSTRUCTIONS,
  SAFETY_INSTRUCTIONS,
  SAFETY_KINDS,
  ZEN_CLIENT_ID,
  ZEN_JEV_API_URL,
  ZEN_JEV_MODEL,
} from './defaults.js';

/**
 * Where one request goes. A saved TypeSafe key wins: the user chose it and it
 * carries their own quota. Without one, the same questions go to the free Jev
 * model OpenCode Zen serves without a credential, identified as OpenChamber.
 */
export const jevEndpoint = (token) => (token
  ? { url: JEV_API_URL, model: JEV_MODEL, headers: { authorization: `Bearer ${token}` }, source: 'typesafe' }
  : { url: ZEN_JEV_API_URL, model: ZEN_JEV_MODEL, headers: { 'x-opencode-client': ZEN_CLIENT_ID }, source: 'zen-free' });

export const buildRoutingRequest = ({ categories, history, request }) => {
  const criteria = {};
  for (const category of categories) criteria[category.id] = category.description;
  return {
    state: { history, request },
    questions: { category: { type: 'choice', instructions: ROUTING_INSTRUCTIONS, criteria } },
  };
};

/** `permission` is what OpenCode reported: the tool kind, its patterns and its metadata. */
export const buildPermissionRequest = (permission) => ({
  state: {
    permission: {
      type: permission.permission,
      patterns: permission.patterns,
      metadata: permission.metadata,
    },
  },
  questions: {
    ask: { type: 'noul', instructions: SAFETY_INSTRUCTIONS },
    kind: { type: 'choice', instructions: 'What is the most significant effect of this action?', criteria: SAFETY_KINDS },
  },
});

const choiceAnswerSchema = z.object({ choice: z.string(), confidence: z.number() });
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

const responseSchema = z.object({ answers: z.record(z.string(), z.unknown()) });

export const createJevClient = ({ fetchImpl = fetch, timeoutMs = JEV_TIMEOUT_MS } = {}) => ({
  /** Resolves to the parsed answers; throws with `status` on an HTTP error and `code: 'timeout'` on abort. */
  ask: async (request, token) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const started = Date.now();
    try {
      const endpoint = jevEndpoint(token);
      const response = await fetchImpl(endpoint.url, {
        method: 'POST',
        headers: { ...endpoint.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, model: endpoint.model }),
        signal: abort.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw Object.assign(new Error(`Jev responded ${response.status}`), { status: response.status });
      }
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
