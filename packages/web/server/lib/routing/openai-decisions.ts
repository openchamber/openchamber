import path from 'node:path';
import { z } from 'zod';
import { ENTERPRISE_MODE_ERROR } from '../enterprise-mode.js';
import type { LegacyAuthEntry } from '../opencode/auth.js';
import type { JevAnswers, JevRequest, RoutingPermission } from './jev.js';

export const OPENAI_DECISIONS_URL = 'https://api.openai.com/v1/decisions';
export const OPENAI_DECISIONS_MODEL = 'gpt-6-luna';
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const directBaseURL = z.enum([OPENAI_BASE_URL, `${OPENAI_BASE_URL}/`]);
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const apiKey = z.string().trim().regex(/^[\x21-\x7e]{1,4000}$/);

export type OpenAIDecisionsCredential =
  | { status: 'ready'; key: string }
  | { status: 'api_key_required' | 'credential_unavailable' };

const directProvider = z.object({
  id: z.literal('openai'),
  integrationID: z.literal('openai').optional(),
  canonical: z.literal('openai').optional(),
  activation: z.enum(['auto', 'enabled']),
  package: z.enum(['@opencode/ai/providers/openai', '@opencode/ai/providers/openai/responses']),
  settings: z.object({ baseURL: directBaseURL }),
});

const configEntries = z.array(z.discriminatedUnion('type', [
  z.object({
    type: z.literal('document'),
    info: z.object({ providers: z.object({ openai: z.unknown().optional() }).optional() }),
  }),
  z.object({ type: z.literal('directory'), path: z.string().min(1) }),
]));

export const readOpenAIDecisionsCredential = async ({
  envKey, envBaseURL, readStored, readProviderContext,
}: {
  envKey: string | undefined;
  envBaseURL: string | undefined;
  readStored: () => Promise<LegacyAuthEntry | null>;
  readProviderContext: () => Promise<{ provider: unknown; config: unknown } | null>;
}): Promise<OpenAIDecisionsCredential> => {
  if (envBaseURL?.trim() && !directBaseURL.safeParse(envBaseURL.trim()).success) {
    return { status: 'api_key_required' };
  }
  const explicit = apiKey.safeParse(envKey);
  if (explicit.success) return { status: 'ready', key: explicit.data };
  try {
    const stored = await readStored();
    const key = apiKey.safeParse(stored?.type === 'api' ? stored.key : undefined);
    if (!key.success || stored?.type !== 'api' || Object.keys(stored.metadata ?? {}).length > 0) {
      return { status: 'api_key_required' };
    }
    const context = await readProviderContext();
    if (!context) return { status: 'credential_unavailable' };
    const config = configEntries.safeParse(context.config);
    if (!config.success) return { status: 'credential_unavailable' };
    if (!directProvider.safeParse(context.provider).success
      || config.data.some((entry) => entry.type === 'document' && entry.info.providers?.openai !== undefined)) {
      return { status: 'api_key_required' };
    }
    return { status: 'ready', key: key.data };
  } catch {
    return { status: 'credential_unavailable' };
  }
};

export interface OpenAIDecisionsEndpoint {
  format: 'openai-decisions';
  url: typeof OPENAI_DECISIONS_URL;
  model: typeof OPENAI_DECISIONS_MODEL;
  key: string;
  isAllowed: () => boolean;
}

export const openAIDecisionsBlocked = () => Object.assign(
  new Error(ENTERPRISE_MODE_ERROR),
  { status: 403, code: 'enterprise_mode' },
);

const invalidAnswer = () => Object.assign(new Error('Invalid OpenAI Decisions response'), { code: 'unparsable' });
const probability = z.number().finite().min(0).max(1);
const responseSchema = z.object({
  answers: z.array(z.discriminatedUnion('type', [
    z.object({ name: z.string(), type: z.literal('predicate'), probability }),
    z.object({ name: z.string(), type: z.literal('choice'), choice: z.string(), confidence: probability }),
  ])),
});

const permissionPaths = z.array(z.string().min(1).max(1024)).min(1).max(32);
const hasControlCharacter = (text: string) => {
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
};

export const openAIPermissionEvidence = (permission: RoutingPermission) => {
  if (permission.action !== 'read') return null;
  const paths = permissionPaths.safeParse(permission.resources);
  if (!paths.success || paths.data.some((p) =>
    path.posix.isAbsolute(p) || path.win32.isAbsolute(p)
    || /[\\:*?[\]~]/u.test(p) || hasControlCharacter(p) || p.split('/').includes('..')
  )) return null;
  return { action: permission.action, resources: paths.data };
};

const encodeRequest = ({ state, questions }: JevRequest, key: string) => {
  const input = JSON.stringify(state);
  const encodedKey = JSON.stringify(key).slice(1, -1);
  if (Buffer.byteLength(input) > MAX_REQUEST_BYTES || input.includes(encodedKey)) {
    throw new Error('OpenAI Decisions input cannot be sent');
  }
  const body = JSON.stringify({
    model: OPENAI_DECISIONS_MODEL,
    input,
    questions: Object.entries(questions).map(([name, question]) => {
      const instructions = Array.isArray(question.instructions) ? question.instructions.join('\n') : question.instructions;
      if (question.type === 'choice') {
        return {
          type: 'choice',
          name,
          instructions,
          choices: Object.entries(question.criteria ?? {}).map(([value, description]) => ({ value, description })),
        };
      }
      const { true: yes, false: no } = question.criteria ?? {};
      return {
        type: 'predicate',
        name,
        instructions: [instructions, yes && `True: ${yes}`, no && `False: ${no}`].filter(Boolean).join('\n'),
      };
    }),
  });
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES || body.includes(encodedKey)) {
    throw new Error('OpenAI Decisions input cannot be sent');
  }
  return body;
};

const readResponse = async (response: Response) => {
  if (!response.body) throw invalidAnswer();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw invalidAnswer();
      text += decoder.decode(value, { stream: true });
    }
    const result = responseSchema.safeParse(JSON.parse(text + decoder.decode()));
    if (!result.success) throw invalidAnswer();
    return result.data.answers;
  } catch {
    void reader.cancel().catch(() => {});
    throw invalidAnswer();
  } finally {
    reader.releaseLock();
  }
};

export const askOpenAIDecisions = async (
  request: JevRequest, endpoint: OpenAIDecisionsEndpoint, fetchImpl: typeof fetch, signal: AbortSignal,
): Promise<JevAnswers> => {
  const key = apiKey.safeParse(endpoint.key);
  if (!key.success) throw new Error('OpenAI Decisions requires an API key');
  const body = encodeRequest(request, key.data);
  if (!endpoint.isAllowed()) throw openAIDecisionsBlocked();
  let response;
  try {
    response = await fetchImpl(OPENAI_DECISIONS_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key.data}`, 'content-type': 'application/json' },
      redirect: 'error',
      body,
      signal,
    });
  } catch {
    throw new Error('Could not reach OpenAI Decisions');
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw Object.assign(new Error(`OpenAI Decisions responded ${response.status}`), { status: response.status });
  }
  const answers = await readResponse(response);
  const names = new Set(Object.keys(request.questions));
  const entries = answers.map((answer) => {
    if (!names.delete(answer.name)) throw invalidAnswer();
    const question = request.questions[answer.name];
    if (answer.type === 'predicate' && question?.type === 'noul') return [answer.name, { noul: answer.probability }] as const;
    if (answer.type === 'choice' && question?.type === 'choice' && Object.hasOwn(question.criteria ?? {}, answer.choice)) {
      return [answer.name, { choice: answer.choice, confidence: answer.confidence }] as const;
    }
    throw invalidAnswer();
  });
  if (names.size) throw invalidAnswer();
  if (!endpoint.isAllowed()) throw openAIDecisionsBlocked();
  return Object.fromEntries<unknown>(entries);
};
