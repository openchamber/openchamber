import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { forgetOpenChamberInternalSession, internalSessionMetadata, trackOpenChamberInternalSession } from '../opencode/internal-sessions.js';

const CLEANUP_TIMEOUT_MS = 5_000;
const DISABLED_TOOLS = Object.fromEntries([
  'bash', 'edit', 'glob', 'grep', 'patch', 'question', 'read', 'skill',
  'task', 'todoread', 'todowrite', 'webfetch', 'write',
].map((tool) => [tool, false]));
let orphanCleanupNeeded = true;
let orphanCleanupCursor;
const activeSessionIds = new Set();

const isRecord = (value) => value !== null && Object.prototype.toString.call(value) === '[object Object]';

export const resetWalkthroughInferenceRuntime = () => {
  orphanCleanupNeeded = true;
  orphanCleanupCursor = undefined;
};

const normalizedOpenCodeError = (raw, operation, responseStatus) => {
  const name = raw?.name?.constructor === String ? raw.name : 'APIError';
  const data = isRecord(raw?.data) ? raw.data : {};
  const status = Number(data.statusCode ?? responseStatus) || undefined;
  const detail = data.message?.constructor === String
    ? data.message
    : (raw?.message?.constructor === String ? raw.message : `${operation} failed`);
  let code;
  if (name === 'MessageOutputLengthError') code = 'output-exhausted';
  else if (name === 'ContextOverflowError') code = 'context-too-small';
  else if (name === 'ProviderAuthError' || status === 401 || status === 403) code = 'no-provider-login';
  else if (name === 'StructuredOutputError') code = 'structured-output-unsupported';
  else if (
    name === 'APIError'
    && status != null && status >= 400 && status < 500
    && /json.?schema|structured.?output|response.?format|schema is not supported/i.test(`${detail}\n${data.responseBody ?? ''}`)
  ) code = 'structured-output-unsupported';
  const normalized = Object.assign(new Error(`${operation} failed${status ? ` (${status})` : ''}: ${detail}`), {
    name,
    status,
    statusCode: code === 'no-provider-login' ? 401 : (code ? undefined : 502),
  });
  if (code) normalized.code = code;
  if (code === 'structured-output-unsupported') normalized.schemaRefusal = true;
  return normalized;
};

const sdkError = (result, operation) => result?.error
  ? normalizedOpenCodeError(result.error, operation, result.response?.status)
  : null;

const requireData = (result, operation) => {
  const error = sdkError(result, operation);
  if (error) throw error;
  if (result?.data == null) throw new Error(`${operation} returned no data`);
  return result.data;
};

const eventProperties = (event) => event?.properties ?? event?.data;

const eventSessionId = (event, properties) => {
  const outerSessionId = properties?.sessionID;
  const nestedSessionId = event.type === 'message.updated'
    ? properties?.info?.sessionID
    : (event.type === 'message.part.updated' ? properties?.part?.sessionID : undefined);
  if (outerSessionId && nestedSessionId && outerSessionId !== nestedSessionId) return undefined;
  return nestedSessionId ?? outerSessionId;
};

const collectAssistantResult = async ({ stream, sessionId, promptMessageId }) => {
  const textParts = new Map();
  let assistantMessageId = '';
  let terminalAssistant = null;

  const textForAssistant = () => [...textParts.values()]
    .filter((part) => part.messageID === assistantMessageId)
    .map((part) => part.text)
    .join('\n')
    .trim();

  const completedResult = () => {
    if (!terminalAssistant) return null;
    if (terminalAssistant.error) {
      throw normalizedOpenCodeError(terminalAssistant.error, 'assistant message');
    }
    if (terminalAssistant.finish === 'length' || terminalAssistant.finish === 'max_tokens') {
      throw Object.assign(new Error('The model exhausted its output allowance'), { code: 'output-exhausted' });
    }
    if (terminalAssistant.structured != null) {
      return { text: JSON.stringify(terminalAssistant.structured) };
    }
    const text = textForAssistant();
    return text ? { text } : null;
  };

  for await (const event of stream) {
    const properties = eventProperties(event);
    if (eventSessionId(event, properties) !== sessionId) continue;

    if (event.type === 'message.part.updated') {
      const part = properties.part;
      if (part?.type !== 'text' || part.text?.constructor !== String) continue;
      textParts.set(part.id, part);
      const result = completedResult();
      if (result) return result;
      continue;
    }

    if (event.type === 'message.updated') {
      const info = properties.info;
      if (info?.role !== 'assistant' || info.parentID !== promptMessageId) continue;
      assistantMessageId = info.id;
      if (!info.time?.completed || !info.finish) continue;
      terminalAssistant = info;
      const result = completedResult();
      if (result) return result;
      continue;
    }

    if (event.type === 'session.error') {
      throw normalizedOpenCodeError(properties.error, 'session generation');
    }

    if (event.type === 'session.idle' && terminalAssistant) {
      throw new Error('OpenCode completed walkthrough inference without output');
    }
  }

  throw new Error('OpenCode event stream ended before walkthrough inference completed');
};

const cleanupOrphanedWalkthroughSessions = async (client) => {
  if (!orphanCleanupNeeded || !(client.experimental?.session?.list instanceof Function)) return;
  orphanCleanupNeeded = false;
  try {
    const listRequest = { archived: true, limit: 100 };
    if (orphanCleanupCursor !== undefined) listRequest.cursor = orphanCleanupCursor;
    const listed = await client.experimental.session.list(
      listRequest,
      { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) },
    );
    const error = sdkError(listed, 'experimental.session.list');
    if (error) throw error;
    const listedSessions = Array.isArray(listed.data) ? listed.data : [];
    const eligibleOrphans = listedSessions
      .filter((session) => session?.metadata?.openchamber?.internalSession?.kind === 'walkthrough-inference')
      .filter((session) => !activeSessionIds.has(session.id));
    const orphans = eligibleOrphans.slice(0, 20);
    const lastUpdated = listedSessions.at(-1)?.time?.updated;
    const pageHasUnprocessedOrphans = eligibleOrphans.length > orphans.length;
    if (!pageHasUnprocessedOrphans) {
      orphanCleanupCursor = listedSessions.length === 100 && Number.isFinite(lastUpdated) ? lastUpdated : undefined;
    }
    if (pageHasUnprocessedOrphans || orphanCleanupCursor !== undefined) orphanCleanupNeeded = true;
    for (let index = 0; index < orphans.length; index += 2) {
      await Promise.all(orphans.slice(index, index + 2).map(async (session) => {
        trackOpenChamberInternalSession(session.id);
        await client.session.abort(
          { sessionID: session.id, directory: session.directory },
          { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) },
        ).catch(() => {});
        const removed = await client.session.delete(
          { sessionID: session.id, directory: session.directory },
          { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) },
        );
        if (removed?.error && removed.response?.status !== 404) orphanCleanupNeeded = true;
        else forgetOpenChamberInternalSession(session.id);
      }));
    }
  } catch {
    orphanCleanupNeeded = true;
  }
};

export async function generateWalkthroughText({
  prompt, system, directory, model, responseSchema, timeoutMs, signal, baseUrl, headers,
  createClient = createOpencodeClient,
}) {
  if (!baseUrl) throw new Error('OpenCode API is unavailable');
  const client = createClient({ baseUrl: baseUrl.replace(/\/$/, ''), headers: headers ?? {} });
  await cleanupOrphanedWalkthroughSessions(client);
  const deadline = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const requestOptions = () => ({ signal: combinedSignal });
  const promptMessageId = `msg_${crypto.randomUUID().replaceAll('-', '')}`;
  let sessionId = '';
  let turnStarted = false;
  let completed = false;
  let streamController;
  let resultPromise;

  try {
    const session = requireData(await client.session.create({
      directory,
      title: 'Changes Walkthrough',
      metadata: internalSessionMetadata(),
      permission: [{ permission: '*', pattern: '*', action: 'deny' }],
    }, requestOptions()), 'session.create');
    sessionId = session.id;
    if (!sessionId) throw new Error('session.create returned an invalid session');
    trackOpenChamberInternalSession(sessionId);
    activeSessionIds.add(sessionId);

    streamController = new AbortController();
    const streamSignal = AbortSignal.any([combinedSignal, streamController.signal]);
    const subscription = await client.event.subscribe({ directory }, { signal: streamSignal });
    resultPromise = collectAssistantResult({
      stream: subscription.stream,
      sessionId,
      promptMessageId,
    });
    void resultPromise.catch(() => {});

    turnStarted = true;
    const promptResult = await client.session.promptAsync({
      sessionID: sessionId,
      directory,
      messageID: promptMessageId,
      model: { providerID: model.providerID, modelID: model.modelID },
      system,
      tools: DISABLED_TOOLS,
      ...(responseSchema ? { format: { type: 'json_schema', schema: responseSchema } } : { format: { type: 'text' } }),
      parts: [{ type: 'text', text: prompt }],
    }, requestOptions());
    const promptError = sdkError(promptResult, 'session.promptAsync');
    if (promptError) throw promptError;
    const result = await resultPromise;
    completed = true;
    return result;
  } catch (error) {
    streamController?.abort();
    if (sessionId && turnStarted && !completed) {
      await client.session.abort({ sessionID: sessionId, directory }, { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) }).catch(() => {});
    }
    await resultPromise?.catch(() => {});
    throw error;
  } finally {
    streamController?.abort();
    if (sessionId) {
      activeSessionIds.delete(sessionId);
      try {
        const removed = await client.session.delete(
          { sessionID: sessionId, directory },
          { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) },
        );
        if (removed?.error && removed.response?.status !== 404) orphanCleanupNeeded = true;
        else forgetOpenChamberInternalSession(sessionId);
      } catch {
        orphanCleanupNeeded = true;
      }
    }
  }
}

export const __testing = {
  normalizedOpenCodeError,
  collectAssistantResult,
  requireOrphanCleanup: resetWalkthroughInferenceRuntime,
  activeSessionIds,
};
