import { z } from 'zod';
import {
  JEV_LINGER_MS,
  JEV_TIMEOUT_MS,
  ROUTING_INSTRUCTIONS,
  SAFETY_CRITERIA,
  SAFETY_INSTRUCTIONS,
  SAFETY_KINDS,
} from './defaults.js';
import type { ClassifierEndpoint } from './classifier.js';
import type { HistoryEntry } from './history.js';
import type { RoutingCategory } from './store.js';
import type { JsonValue } from '../shared/json-values.js';

export interface JevQuestion {
  type: 'choice' | 'noul';
  instructions: string | string[];
  criteria?: Record<string, string>;
}
export interface JevRequest {
  state: unknown;
  questions: Record<string, JevQuestion>;
}
export interface RoutingPermission {
  id?: JsonValue | undefined;
  sessionID?: JsonValue | undefined;
  action?: JsonValue | undefined;
  resources?: JsonValue | readonly JsonValue[] | undefined;
  metadata?: JsonValue | undefined;
}
interface JevClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  lingerMs?: number;
  lingering?: Set<string>;
}

export const buildRoutingRequest = ({ categories, history, request }: { categories: Pick<RoutingCategory, 'id' | 'description'>[]; history: HistoryEntry[]; request: string }): JevRequest => {
  const criteria: Record<string, string> = {};
  for (const category of categories) criteria[category.id] = category.description;
  return {
    state: { history, request },
    questions: { category: { type: 'choice', instructions: ROUTING_INSTRUCTIONS, criteria } },
  };
};

export const buildPermissionRequest = (permission: RoutingPermission): JevRequest => ({
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

export const buildProbeRequest = (): JevRequest => ({
  state: { request: 'Which of these is a colour: blue or table?' },
  questions: {
    probe: {
      type: 'choice',
      instructions: 'Pick the word that names a colour.',
      criteria: { blue: 'A colour.', table: 'A piece of furniture.' },
    },
  },
});

export const toGeminiDecisionsRequest = ({ state, questions }: JevRequest) => ({
  input: JSON.stringify(state),
  questions: Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    const mapped = { ...question };
    if (Array.isArray(question.instructions)) mapped.instructions = question.instructions.join('\n');
    if (question.type === 'noul' && question.criteria) {
      return [id, { ...mapped, criteria: { true_description: question.criteria.true, false_description: question.criteria.false } }];
    }
    return [id, mapped];
  })),
});

const choiceAnswerSchema = z.object({ choice: z.string(), confidence: z.number() });

export const isProbeAnswer = (answer: unknown): answer is z.infer<typeof choiceAnswerSchema> => choiceAnswerSchema.safeParse(answer).success;
const noulAnswerSchema = z.object({ noul: z.number() });
const permissionAnswersSchema = z.object({
  ask: noulAnswerSchema,
  kind: z.object({ choice: z.string() }).partial().optional(),
});

export const decideRouting = (answer: JevAnswers[string], { categories, minConfidence }: { categories: RoutingCategory[]; minConfidence: number }) => {
  const parsed = choiceAnswerSchema.safeParse(answer);
  if (!parsed.success) return { category: null, reason: 'unknown-category', confidence: 0 };
  const category = categories.find((c) => c.id === parsed.data.choice) ?? null;
  if (!category) return { category: null, reason: 'unknown-category', confidence: parsed.data.confidence };
  if (parsed.data.confidence < minConfidence) return { category: null, reason: 'low-confidence', confidence: parsed.data.confidence };
  return { category, reason: 'routed', confidence: parsed.data.confidence };
};

export const decidePermission = (answers: JevAnswers, { threshold }: { threshold: number }) => {
  const parsed = permissionAnswersSchema.safeParse(answers);
  if (!parsed.success) throw new Error('Jev answer is missing the ask score');
  const score = parsed.data.ask.noul;
  return { hold: score >= threshold, score, kind: parsed.data.kind?.choice ?? null };
};

const responseSchema = z.object({ answers: z.record(z.string(), z.unknown()) });
export type JevAnswers = z.infer<typeof responseSchema>['answers'];

const lingeringEndpoints = new Set<string>();

export const createJevClient = ({
  fetchImpl = fetch,
  timeoutMs = JEV_TIMEOUT_MS,
  lingerMs = JEV_LINGER_MS,
  lingering = lingeringEndpoints,
}: JevClientOptions = {}) => ({
  ask: async (request: JevRequest, endpoint: ClassifierEndpoint) => {
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
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
