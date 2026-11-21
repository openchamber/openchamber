import { isRecord } from '../shared/guards.js';
import { assertPromptResponse } from '../opencode/prompt-response.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { sessionParentId } from '../session-lineage.js';
const FETCH_TIMEOUT_MS = 15_000;
const MESSAGE_FETCH_LIMIT = 20;

interface PinnedMessage {
  id: string;
  createdAt: number;
  role: 'user' | 'assistant';
}

interface ContextEntry {
  pinned: PinnedMessage;
  text: string;
}

export interface ContextObligatoryOptions {
  buildOpenCodeUrl: (path: string, query: string) => string | URL;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  persistContextCursor?: ((sessionId: string, directory: string, patch: {
    openchamber: { context_obligatory_last_compaction_message_id: unknown };
  }) => Promise<StoredMetadata | void>) | null;
  readSessionMetadata?: ((sessionId: string) => Promise<StoredMetadata | null | undefined>) | null;
}

export interface StoredMetadata {
  openchamber?: unknown;
}

interface BoundaryFields extends StoredMetadata {
  parentID?: unknown;
  metadata?: unknown;
  context_obligatory_messages?: unknown;
  context_obligatory_last_compaction_message_id?: unknown;
  id?: unknown;
  createdAt?: unknown;
  role?: unknown;
  type?: unknown;
  status?: unknown;
  text?: unknown;
  content?: unknown;
  data?: unknown;
}

interface FetchOptions {
  directory: string;
  method?: string;
  body?: { text: string; resume: boolean };
  query?: Record<string, string>;
}

export interface ContextObligatoryEvent {
  type?: string;
  properties?: { sessionID?: unknown; directory?: string | undefined };
}

const isMetadataRecord = (value: unknown): value is BoundaryFields => isRecord(value);
const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);
const isPinnedMessage = (item: unknown): item is PinnedMessage => isMetadataRecord(item)
  && typeof item.id === 'string'
  && typeof item.createdAt === 'number'
  && (item.role === 'user' || item.role === 'assistant');
const isTextPart = (part: unknown): part is { type: 'text'; text: string } => isMetadataRecord(part)
  && part.type === 'text' && typeof part.text === 'string';
const hasMessageText = (message: unknown): message is { text: string } => isMetadataRecord(message)
  && typeof message.text === 'string';
const isSessionId = (value: unknown): value is string => typeof value === 'string';

const readContextState = (session: { metadata: unknown }) => {
  const metadata = isMetadataRecord(session.metadata) ? session.metadata : {};
  const openchamber = isMetadataRecord(metadata.openchamber) ? metadata.openchamber : {};
  const messages = Array.isArray(openchamber.context_obligatory_messages)
    ? openchamber.context_obligatory_messages.filter(isPinnedMessage)
    : [];
  return { metadata, openchamber, messages };
};

const buildContextPrompt = (entries: ContextEntry[]) => {
  const timeline = entries.map(({ pinned, text }) => {
    const timestamp = new Date(pinned.createdAt).toISOString();
    return `## ${pinned.role} — ${timestamp}\n\n${text}`;
  }).join('\n\n---\n\n');
  return [
    'The following messages are from the compacted conversation. The user explicitly marked them as important and required in your context. Pay close attention to them; they may have been sent by either the user or you before compaction.',
    'Use them while continuing the pre-compaction work. Do not treat this context restoration as a new standalone task.',
    'If any tasks or next steps remain, do not acknowledge, summarize, or mention this restored context in a separate response. Simply continue the work and use it silently as background context. Do not append a recap of it after completing those tasks. Only if no tasks or next steps remain, give the user a very brief summary of the important restored context in no more than one short paragraph, without lists or a detailed recap.',
    '',
    timeline,
  ].join('\n');
};

export const createContextObligatoryRuntime = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  persistContextCursor = null,
  readSessionMetadata = null,
}: ContextObligatoryOptions) => {
  const inflight = new Set<string>();
  let stopped = false;

  const openCodeFetch = async (fetchPath: string, { directory, method = 'GET', body, query }: FetchOptions) => {
    const params = new URLSearchParams(query || {});
    if (directory) params.set('directory', directory);
    const search = params.toString();
    const url = `${buildOpenCodeUrl(fetchPath, '')}${search ? `?${search}` : ''}`;
    const headers = {
      Accept: 'application/json',
    };
    if (body) Object.assign(headers, { 'Content-Type': 'application/json' });
    Object.assign(headers, getOpenCodeAuthHeaders());
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    };
    if (body) init.body = JSON.stringify(body);
    const response = await fetch(url, init);
    if (method === 'POST' && fetchPath.endsWith('/synthetic')) {
      await assertPromptResponse(response, 'session.synthetic');
    } else if (!response.ok) {
      throw new Error(`OpenCode ${method} ${fetchPath} failed with ${response.status}`);
    }
    const value: unknown = unwrapOpenCodeResponse(await response.json().catch(() => null));
    return isMetadataRecord(value) ? value : null;
  };

  const tick = async (
    sessionId: string,
    directory: string,
    readSessionMetadata: NonNullable<ContextObligatoryOptions['readSessionMetadata']>,
    persistContextCursor: NonNullable<ContextObligatoryOptions['persistContextCursor']>,
  ) => {
    const session = await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}`, { directory });
    if (sessionParentId(session)) return;
    const stored = { metadata: await readSessionMetadata(sessionId) };
    const state = readContextState(stored);

    if (state.messages.length === 0) return;

    const recent = await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/message`, {
      directory,
      query: { limit: String(MESSAGE_FETCH_LIMIT) },
    });
    const recentMessages = isMetadataRecord(recent) && isUnknownArray(recent.data) ? recent.data : [];
    if (recentMessages.length === 0) return;
    const summary = recentMessages.find((message): message is BoundaryFields =>
      isMetadataRecord(message) && message.type === 'compaction' && message.status === 'completed');
    if (!summary?.id) return;
    if (state.openchamber.context_obligatory_last_compaction_message_id === summary.id) return;

    const fetched = await Promise.allSettled(state.messages.map(async (pinned) => {
      const message = await openCodeFetch(
        `/api/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(pinned.id)}`,
        { directory },
      );
      const parts = isMetadataRecord(message) && isUnknownArray(message.content)
        ? message.content
        : (hasMessageText(message) ? [{ type: 'text', text: message.text }] : []);
      const text = parts
        .filter(isTextPart)
        .map((part) => part.text.trim())
        .filter(Boolean)
        .join('\n\n');
      return { pinned, text };
    }));
    const entries = fetched
      .filter((result): result is PromiseFulfilledResult<ContextEntry> => result.status === 'fulfilled' && Boolean(result.value.text))
      .map((result) => result.value)
      .sort((left, right) => left.pinned.createdAt - right.pinned.createdAt);
    if (entries.length === 0) return;

    await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/synthetic`, {
      directory,
      method: 'POST',
      body: {
        text: buildContextPrompt(entries),
        resume: false,
      },
    });

    await persistContextCursor(sessionId, directory, {
      openchamber: { context_obligatory_last_compaction_message_id: summary.id },
    });
  };

  let parkedNoticeLogged = false;
  const processPayload = (payload: ContextObligatoryEvent | null | undefined, directoryHint = '') => {
    if (stopped) return;
    if (persistContextCursor === null || readSessionMetadata === null) {
      if (!parkedNoticeLogged) {
        parkedNoticeLogged = true;
        console.log('[context-obligatory] parked: no session metadata store is wired, so the compaction cursor cannot be saved');
      }
      return;
    }
    if (payload?.type !== 'session.compacted') return;
    const sessionId = payload.properties?.sessionID;
    if (!isSessionId(sessionId) || inflight.has(sessionId)) return;
    const directory = payload.properties?.directory || directoryHint;
    inflight.add(sessionId);
    return tick(sessionId, directory, readSessionMetadata, persistContextCursor)
      .catch((error) => console.warn('[context-obligatory] injection failed:', error?.message || error))
      .finally(() => inflight.delete(sessionId));
  };

  const stop = () => {
    stopped = true;
  };

  return { processPayload, stop };
};
