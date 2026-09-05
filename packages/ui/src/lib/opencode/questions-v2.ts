/**
 * Shared native V2 question-read helper (SDK 1.18.25 `Request2.list`).
 *
 * Lives in its own module so callers that receive an SDK client as a
 * parameter (e.g. the sync/bootstrap layer) can use the V2 read without
 * importing the `OpencodeService` facade — test files that partially mock
 * `@/lib/opencode/client` must not break bootstrap's import graph
 * (see #3259 unit-5 CI finding).
 *
 * Owned by #3266 (unit-2-questions-v2-read): the OpencodeService read path
 * delegates to this helper, and #3288 (unit-5-questions-v2-bootstrap) builds
 * the directory-bootstrap caller on top of this same module. Any change to
 * V2 read semantics lands here first.
 */
import { z } from 'zod';
import type { QuestionV2Request, OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { QuestionRequest } from "@/types/question";

/**
 * Parses one native V2 question item before it crosses into the shared
 * `QuestionRequest` contract. The SDK types the payload, but the
 * pending-question UI treats this read as authoritative, so a misbehaving
 * server must fail over to V1 instead of surfacing malformed items. The
 * schema validates every field the UI-consumed shape actually carries
 * (see `QuestionRequest` consumers) — values are mapped fresh from the
 * parsed payload, nothing is passed through unvalidated.
 */
const questionV2ItemSchema = z.object({
  id: z.string().min(1),
  sessionID: z.string(),
  questions: z.array(
    z.object({
      question: z.string(),
      header: z.string(),
      options: z.array(
        z.object({
          label: z.string(),
          description: z.string(),
        }),
      ),
      multiple: z.boolean().optional(),
    }),
  ),
  tool: z
    .object({
      messageID: z.string(),
      callID: z.string(),
    })
    .optional(),
});

const parseQuestionV2Item = (item: QuestionV2Request): QuestionRequest | null => {
  const parsed = questionV2ItemSchema.safeParse(item);
  if (!parsed.success) return null;
  const request: QuestionRequest = {
    id: parsed.data.id,
    sessionID: parsed.data.sessionID,
    questions: parsed.data.questions.map((question) => ({
      question: question.question,
      header: question.header,
      multiple: question.multiple,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description,
      })),
    })),
  };
  if (parsed.data.tool) {
    request.tool = parsed.data.tool;
  }
  return request;
};

/**
 * Warn once per process per failure kind for V2 question-read fallbacks
 * that are NOT the expected pre-V2 404 compat path, so a same-version
 * upstream contract break cannot silently degrade question reads to V1
 * forever (see {@link listPendingQuestionsViaV2} for the transition plan).
 */
const questionsV2WarnedKinds = new Set<'network-error' | 'server-error' | 'malformed-payload'>();
const warnQuestionsV2FallbackOnce = (kind: 'network-error' | 'server-error' | 'malformed-payload', detail: string): void => {
  if (questionsV2WarnedKinds.has(kind)) return;
  questionsV2WarnedKinds.add(kind);
  console.warn(`[questions-v2] ${kind}: ${detail}`);
};

/** Clear the once-per-process V2 fallback warnings between tests. */
export const resetQuestionsV2FallbackWarningsForTests = (): void => {
  questionsV2WarnedKinds.clear();
};

/**
 * Native V2 question read introduced in OpenCode SDK v1.18.25. Wraps
 * `question.request.list` (unscoped for global pending items, or scoped
 * via `location.directory`) on any SDK client instance, so both the
 * `OpencodeService` read path and the directory bootstrap read path share
 * one authoritative implementation (see #3259 unit-2 / unit-5).
 *
 * Returns the pending questions on success, or `null` on failure so the
 * caller can use the V1 `question.list` path unchanged. Each item is
 * schema-validated before being accepted (see {@link parseQuestionV2Item})
 * — any malformed item fails the whole V2 attempt conservatively.
 *
 * Failures other than a server-confirmed pre-V2 404 (network error, 5xx,
 * malformed payload with a 200 status) are warned once per process per
 * failure kind before the silent `null` fallback — read-only fallback is
 * transitional, not a standing behavior.
 *
 * Removal condition: this V1 fallback is transitional. End-state is
 * capability selection via runtime protocol detection (`openCodeProtocol`
 * from `/health`, infra tracked in #3007, separate follow-up), or
 * removal of the V1 path once the supported-runtime policy sets a
 * minimum OpenCode version. Reference: #3259.
 */
export async function listPendingQuestionsViaV2(
  sdk: Pick<OpencodeClient, 'v2'>,
  directory?: string,
): Promise<QuestionRequest[] | null> {
  try {
    const response = await sdk.v2.question.request.list(
      directory ? { location: { directory } } : undefined,
    );
    // HeyApi `RequestResult` discriminates on `error`/`data`; the 200
    // payload nests the array under its own `data` field.
    if (response.error !== undefined) {
      const status = response.response?.status;
      // A server-confirmed 404 is the expected pre-V2 route-miss compat
      // path — silent fallback. Any other failure (5xx, auth/contract
      // drift) must not degrade to V1 invisibly, so warn (once per kind).
      if (status === 404) return null;
      warnQuestionsV2FallbackOnce(
        status === undefined ? 'network-error' : 'server-error',
        `question.request.list failed${status === undefined ? '' : ` (HTTP ${status})`}; falling back to V1 question.list`,
      );
      return null;
    }
    const items = response.data?.data;
    if (!Array.isArray(items)) {
      // Same-version contract drift: 200 status but a payload the typed
      // SDK path no longer matches. Warn, then fall back to V1.
      warnQuestionsV2FallbackOnce(
        'malformed-payload',
        'question.request.list returned a 200 payload that is not an item array; falling back to V1 question.list',
      );
      return null;
    }
    const validated: QuestionRequest[] = [];
    for (const item of items) {
      const parsed = parseQuestionV2Item(item);
      // Malformed item: reject the whole V2 attempt conservatively — the
      // caller falls back to V1 instead of returning partial data.
      if (!parsed) {
        warnQuestionsV2FallbackOnce(
          'malformed-payload',
          'question.request.list returned an item failing the V2 question schema; falling back to V1 question.list',
        );
        return null;
      }
      validated.push(parsed);
    }
    return validated;
  } catch (error) {
    // Network failure or runtimeFetch throwing → fall back. Never the
    // provably-pre-V2 404 path (that responds with an error result, not a
    // throw), so surface it once per kind.
    warnQuestionsV2FallbackOnce(
      'network-error',
      `question.request.list threw (${error instanceof Error ? error.message : 'unknown error'}); falling back to V1 question.list`,
    );
    return null;
  }
}
