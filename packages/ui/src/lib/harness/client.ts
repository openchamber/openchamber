/**
 * OpenChamber harness HTTP client — non-OpenCode engine prompt/abort.
 * Uses runtimeFetch only (ui-api-decoupling). Never logs secrets or attachment bytes.
 */

import { runtimeFetch } from '@/lib/runtime-fetch';
import type { ExecutionTarget } from '@/types/harness';
import { isExecutionTarget } from '@/types/harness';

export type HarnessAttachmentFile = {
  mime: string;
  url: string;
  filename: string;
};

export type HarnessPromptParams = {
  sessionId: string;
  directory: string;
  target: ExecutionTarget;
  text: string;
  files?: HarnessAttachmentFile[];
  messageId?: string;
  assistantMessageId?: string;
  seedFromSessionId?: string;
};

export type HarnessPromptResult = {
  ok: boolean;
  sessionId: string;
  harnessId: string;
  messageId?: string;
  assistantMessageId?: string;
  status: string;
};

export type HarnessAbortParams = {
  sessionId: string;
  directory?: string;
};

export type HarnessAbortResult = {
  ok: boolean;
  sessionId?: string;
  status?: string;
  aborted?: boolean;
  reason?: string;
};

export type HarnessPermissionReply = 'once' | 'always' | 'reject';

export type HarnessPermissionReplyParams = {
  sessionId: string;
  requestId: string;
  reply: HarnessPermissionReply;
  directory?: string;
};

export type HarnessPermissionReplyResult = {
  ok: boolean;
  sessionId: string;
  requestId: string;
  reply: HarnessPermissionReply;
};

export class HarnessClientError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly status?: string;

  constructor(message: string, code: string, statusCode = 500, status?: string) {
    super(message);
    this.name = 'HarnessClientError';
    this.code = code;
    this.statusCode = statusCode;
    this.status = status;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readErrorPayload = async (response: Response): Promise<{ message: string; code: string; status?: string }> => {
  try {
    const payload = await response.json() as { error?: unknown; message?: unknown; code?: unknown; status?: unknown } | null;
    if (isRecord(payload)) {
      const message = typeof payload.error === 'string' && payload.error.trim()
        ? payload.error.trim()
        : typeof payload.message === 'string' && payload.message.trim()
          ? payload.message.trim()
          : `Request failed (${response.status})`;
      const code = typeof payload.code === 'string' && payload.code.trim()
        ? payload.code.trim()
        : 'HARNESS_ERROR';
      const status = typeof payload.status === 'string' ? payload.status : undefined;
      return { message, code, status };
    }
  } catch {
    // ignore parse failures
  }
  return { message: `Request failed (${response.status})`, code: 'HARNESS_ERROR' };
};

const normalizeFiles = (files: HarnessPromptParams['files']): HarnessAttachmentFile[] | undefined => {
  if (!files || files.length === 0) {
    return undefined;
  }
  return files.map((file) => ({
    mime: file.mime,
    url: file.url,
    filename: file.filename,
  }));
};

/** Shape the prompt request body for POST /api/harness/prompt (exported for tests). */
export function buildHarnessPromptBody(params: HarnessPromptParams): Record<string, unknown> {
  if (!params.sessionId.trim()) {
    throw new HarnessClientError('sessionId is required', 'PROMPT_INVALID', 400);
  }
  if (!params.directory.trim()) {
    throw new HarnessClientError('directory is required', 'PROMPT_INVALID', 400);
  }
  if (!isExecutionTarget(params.target) || params.target.harnessId === 'opencode') {
    throw new HarnessClientError('target must be a non-OpenCode ExecutionTarget', 'PROMPT_INVALID', 400);
  }

  const body: Record<string, unknown> = {
    sessionId: params.sessionId,
    directory: params.directory,
    target: params.target,
    text: params.text,
  };

  const files = normalizeFiles(params.files);
  if (files) {
    body.files = files;
  }
  if (params.messageId) {
    body.messageId = params.messageId;
  }
  if (params.assistantMessageId) {
    body.assistantMessageId = params.assistantMessageId;
  }
  if (params.seedFromSessionId?.trim()) {
    body.seedFromSessionId = params.seedFromSessionId.trim();
  }
  return body;
}

export async function harnessPrompt(params: HarnessPromptParams): Promise<HarnessPromptResult> {
  const body = buildHarnessPromptBody(params);
  let response: Response;
  try {
    response = await runtimeFetch('/api/harness/prompt', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Harness prompt request failed';
    throw new HarnessClientError(message, 'HARNESS_NETWORK', 0);
  }

  if (!response.ok) {
    const { message, code, status } = await readErrorPayload(response);
    throw new HarnessClientError(message, code, response.status, status);
  }

  const payload = await response.json().catch(() => null);
  if (!isRecord(payload)) {
    throw new HarnessClientError('Invalid harness prompt response', 'HARNESS_INVALID_RESPONSE', response.status);
  }

  return {
    ok: payload.ok !== false,
    sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : params.sessionId,
    harnessId: typeof payload.harnessId === 'string' ? payload.harnessId : params.target.harnessId,
    ...(typeof payload.messageId === 'string' ? { messageId: payload.messageId } : {}),
    ...(typeof payload.assistantMessageId === 'string' ? { assistantMessageId: payload.assistantMessageId } : {}),
    status: typeof payload.status === 'string' ? payload.status : 'started',
  };
}

export async function harnessAbort(params: HarnessAbortParams): Promise<HarnessAbortResult> {
  if (!params.sessionId.trim()) {
    throw new HarnessClientError('sessionId is required', 'ABORT_INVALID', 400);
  }

  const body: Record<string, unknown> = { sessionId: params.sessionId };
  if (params.directory?.trim()) {
    body.directory = params.directory.trim();
  }

  let response: Response;
  try {
    response = await runtimeFetch('/api/harness/abort', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Harness abort request failed';
    throw new HarnessClientError(message, 'HARNESS_NETWORK', 0);
  }

  if (!response.ok) {
    const { message, code, status } = await readErrorPayload(response);
    throw new HarnessClientError(message, code, response.status, status);
  }

  const payload = await response.json().catch(() => null);
  if (!isRecord(payload)) {
    return { ok: true, sessionId: params.sessionId };
  }

  return {
    ok: payload.ok !== false,
    ...(typeof payload.sessionId === 'string' ? { sessionId: payload.sessionId } : { sessionId: params.sessionId }),
    ...(typeof payload.status === 'string' ? { status: payload.status } : {}),
    ...(typeof payload.aborted === 'boolean' ? { aborted: payload.aborted } : {}),
    ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
  };
}

export async function harnessPermissionReply(
  params: HarnessPermissionReplyParams,
): Promise<HarnessPermissionReplyResult> {
  if (!params.sessionId.trim()) {
    throw new HarnessClientError('sessionId is required', 'PERMISSION_REPLY_INVALID', 400);
  }
  if (!params.requestId.trim()) {
    throw new HarnessClientError('requestId is required', 'PERMISSION_REPLY_INVALID', 400);
  }
  if (params.reply !== 'once' && params.reply !== 'always' && params.reply !== 'reject') {
    throw new HarnessClientError('reply must be once, always, or reject', 'PERMISSION_REPLY_INVALID', 400);
  }

  const body: Record<string, unknown> = {
    sessionId: params.sessionId,
    requestId: params.requestId,
    reply: params.reply,
  };
  if (params.directory?.trim()) {
    body.directory = params.directory.trim();
  }

  let response: Response;
  try {
    response = await runtimeFetch('/api/harness/permission/reply', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Harness permission reply failed';
    throw new HarnessClientError(message, 'HARNESS_NETWORK', 0);
  }

  if (!response.ok) {
    const { message, code, status } = await readErrorPayload(response);
    throw new HarnessClientError(message, code, response.status, status);
  }

  const payload = await response.json().catch(() => null);
  if (!isRecord(payload)) {
    return {
      ok: true,
      sessionId: params.sessionId,
      requestId: params.requestId,
      reply: params.reply,
    };
  }

  const reply = payload.reply === 'once' || payload.reply === 'always' || payload.reply === 'reject'
    ? payload.reply
    : params.reply;

  return {
    ok: payload.ok !== false,
    sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : params.sessionId,
    requestId: typeof payload.requestId === 'string' ? payload.requestId : params.requestId,
    reply,
  };
}
