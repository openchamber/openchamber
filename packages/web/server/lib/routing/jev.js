/**
 * The Jev side of routing: request shapes and the HTTP call. Pure builders are
 * exported so the decision logic can be tested without a network.
 */
import { z } from 'zod';
import {
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
const errorBodySchema = z.object({ error: z.object({ type: z.string().min(1) }) });

/** `Retry-After` as seconds or an HTTP date, in milliseconds from `nowMs`; null when absent or unreadable. */
export const parseRetryAfterMs = (value, nowMs) => {
  if (!value?.trim()) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
};

const formatWait = (ms) => (ms >= 60_000 ? `${Math.ceil(ms / 60_000)} min` : `${Math.ceil(ms / 1000)} s`);

const errorTypeOf = (text) => {
  try {
    return errorBodySchema.safeParse(JSON.parse(text)).data?.error.type ?? null;
  } catch {
    return null;
  }
};

/**
 * One client per server: a rate limit an endpoint reports holds for every
 * feature that calls it (Auto, the permission safety net, goal audits, turn
 * ranking), so after a 429 with `Retry-After` no call goes to that endpoint
 * and model until the time passes. Those calls fail at once with
 * `code: 'rate-limited'`, and the pause is logged once when it starts and
 * once when it ends. Logs name only the endpoint's host.
 */
export const createJevClient = ({ fetchImpl = fetch, timeoutMs = JEV_TIMEOUT_MS, now = Date.now, log = console } = {}) => {
  const pauses = new Map();
  const pauseKey = (endpoint) => `${endpoint.url}\0${endpoint.model}`;
  const hostOf = (endpoint) => {
    try {
      return new URL(endpoint.url).host;
    } catch {
      return 'the classification provider';
    }
  };

  /** Until when calls to this endpoint wait out a rate limit, or null. */
  const pausedUntil = (endpoint) => {
    const key = pauseKey(endpoint);
    const until = pauses.get(key);
    if (until === undefined) return null;
    if (until > now()) return until;
    pauses.delete(key);
    log.warn(`[jev] ${hostOf(endpoint)} rate limit is over; calling it again`);
    return null;
  };

  return {
    pausedUntil,
    /**
     * `endpoint` comes from `classifierEndpoint`. Resolves to the parsed answers;
     * throws with `status` (and `type`, `retryAfterMs` when the provider says)
     * on an HTTP error, `code: 'rate-limited'` while a rate limit holds, and
     * `code: 'timeout'` on abort.
     */
    ask: async (request, endpoint) => {
      const until = pausedUntil(endpoint);
      if (until !== null) {
        const retryAfterMs = until - now();
        throw Object.assign(new Error(`Jev is rate limited, retry in ${formatWait(retryAfterMs)}`), {
          code: 'rate-limited', status: 429, retryAfterMs,
        });
      }
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
        const text = await response.text();
        if (!response.ok) {
          const type = errorTypeOf(text);
          const retryAfterMs = parseRetryAfterMs(response.headers?.get?.('retry-after'), now());
          const detail = [type, retryAfterMs !== null ? `retry in ${formatWait(retryAfterMs)}` : null].filter(Boolean).join(', ');
          if (response.status === 429 && retryAfterMs !== null && retryAfterMs > 0) {
            pauses.set(pauseKey(endpoint), now() + retryAfterMs);
            log.warn(`[jev] ${hostOf(endpoint)} is rate limiting${type ? ` (${type})` : ''}; no calls until ${new Date(now() + retryAfterMs).toISOString()}`);
          }
          throw Object.assign(new Error(`Jev responded ${response.status}${detail ? ` (${detail})` : ''}`), {
            status: response.status, type, retryAfterMs,
          });
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
  };
};
