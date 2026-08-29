import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { isAmbiguousTransportFailure, markAmbiguousTransportFailure } from '@/lib/relay/transport-error';
import type { ContextPart } from '@/lib/messages/contextParts';
import type { AttachedFile } from '@/stores/types/sessionTypes';

export type QueueAdmissionInput = {
  runtimeKey: string; sessionId: string; directory: string; text: string;
  files?: AttachedFile[]; contextParts?: ContextPart[]; agentMentionName?: string; clientMessageId: string;
};
export type QueueAdmissionResult =
  | { outcome: 'admitted'; acknowledgement: SessionInputAdmitted }
  | { outcome: 'unsupported'; error: Error }
  | { outcome: 'failed'; error: Error }
  | { outcome: 'ambiguous'; error: Error };

const unsupportedRuntimes = new Map<string, number>();
let runtimeGeneration = 0;
const UNSUPPORTED_CACHE_TTL_MS = 5 * 60 * 1000;
const ADMISSION_TIMEOUT_MS = 15_000;
const inFlightAdmissions = new Map<string, Promise<QueueAdmissionResult>>();

const isCurrentAdmissionRuntime = (input: QueueAdmissionInput, requestGeneration: number): boolean =>
  requestGeneration === runtimeGeneration && input.runtimeKey === getRuntimeKey();

const readResponseBody = async <T>(
  read: () => Promise<T>,
  signal: AbortSignal | null,
): Promise<T> => {
  if (!signal) return read();
  if (signal.aborted) throw new DOMException('The operation timed out', 'AbortError');
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new DOMException('The operation timed out', 'AbortError'));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    read().then((value) => {
      cleanup();
      resolve(value);
    }, (error) => {
      cleanup();
      reject(error);
    });
  });
};

type SessionInputAdmitted = {
  // The HTTP acknowledgement's sequence is the durable per-session event
  // sequence. Replays compare it with prompted event sequences for ordering.
  admittedSeq: number; id: string; sessionID: string;
  prompt: unknown; delivery: 'queue'; timeCreated: number; promotedSeq?: number;
};

const parseAdmissionAck = (value: unknown, expected: QueueAdmissionInput): SessionInputAdmitted | null => {
  const data = (value as { data?: unknown } | null)?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const ack = data as Record<string, unknown>;
  const id = typeof ack.messageID === 'string' ? ack.messageID : ack.id;
  const timestamp = typeof ack.timestamp === 'number' ? ack.timestamp : ack.timeCreated;
  if (ack.delivery !== 'queue' || typeof ack.admittedSeq !== 'number' || !Number.isInteger(ack.admittedSeq) || ack.admittedSeq < 0
    || id !== expected.clientMessageId || ack.sessionID !== expected.sessionId
    || typeof timestamp !== 'number' || !Number.isFinite(timestamp)
    || !('prompt' in ack) || typeof ack.prompt !== 'object' || ack.prompt === null || Array.isArray(ack.prompt)) return null;
  return {
    admittedSeq: ack.admittedSeq,
    id,
    sessionID: ack.sessionID,
    prompt: ack.prompt,
    delivery: 'queue',
    timeCreated: timestamp,
    ...(typeof ack.promotedSeq === 'number' ? { promotedSeq: ack.promotedSeq } : {}),
  };
};

// Capability is intentionally process-local. A runtime switch must never
// inherit the verdict (or an old server's capabilities).
if (typeof window !== 'undefined') {
  window.addEventListener('openchamber:runtime-endpoint-changed', () => {
    runtimeGeneration += 1;
    unsupportedRuntimes.clear();
    inFlightAdmissions.clear();
  });
}

export const buildQueueAdmissionPayload = (input: QueueAdmissionInput) => {
  // PromptInputFileAttachment's v2 schema is {uri, name?}; mime is inferred
  // by the server from the data URI. Do not send the older SDK attachment key.
  const files = (input.files ?? []).map((file) => ({ uri: file.dataUrl, name: file.filename }));
  return {
    id: input.clientMessageId,
    prompt: {
      text: input.text,
      ...(files.length ? { files } : {}),
      ...(input.agentMentionName ? { agents: [{ name: input.agentMentionName }] } : {}),
    },
    delivery: 'queue' as const,
  };
};

/** The v2 route is deliberately separate from the legacy prompt_async SDK call. */
export async function admitToDurableQueue(input: QueueAdmissionInput): Promise<QueueAdmissionResult> {
  const requestGeneration = runtimeGeneration;
  if (input.runtimeKey !== getRuntimeKey()) {
    return { outcome: 'failed', error: new Error('Message was not admitted because the runtime changed.') };
  }
  // OpenCode 1.18.x accepts no durable representation for OpenChamber's
  // structured context. Keep this message local so the normal prompt_async
  // path can send the parts with the rest of the turn.
  if (input.contextParts?.length) {
    return { outcome: 'unsupported', error: new Error('Durable queue does not support structured context') };
  }
  const unsupportedAt = unsupportedRuntimes.get(input.runtimeKey);
  if (unsupportedAt !== undefined) {
    if (Date.now() - unsupportedAt < UNSUPPORTED_CACHE_TTL_MS) {
      return { outcome: 'unsupported', error: new Error('Durable queue is not supported by this runtime') };
    }
    unsupportedRuntimes.delete(input.runtimeKey);
  }
  const key = `${input.runtimeKey}\n${input.sessionId}\n${input.clientMessageId}`;
  const existing = inFlightAdmissions.get(key);
  if (existing) return existing;
  const request = admitToDurableQueueOnce(input, requestGeneration);
  inFlightAdmissions.set(key, request);
  request.finally(() => {
    if (inFlightAdmissions.get(key) === request) inFlightAdmissions.delete(key);
  }).catch(() => undefined);
  return request;
}

async function admitToDurableQueueOnce(input: QueueAdmissionInput, requestGeneration: number): Promise<QueueAdmissionResult> {
  // v2 has session-level model/agent/variant selection only. The caller keeps
  // its captured selection for local fallback, but admission intentionally
  // does not mutate session selection non-atomically.
  let body: ReturnType<typeof buildQueueAdmissionPayload>;
  try {
    const { opencodeClient } = await import('@/lib/opencode/client');
    const normalizedFiles = await Promise.all((input.files ?? []).map(async (file) => {
      const normalized = await opencodeClient.normalizeAttachmentForAdmission({ mime: file.mimeType, filename: file.filename, url: file.dataUrl });
      return { uri: normalized.url, name: normalized.filename };
    }));
    body = buildQueueAdmissionPayload({
      ...input,
      files: (input.files ?? []).map((file, index) => ({
        ...file,
        dataUrl: normalizedFiles[index]?.uri ?? file.dataUrl,
        filename: normalizedFiles[index]?.name ?? file.filename,
      })),
    });
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    return { outcome: 'failed', error };
  }
  if (!isCurrentAdmissionRuntime(input, requestGeneration)) {
    return { outcome: 'failed', error: new Error('Message was not admitted because the runtime changed.') };
  }
  let response: Response;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), ADMISSION_TIMEOUT_MS) : null;
  try {
    response = await runtimeFetch(`/api/session/${encodeURIComponent(input.sessionId)}/prompt`, {
      method: 'POST', query: input.directory ? { directory: input.directory } : undefined,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (response.ok) {
      // Once the server has acknowledged the request, a runtime switch cannot
      // make that write un-happen. Keep a self-validating acknowledgement so
      // callers do not retry the same idempotency key and create duplicate
      // queue work. An unreadable acknowledgement remains ambiguous instead.
      const runtimeChanged = !isCurrentAdmissionRuntime(input, requestGeneration);
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.includes('application/json')) {
        if (runtimeChanged) {
          return { outcome: 'ambiguous', error: markAmbiguousTransportFailure(new Error('Durable queue response could not be verified after the runtime changed')) };
        }
        unsupportedRuntimes.set(input.runtimeKey, Date.now());
        return { outcome: 'unsupported', error: new Error('Durable queue returned a non-JSON response') };
      }
      const acknowledgement = parseAdmissionAck(await readResponseBody(() => response.json(), controller?.signal ?? null).catch(() => null), input);
      if (!acknowledgement) {
        return {
          outcome: 'ambiguous',
          error: markAmbiguousTransportFailure(new Error('Durable queue returned an invalid acknowledgement')),
        };
      }
      return { outcome: 'admitted', acknowledgement };
    }

    const detail = await readResponseBody(() => response.text(), controller?.signal ?? null).catch(() => '');
    const error = new Error(`Durable queue admission failed (${response.status})${detail ? `: ${detail}` : ''}`);
    if (isCurrentAdmissionRuntime(input, requestGeneration)
      && (response.status === 405 || response.status === 501 || (response.status === 400 && /(?:old|legacy|unsupported).*schema|schema.*(?:old|legacy|unsupported)/i.test(detail)))) {
      unsupportedRuntimes.set(input.runtimeKey, Date.now());
      return { outcome: 'unsupported', error };
    }
    if (response.status === 429) {
      return { outcome: 'failed', error };
    }
    if (response.status === 408 || response.status >= 500) {
      return { outcome: 'ambiguous', error: markAmbiguousTransportFailure(error) };
    }
    if (isCurrentAdmissionRuntime(input, requestGeneration) && response.status === 404 && !/session.*not.?found|sessionnotfound/i.test(detail)) {
      unsupportedRuntimes.set(input.runtimeKey, Date.now());
      return { outcome: 'unsupported', error };
    }
    if (response.status === 409 || [400, 401, 403, 404, 422].includes(response.status)) {
      return { outcome: 'failed', error };
    }
    return { outcome: 'ambiguous', error: markAmbiguousTransportFailure(error) };
  } catch (cause) {
    // Fetch and response-body failures may occur after the request was sent.
    const error = cause instanceof Error ? cause : new Error(String(cause));
    return { outcome: 'ambiguous', error: isAmbiguousTransportFailure(error) ? error : markAmbiguousTransportFailure(error) };
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

export const clearQueueAdmissionCapabilityCache = (): void => {
  runtimeGeneration += 1;
  unsupportedRuntimes.clear();
  inFlightAdmissions.clear();
};
