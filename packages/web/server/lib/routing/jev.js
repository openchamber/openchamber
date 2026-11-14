/**
 * The Jev side of routing: request shapes and the HTTP call. Pure builders are
 * exported so the decision logic can be tested without a network.
 */
import { z } from 'zod';
import {
  JEV_LINGER_MS,
  JEV_TIMEOUT_MS,
  ROUTING_INSTRUCTIONS,
  SAFETY_CRITERIA,
  SAFETY_INSTRUCTIONS,
  SAFETY_KINDS,
} from './defaults.js';

export const buildRoutingRequest = ({ categories, history, request }) => {
  const criteria = {};
  for (const category of categories) criteria[category.id] = category.description;
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
    ask: { type: 'noul', instructions: SAFETY_INSTRUCTIONS, criteria: SAFETY_CRITERIA },
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

/**
 * A System One request in the shape of Google's Decisions API
 * (https://aistudio.google.com/docs/decisions-api, "Request and response
 * reference"). `state` becomes `input` as JSON text, which is how Google says
 * to pass structured data ("Structured data"): the model still reads the same
 * fields under the same key paths the instructions name (`request`,
 * `history`, `answer`). A yes/no question's `true`/`false` criteria become
 * `true_description`/`false_description`; choice criteria keep their shape.
 * Instructions given as a list become one string, a line per item, as
 * `ROUTING_INSTRUCTIONS` already is: Google takes a string or text blocks,
 * not a list of strings. The answers come back in System One's shape.
 */
export const toGeminiDecisionsRequest = ({ state, questions }) => ({
  input: JSON.stringify(state),
  questions: Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    const mapped = { ...question };
    if (Array.isArray(question.instructions)) mapped.instructions = question.instructions.join('\n');
    if (question.type === 'noul' && question.criteria) {
      mapped.criteria = { true_description: question.criteria.true, false_description: question.criteria.false };
    }
    return [id, mapped];
  })),
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

const responseSchema = z.object({ answers: z.record(z.string(), z.unknown()) });

// Endpoints with a timed-out request still running; shared by every client in
// the process so routing, session work and goals together keep at most one.
const lingeringEndpoints = new Set();

export const createJevClient = ({
  fetchImpl = fetch,
  timeoutMs = JEV_TIMEOUT_MS,
  lingerMs = JEV_LINGER_MS,
  lingering = lingeringEndpoints,
} = {}) => ({
  /**
   * `endpoint` comes from `classifierEndpoint`. Resolves to the parsed answers;
   * throws with `status` on an HTTP error and `code: 'timeout'` after
   * `timeoutMs`. The first request to time out on an endpoint is not aborted:
   * it runs on, up to `lingerMs`, so a local model can finish loading, and its
   * answer is dropped. Any other timed-out request is aborted.
   */
  ask: async (request, endpoint) => {
    const abort = new AbortController();
    const started = Date.now();
    const call = (async () => {
      let response;
      try {
        response = await fetchImpl(endpoint.url, {
          method: 'POST',
          headers: { ...endpoint.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ ...(endpoint.format === 'gemini' ? toGeminiDecisionsRequest(request) : request), model: endpoint.model }),
          signal: abort.signal,
        });
      } catch (error) {
        // Node names a bad header value, the key included, in the error, which
        // then reaches Settings, broadcasts and logs.
        if (endpoint.format === 'gemini') throw new Error('Could not reach Google Gemini');
        throw error;
      }
      const text = await response.text();
      if (!response.ok) {
        throw Object.assign(new Error(`Jev responded ${response.status}`), { status: response.status });
      }
      const body = responseSchema.safeParse(JSON.parse(text));
      if (!body.success) throw new Error('Jev response has no answers');
      return { answers: body.data.answers, ms: Date.now() - started };
    })();
    let timer;
    const timedOut = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
    try {
      const result = await Promise.race([call, timedOut.then(() => null)]);
      if (result) return result;
    } finally {
      clearTimeout(timer);
    }
    call.catch(() => {});
    const key = `${endpoint.url}\n${endpoint.model}`;
    if (lingering.has(key)) {
      abort.abort();
    } else {
      lingering.add(key);
      const cap = setTimeout(() => abort.abort(), lingerMs - timeoutMs);
      cap.unref?.();
      call.finally(() => {
        clearTimeout(cap);
        lingering.delete(key);
      }).catch(() => {});
    }
    throw Object.assign(new Error(`Jev timed out after ${timeoutMs}ms`), { code: 'timeout' });
  },
});
