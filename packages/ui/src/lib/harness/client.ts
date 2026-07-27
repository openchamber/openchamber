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
  /** Claude agents mode for this turn (`opencode` inherits OpenChamber agent prompt/permissions). */
  agentsMode?: 'claude' | 'opencode';
  /** OpenCode agent system prompt to append when agentsMode is `opencode`. */
  systemPromptAppend?: string;
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
  if (params.agentsMode === 'claude' || params.agentsMode === 'opencode') {
    body.agentsMode = params.agentsMode;
  }
  if (typeof params.systemPromptAppend === 'string' && params.systemPromptAppend.trim()) {
    body.systemPromptAppend = params.systemPromptAppend.trim();
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

export type ClaudeSessionCapabilities = {
  sessionId: string;
  foreignSessionId?: string;
  slashCommands: string[];
  skills: string[];
  agents: string[];
  tools: string[];
  mcpServers: Array<{ name: string; status: string }>;
  updatedAt: number;
};

export type HarnessSessionCapabilitiesResult = {
  sessionId: string;
  harnessId: string;
  capabilities: ClaudeSessionCapabilities;
};

const sanitizeStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
};

const sanitizeMcpServers = (value: unknown): Array<{ name: string; status: string }> => {
  if (!Array.isArray(value)) return [];
  const out: Array<{ name: string; status: string }> = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      status: typeof entry.status === 'string' && entry.status.trim() ? entry.status.trim() : 'unknown',
    });
  }
  return out;
};

export async function harnessSessionCapabilities(
  sessionId: string,
): Promise<HarnessSessionCapabilitiesResult> {
  const id = sessionId.trim();
  if (!id) {
    throw new HarnessClientError('sessionId is required', 'PROMPT_INVALID', 400);
  }

  let response: Response;
  try {
    response = await runtimeFetch(`/api/harness/sessions/${encodeURIComponent(id)}/capabilities`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Harness capabilities request failed';
    throw new HarnessClientError(message, 'HARNESS_NETWORK', 0);
  }

  if (!response.ok) {
    const { message, code, status } = await readErrorPayload(response);
    throw new HarnessClientError(message, code, response.status, status);
  }

  const payload = await response.json().catch(() => null);
  if (!isRecord(payload) || !isRecord(payload.capabilities)) {
    throw new HarnessClientError('Invalid harness capabilities response', 'HARNESS_INVALID_RESPONSE', response.status);
  }

  const caps = payload.capabilities;
  return {
    sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : id,
    harnessId: typeof payload.harnessId === 'string' ? payload.harnessId : 'claude-code',
    capabilities: {
      sessionId: typeof caps.sessionId === 'string' ? caps.sessionId : id,
      ...(typeof caps.foreignSessionId === 'string' ? { foreignSessionId: caps.foreignSessionId } : {}),
      slashCommands: sanitizeStringList(caps.slashCommands),
      skills: sanitizeStringList(caps.skills),
      agents: sanitizeStringList(caps.agents),
      tools: sanitizeStringList(caps.tools),
      mcpServers: sanitizeMcpServers(caps.mcpServers),
      updatedAt: typeof caps.updatedAt === 'number' ? caps.updatedAt : 0,
    },
  };
}

export type ClaudeImportSessionCandidate = {
  foreignSessionId: string;
  title: string | null;
  directory: string | null;
  updatedAt: number | null;
  alreadyImported: boolean;
  directoryMissing: boolean;
};

export type ClaudeImportProjectCandidate = {
  projectKey: string;
  directory: string | null;
  directoryMissing: boolean;
  sessionCount: number;
  sessions: ClaudeImportSessionCandidate[];
};

export type ClaudeImportCandidatesResult = {
  configDir: string | null;
  projectsRoot: string | null;
  projects: ClaudeImportProjectCandidate[];
};

export type ClaudeImportSessionRequest = {
  foreignSessionId: string;
  directory: string;
  title?: string | null;
};

export type ClaudeImportResultRow = {
  ok: boolean;
  foreignSessionId: string | null;
  sessionId?: string;
  directory?: string | null;
  title?: string | null;
  status?: 'imported' | 'skipped';
  reason?: string;
  error?: string;
  code?: string;
};

export type ClaudeImportResult = {
  results: ClaudeImportResultRow[];
  summary: {
    imported: number;
    skipped: number;
    failed: number;
  };
};

const parseImportCandidates = (payload: unknown): ClaudeImportCandidatesResult => {
  if (!isRecord(payload)) {
    throw new HarnessClientError('Invalid Claude import candidates response', 'HARNESS_INVALID_RESPONSE', 500);
  }
  const projectsRaw = Array.isArray(payload.projects) ? payload.projects : [];
  const projects: ClaudeImportProjectCandidate[] = [];
  for (const project of projectsRaw) {
    if (!isRecord(project)) continue;
    const sessionsRaw = Array.isArray(project.sessions) ? project.sessions : [];
    const sessions: ClaudeImportSessionCandidate[] = [];
    for (const session of sessionsRaw) {
      if (!isRecord(session)) continue;
      if (typeof session.foreignSessionId !== 'string' || !session.foreignSessionId.trim()) continue;
      sessions.push({
        foreignSessionId: session.foreignSessionId.trim(),
        title: typeof session.title === 'string' ? session.title : null,
        directory: typeof session.directory === 'string' ? session.directory : null,
        updatedAt: typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt)
          ? session.updatedAt
          : null,
        alreadyImported: session.alreadyImported === true,
        directoryMissing: session.directoryMissing === true,
      });
    }
    projects.push({
      projectKey: typeof project.projectKey === 'string' ? project.projectKey : '',
      directory: typeof project.directory === 'string' ? project.directory : null,
      directoryMissing: project.directoryMissing === true,
      sessionCount: typeof project.sessionCount === 'number' ? project.sessionCount : sessions.length,
      sessions,
    });
  }
  return {
    configDir: typeof payload.configDir === 'string' ? payload.configDir : null,
    projectsRoot: typeof payload.projectsRoot === 'string' ? payload.projectsRoot : null,
    projects,
  };
};

export async function listClaudeImportCandidates(): Promise<ClaudeImportCandidatesResult> {
  let response: Response;
  try {
    response = await runtimeFetch('/api/harness/claude-code/import/candidates', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Claude import candidates request failed';
    throw new HarnessClientError(message, 'HARNESS_NETWORK', 0);
  }

  if (!response.ok) {
    const { message, code, status } = await readErrorPayload(response);
    throw new HarnessClientError(message, code, response.status, status);
  }

  const payload = await response.json().catch(() => null);
  return parseImportCandidates(payload);
}

export async function importClaudeSessions(
  sessions: ClaudeImportSessionRequest[],
): Promise<ClaudeImportResult> {
  let response: Response;
  try {
    response = await runtimeFetch('/api/harness/claude-code/import', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sessions }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Claude import request failed';
    throw new HarnessClientError(message, 'HARNESS_NETWORK', 0);
  }

  if (!response.ok) {
    const { message, code, status } = await readErrorPayload(response);
    throw new HarnessClientError(message, code, response.status, status);
  }

  const payload = await response.json().catch(() => null);
  if (!isRecord(payload) || !isRecord(payload.summary) || !Array.isArray(payload.results)) {
    throw new HarnessClientError('Invalid Claude import response', 'HARNESS_INVALID_RESPONSE', response.status);
  }

  return {
    results: payload.results.filter(isRecord).map((row) => ({
      ok: row.ok !== false,
      foreignSessionId: typeof row.foreignSessionId === 'string' ? row.foreignSessionId : null,
      ...(typeof row.sessionId === 'string' ? { sessionId: row.sessionId } : {}),
      ...(typeof row.directory === 'string' || row.directory === null ? { directory: row.directory as string | null } : {}),
      ...(typeof row.title === 'string' || row.title === null ? { title: row.title as string | null } : {}),
      ...(row.status === 'imported' || row.status === 'skipped' ? { status: row.status } : {}),
      ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
      ...(typeof row.error === 'string' ? { error: row.error } : {}),
      ...(typeof row.code === 'string' ? { code: row.code } : {}),
    })),
    summary: {
      imported: typeof payload.summary.imported === 'number' ? payload.summary.imported : 0,
      skipped: typeof payload.summary.skipped === 'number' ? payload.summary.skipped : 0,
      failed: typeof payload.summary.failed === 'number' ? payload.summary.failed : 0,
    },
  };
}
